import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from '../core/event-bus';
import { EventTypes, ExtensionPayload } from '../types/events';
import { ALARM_NAMES, EXTENSION_SCAN_INTERVAL_MS, EXTENSION_ID } from '../core/constants';
import { PolicyEngine } from './policy-engine';

/** Permission risk weights for calculating extension risk scores. */
const PERMISSION_WEIGHTS: Record<string, number> = {
  '<all_urls>': 40,
  'nativeMessaging': 35,
  'webRequest': 30,
  'cookies': 25,
  'history': 15,
  'tabs': 10,
  'bookmarks': 5,
  'storage': 5,
};

/** Calculate a 0-100 risk score based on an extension's permissions. */
function calculateRiskScore(permissions: string[]): number {
  let score = 0;
  for (const perm of permissions) {
    score += PERMISSION_WEIGHTS[perm] ?? 0;
  }
  return Math.min(score, 100);
}

export class ExtensionMonitor implements PhoenixModule {
  readonly id = 'extension-monitor';
  readonly version = '1.0.0';

  private bus: EventBus | null = null;
  private enabled = false;
  private lastActivity = 0;
  private eventCount = 0;
  private errors: string[] = [];
  private policyEngine: PolicyEngine | null = null;

  private onInstalledListener: ((info: chrome.management.ExtensionInfo) => void) | null = null;
  private onUninstalledListener: ((id: string) => void) | null = null;
  private onEnabledListener: ((info: chrome.management.ExtensionInfo) => void) | null = null;
  private onDisabledListener: ((info: chrome.management.ExtensionInfo) => void) | null = null;
  private alarmListener: ((alarm: chrome.alarms.Alarm) => void) | null = null;

  /** Optionally inject PolicyEngine for blocked_extensions list. */
  setPolicyEngine(engine: PolicyEngine): void {
    this.policyEngine = engine;
  }

  register(bus: EventBus): void {
    this.bus = bus;
    this.enabled = true;

    // Extension lifecycle listeners
    this.onInstalledListener = (info) => {
      this.handleExtensionEvent(info, 'installed', EventTypes.EXT_INSTALLED);
    };
    this.onUninstalledListener = (id) => {
      this.handleUninstalled(id);
    };
    this.onEnabledListener = (info) => {
      this.handleExtensionEvent(info, 'enabled', EventTypes.EXT_ENABLED);
    };
    this.onDisabledListener = (info) => {
      this.handleExtensionEvent(info, 'disabled', EventTypes.EXT_DISABLED);
    };

    chrome.management.onInstalled.addListener(this.onInstalledListener);
    chrome.management.onUninstalled.addListener(this.onUninstalledListener);
    chrome.management.onEnabled.addListener(this.onEnabledListener);
    chrome.management.onDisabled.addListener(this.onDisabledListener);

    // Periodic full scan
    chrome.alarms.create(ALARM_NAMES.EXTENSION_SCAN, {
      periodInMinutes: EXTENSION_SCAN_INTERVAL_MS / 60_000,
    });

    this.alarmListener = (alarm) => {
      if (alarm.name === ALARM_NAMES.EXTENSION_SCAN) {
        this.performFullScan().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.errors.push(`Full scan failed: ${msg}`);
        });
      }
    };
    chrome.alarms.onAlarm.addListener(this.alarmListener);

    // Run initial scan
    this.performFullScan().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Initial scan failed: ${msg}`);
    });
  }

  destroy(): void {
    this.enabled = false;
    if (this.onInstalledListener) {
      chrome.management.onInstalled.removeListener(this.onInstalledListener);
      this.onInstalledListener = null;
    }
    if (this.onUninstalledListener) {
      chrome.management.onUninstalled.removeListener(this.onUninstalledListener);
      this.onUninstalledListener = null;
    }
    if (this.onEnabledListener) {
      chrome.management.onEnabled.removeListener(this.onEnabledListener);
      this.onEnabledListener = null;
    }
    if (this.onDisabledListener) {
      chrome.management.onDisabled.removeListener(this.onDisabledListener);
      this.onDisabledListener = null;
    }
    if (this.alarmListener) {
      chrome.alarms.onAlarm.removeListener(this.alarmListener);
      this.alarmListener = null;
    }
    chrome.alarms.clear(ALARM_NAMES.EXTENSION_SCAN);
    this.bus = null;
  }

  getStatus(): ModuleStatus {
    return {
      id: this.id,
      enabled: this.enabled,
      lastActivity: this.lastActivity,
      eventCount: this.eventCount,
      errors: this.errors.slice(-10),
    };
  }

  private handleExtensionEvent(
    info: chrome.management.ExtensionInfo,
    action: ExtensionPayload['action'],
    eventType: string
  ): void {
    if (!this.bus) return;

    // Skip our own extension
    if (info.id === chrome.runtime.id) return;

    const permissions = [
      ...(info.permissions || []),
      ...(info.hostPermissions || []),
    ];
    const riskScore = calculateRiskScore(permissions);

    const payload: ExtensionPayload = {
      extensionId: info.id,
      name: info.name,
      action,
      permissions,
      riskScore,
    };

    const severity = riskScore >= 70 ? 'high' : riskScore >= 40 ? 'medium' : 'info';

    this.bus.publish(EventBus.createEvent(eventType, this.id, payload, severity));
    this.eventCount++;
    this.lastActivity = Date.now();

    // Check if blocked by policy
    this.checkBlockedExtension(info, riskScore);
  }

  private handleUninstalled(extensionId: string): void {
    if (!this.bus) return;
    if (extensionId === chrome.runtime.id) return;

    const payload: ExtensionPayload = {
      extensionId,
      name: 'unknown',
      action: 'uninstalled',
      permissions: [],
      riskScore: 0,
    };

    this.bus.publish(
      EventBus.createEvent(EventTypes.EXT_UNINSTALLED, this.id, payload, 'info')
    );
    this.eventCount++;
    this.lastActivity = Date.now();
  }

  private async performFullScan(): Promise<void> {
    const extensions = await this.getAllExtensions();

    for (const ext of extensions) {
      // Skip our own extension and themes
      if (ext.id === chrome.runtime.id) continue;
      if (ext.type !== 'extension') continue;

      const permissions = [
        ...(ext.permissions || []),
        ...(ext.hostPermissions || []),
      ];
      const riskScore = calculateRiskScore(permissions);

      this.checkBlockedExtension(ext, riskScore);
    }

    this.lastActivity = Date.now();
  }

  private checkBlockedExtension(
    info: chrome.management.ExtensionInfo,
    riskScore: number
  ): void {
    const policy = this.policyEngine?.getPolicy();
    if (!policy?.extension_monitor?.enabled) return;

    const isBlocked = policy.extension_monitor.blocked_extensions.includes(info.id);
    const exceedsRisk = riskScore > policy.extension_monitor.max_permissions_risk_score;

    if ((isBlocked || exceedsRisk) && policy.extension_monitor.auto_disable_risky && info.enabled) {
      chrome.management.setEnabled(info.id, false, () => {
        if (chrome.runtime.lastError) {
          this.errors.push(
            `Failed to disable ${info.name}: ${chrome.runtime.lastError.message}`
          );
        } else {
          console.log(
            `[ExtensionMonitor] Auto-disabled risky extension: ${info.name} (risk=${riskScore})`
          );
        }
      });
    }
  }

  private getAllExtensions(): Promise<chrome.management.ExtensionInfo[]> {
    return new Promise((resolve) => {
      chrome.management.getAll((extensions) => {
        resolve(extensions || []);
      });
    });
  }
}
