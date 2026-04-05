import { EventBus } from '../core/event-bus';
import { ModuleRegistry } from '../core/module-registry';
import { EXTENSION_VERSION } from '../core/constants';

// Module imports
import { PolicyEngine } from '../modules/policy-engine';
import { ForensicLogger } from '../modules/forensic-logger';
import { UrlMonitor } from '../modules/url-monitor';
import { ThreatDetection } from '../modules/threat-detection';
import { ExtensionMonitor } from '../modules/extension-monitor';
import { DlpEngine } from '../modules/dlp-engine';
import { IdentityProtection } from '../modules/identity-protection';
import { EdrReporter } from '../modules/edr-reporter';
import { GovernanceEngine } from '../modules/governance-engine';
import { RuleEngine } from '../modules/rule-engine';

import { MessageRouter } from './message-router';
import {
  ContentMessage,
  StatusResponse,
} from '../types/messages';
import { LogsResponse } from './message-router';

// ---- Singleton instances ----

let bus: EventBus;
let registry: ModuleRegistry;
let router: MessageRouter;

// ---- Keep-alive alarm ----

const KEEP_ALIVE_ALARM = 'phoenix-keep-alive';

// ---- Bootstrap ----

async function init(): Promise<void> {
  // 1. Create core infrastructure
  bus = new EventBus();
  registry = new ModuleRegistry(bus);

  // 2. Create module instances
  const policyEngine = new PolicyEngine();
  const forensicLogger = new ForensicLogger();
  const urlMonitor = new UrlMonitor();
  const threatDetection = new ThreatDetection();
  const extensionMonitor = new ExtensionMonitor();
  const dlpEngine = new DlpEngine();
  const identityProtection = new IdentityProtection();
  const governanceEngine = new GovernanceEngine();
  const ruleEngine = new RuleEngine();
  const edrReporter = new EdrReporter();

  // 3. Wire up inter-module dependencies
  forensicLogger.setPolicyEngine(policyEngine);
  extensionMonitor.setPolicyEngine(policyEngine);
  governanceEngine.setPolicyEngine(policyEngine);
  ruleEngine.setPolicyEngine(policyEngine);
  edrReporter.setPolicyEngine(policyEngine);

  // 4. Register modules in dependency order
  registry.register(policyEngine);         // First - others depend on policy
  registry.register(forensicLogger);       // Logs all events
  registry.register(urlMonitor);           // Watches navigations
  registry.register(threatDetection);      // Reacts to URL monitor events
  registry.register(extensionMonitor);     // Watches extension lifecycle
  registry.register(dlpEngine);            // Data loss prevention
  registry.register(identityProtection);   // Cookie/session monitoring
  registry.register(governanceEngine);     // Browser governance (copy/paste, downloads)
  registry.register(ruleEngine);           // Dynamic rule engine
  registry.register(edrReporter);          // Last - reports everything to EDR agent

  // 5. Initialize all modules
  await registry.initAll();

  // 6. Create message router
  router = new MessageRouter(registry, bus);

  console.log(
    `[Phoenix Shield] Initialized with ${registry.size} modules (v${EXTENSION_VERSION})`,
  );
}

// ---- Lifecycle events ----

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[Phoenix Shield] Installed (reason: ${details.reason})`);

  init().catch((err) => {
    console.error('[Phoenix Shield] Initialization failed:', err);
  });

  // Set up keep-alive alarm (fires every 25 seconds to stay within the
  // 30-second MV3 service worker idle timeout)
  chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 25 / 60 });
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[Phoenix Shield] Service worker started');

  init().catch((err) => {
    console.error('[Phoenix Shield] Re-initialization failed:', err);
  });

  chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 25 / 60 });
});

// ---- Keep-alive handler ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEP_ALIVE_ALARM) {
    // No-op: the alarm firing is enough to keep the service worker alive.
    // Optionally log at debug level.
  }
});

// ---- Message routing ----

chrome.runtime.onMessage.addListener(
  (
    message: ContentMessage | { type: string; [key: string]: unknown },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: StatusResponse | LogsResponse | unknown) => void,
  ) => {
    // Guard: if router is not yet initialized, return a safe default
    if (!router) {
      if (message.type === 'get-status') {
        sendResponse({
          modules: [],
          totalEvents24h: 0,
          openAlerts: 0,
          policyVersion: 'unknown',
          agentConnected: false,
        } satisfies StatusResponse);
      } else {
        sendResponse({ action: 'allow' });
      }
      return false;
    }

    // Route asynchronously, keeping the message channel open
    router
      .handleMessage(message, sender)
      .then((response) => {
        sendResponse(response ?? { action: 'allow' });
      })
      .catch((err) => {
        console.error('[Phoenix Shield] Message handler error:', err);
        sendResponse({ action: 'allow' });
      });

    return true; // Keep sendResponse channel open for async
  },
);

// ---- Exports for testing ----

export { bus, registry, router };
