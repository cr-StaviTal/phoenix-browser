import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from '../core/event-bus';
import {
  EventTypes,
  NavigationPayload,
  ThreatPayload,
  PolicyPayload,
} from '../types/events';
import { ThreatDetectionPolicy } from '../types/policy';

interface ThreatMatch {
  url: string;
  matchedRule: string;
  matchType: 'exact' | 'domain' | 'pattern';
}

interface BlocklistSet {
  urls: Set<string>;
  domains: Set<string>;
  patterns: string[];
}

const DEFAULT_BLOCKED_DOMAINS = [
  'evil-phishing.example.com',
  'malware-download.example.net',
  'fake-login.example.org',
];

/** Convert a simple glob pattern (with * wildcards) to a RegExp. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Extract the hostname from a URL string, returning null on failure. */
function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export class ThreatDetection implements PhoenixModule {
  readonly id = 'threat-detection';
  readonly version = '1.0.0';

  private bus: EventBus | null = null;
  private enabled = false;
  private lastActivity = 0;
  private eventCount = 0;
  private errors: string[] = [];
  private unsubscribes: Array<() => void> = [];
  private beforeNavigateListener: ((details: chrome.webNavigation.WebNavigationParentedCallbackDetails) => void) | null = null;

  private blocklist: BlocklistSet = {
    urls: new Set(),
    domains: new Set(DEFAULT_BLOCKED_DOMAINS),
    patterns: [],
  };

  register(bus: EventBus): void {
    this.bus = bus;
    this.enabled = true;

    // React to every navigation the URL Monitor reports (secondary check)
    const unsubNav = bus.subscribe<NavigationPayload>(
      EventTypes.NAVIGATION_VISITED,
      (event) => this.onNavigation(event.payload),
    );
    this.unsubscribes.push(unsubNav);

    // Update blocklists when a fresh policy arrives
    const unsubPolicy = bus.subscribe<PolicyPayload>(
      EventTypes.POLICY_LOADED,
      () => this.onPolicyLoaded(),
    );
    this.unsubscribes.push(unsubPolicy);

    // PRIMARY: intercept navigation BEFORE the page loads
    this.beforeNavigateListener = (details) => {
      if (details.frameId !== 0) return; // only main frame
      const match = this.check(details.url);
      if (!match) return;

      this.lastActivity = Date.now();
      this.eventCount++;

      const threatPayload: ThreatPayload = {
        url: details.url,
        threatType: 'blocklisted',
        listSource: match.matchType,
        action: 'blocked',
        tabId: details.tabId,
        matchedRule: match.matchedRule,
      };

      this.bus!.publish(
        EventBus.createEvent(EventTypes.THREAT_DETECTED, this.id, threatPayload, 'high'),
      );
      this.bus!.publish(
        EventBus.createEvent(EventTypes.THREAT_BLOCKED, this.id, threatPayload, 'high'),
      );

      // Redirect to block page before the page loads
      const blockUrl =
        chrome.runtime.getURL('blocked/blocked.html') +
        '?url=' +
        encodeURIComponent(details.url) +
        '&rule=' +
        encodeURIComponent(match.matchedRule);
      chrome.tabs.update(details.tabId, { url: blockUrl });

      this.addBlockingRule(details.url);
      this.showNotification(details.url, match.matchedRule);
    };
    chrome.webNavigation.onBeforeNavigate.addListener(this.beforeNavigateListener);

    // SECONDARY: add declarativeNetRequest rules for all blocked domains
    // (MV3 does not support blocking webRequest - use declarativeNetRequest instead)
    this.addBlockingRulesForAllDomains();
  }

  destroy(): void {
    this.enabled = false;
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
    if (this.beforeNavigateListener) {
      chrome.webNavigation.onBeforeNavigate.removeListener(this.beforeNavigateListener);
      this.beforeNavigateListener = null;
    }
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

  // ---- Public API ----

  /** Check a URL against all blocklists. Returns the first match or null. */
  check(url: string): ThreatMatch | null {
    // 1. Exact URL match
    if (this.blocklist.urls.has(url)) {
      return { url, matchedRule: url, matchType: 'exact' };
    }

    // 2. Domain match
    const domain = extractDomain(url);
    if (domain && this.blocklist.domains.has(domain)) {
      return { url, matchedRule: domain, matchType: 'domain' };
    }

    // 3. Pattern (glob) match
    for (const pattern of this.blocklist.patterns) {
      const re = globToRegex(pattern);
      if (re.test(url)) {
        return { url, matchedRule: pattern, matchType: 'pattern' };
      }
    }

    return null;
  }

  // ---- Private ----

  private onNavigation(nav: NavigationPayload): void {
    const match = this.check(nav.url);
    if (!match) return;

    this.lastActivity = Date.now();
    this.eventCount++;

    const threatPayload: ThreatPayload = {
      url: nav.url,
      threatType: 'blocklisted',
      listSource: match.matchType,
      action: 'blocked',
      tabId: nav.tabId,
      matchedRule: match.matchedRule,
    };

    // Publish detection event
    this.bus!.publish(
      EventBus.createEvent(EventTypes.THREAT_DETECTED, this.id, threatPayload, 'high'),
    );

    // Publish blocked event
    this.bus!.publish(
      EventBus.createEvent(EventTypes.THREAT_BLOCKED, this.id, threatPayload, 'high'),
    );

    // Block future requests to this domain via declarativeNetRequest
    this.addBlockingRule(nav.url);

    // Notify the user
    this.showNotification(nav.url, match.matchedRule);
  }

  private addBlockingRule(url: string): void {
    const domain = extractDomain(url);
    if (!domain) return;

    const ruleId = this.domainToRuleId(domain);

    try {
      chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [
          {
            id: ruleId,
            priority: 1,
            action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
            condition: {
              urlFilter: `||${domain}`,
              resourceTypes: [
                chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
                chrome.declarativeNetRequest.ResourceType.SCRIPT,
                chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
                chrome.declarativeNetRequest.ResourceType.IMAGE,
              ],
            },
          },
        ],
        removeRuleIds: [ruleId],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Failed to add blocking rule: ${msg}`);
    }
  }

  /** Hash a string to a stable positive integer for use as a rule ID. */
  private domainToRuleId(domain: string): number {
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
      hash = ((hash << 5) - hash + domain.charCodeAt(i)) | 0;
    }
    return (hash >>> 0) % 900_000 + 100_000; // range 100000-999999
  }

  /**
   * Pre-register declarativeNetRequest blocking rules for sub-frames only.
   * Main frame blocking is handled by onBeforeNavigate which redirects to our block page.
   * Sub-frames are silently blocked since we can't redirect individual frames.
   */
  private async addBlockingRulesForAllDomains(): Promise<void> {
    try {
      const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
      const existingIds = existingRules.map(r => r.id);

      const rules: chrome.declarativeNetRequest.Rule[] = [];
      const usedIds = new Set<number>();

      for (const domain of this.blocklist.domains) {
        let ruleId = this.domainToRuleId(domain);
        while (usedIds.has(ruleId)) ruleId++;
        usedIds.add(ruleId);

        rules.push({
          id: ruleId,
          priority: 1,
          action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
          condition: {
            urlFilter: `||${domain}`,
            resourceTypes: [
              chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
              chrome.declarativeNetRequest.ResourceType.SCRIPT,
              chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
              chrome.declarativeNetRequest.ResourceType.IMAGE,
            ],
          },
        });
      }

      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: rules,
        removeRuleIds: existingIds,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Failed to add bulk blocking rules: ${msg}`);
    }
  }

  private showNotification(url: string, rule: string): void {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Phoenix Shield - Threat Blocked',
        message: `Access to ${url} was blocked.\nMatched rule: ${rule}`,
        priority: 2,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Notification failed: ${msg}`);
    }
  }

  /**
   * Reload blocklist entries from the latest policy.
   * We cannot import PolicyEngine directly (circular), so we read from
   * chrome.storage where PolicyEngine persists the policy.
   */
  private async onPolicyLoaded(): Promise<void> {
    try {
      const result = await chrome.storage.local.get('phoenix_policy');
      const policy = result['phoenix_policy'] as
        | { threat_detection?: ThreatDetectionPolicy }
        | undefined;

      if (!policy?.threat_detection) return;

      const td = policy.threat_detection;

      // Merge policy lists with defaults (defaults are always present)
      this.blocklist.urls = new Set(td.blocked_urls ?? []);
      this.blocklist.domains = new Set([
        ...DEFAULT_BLOCKED_DOMAINS,
        ...(td.blocked_domains ?? []),
      ]);
      this.blocklist.patterns = td.blocked_patterns ?? [];

      this.lastActivity = Date.now();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Policy reload failed: ${msg}`);
    }
  }
}
