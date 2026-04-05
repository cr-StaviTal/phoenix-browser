import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from '../core/event-bus';
import { ChromeStorage } from '../core/storage';
import { PhoenixRule } from '../types/rules';
import { EventTypes, RuleMatchedPayload } from '../types/events';
import { PolicyEngine } from './policy-engine';
import {
  RULES_STORAGE_KEY,
  RULES_REFRESH_INTERVAL_MS,
  DEFAULT_EDR_ENDPOINT,
  ALARM_NAMES,
} from '../core/constants';

export class RuleEngine implements PhoenixModule {
  readonly id = 'rule-engine';
  readonly version = '1.0.0';

  private bus: EventBus | null = null;
  private storage = new ChromeStorage();
  private rules: PhoenixRule[] = [];
  private policyEngine: PolicyEngine | null = null;
  private enabled = false;
  private lastActivity = 0;
  private eventCount = 0;
  private matchCount = 0;
  private lastSyncTime = 0;
  private errors: string[] = [];
  private alarmListener: ((alarm: chrome.alarms.Alarm) => void) | null = null;
  private messageListener: ((
    message: { type: string; [key: string]: unknown },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => boolean | void) | null = null;
  private unsubscribePolicyLoaded: (() => void) | null = null;

  /** Inject PolicyEngine for endpoint access. */
  setPolicyEngine(engine: PolicyEngine): void {
    this.policyEngine = engine;
  }

  register(bus: EventBus): void {
    this.bus = bus;
    this.enabled = true;

    // Load cached rules, then fetch fresh
    this.loadCachedRules()
      .then(() => this.fetchRules())
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Initial rules load failed: ${msg}`);
      });

    // Set up periodic refresh alarm
    chrome.alarms.create(ALARM_NAMES.RULES_REFRESH, {
      periodInMinutes: RULES_REFRESH_INTERVAL_MS / 60_000,
    });

    this.alarmListener = (alarm) => {
      if (alarm.name === ALARM_NAMES.RULES_REFRESH) {
        this.fetchRules().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.errors.push(`Rules refresh failed: ${msg}`);
        });
      }
    };
    chrome.alarms.onAlarm.addListener(this.alarmListener);

    // Subscribe to POLICY_LOADED to trigger rules refresh
    this.unsubscribePolicyLoaded = bus.subscribe(EventTypes.POLICY_LOADED, () => {
      this.fetchRules().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Rules refresh after policy load failed: ${msg}`);
      });
    });

    // Listen for messages from content scripts
    this.messageListener = (message, sender, sendResponse) => {
      if (!message.type || !message.type.startsWith('rules:')) return false;

      this.handleContentMessage(message, sender)
        .then((response) => sendResponse(response))
        .catch((err) => {
          console.error('[RuleEngine] Message handler error:', err);
          sendResponse({ rules: [] });
        });

      return true; // Keep channel open for async response
    };
    chrome.runtime.onMessage.addListener(this.messageListener);
  }

  destroy(): void {
    this.enabled = false;
    if (this.alarmListener) {
      chrome.alarms.onAlarm.removeListener(this.alarmListener);
      this.alarmListener = null;
    }
    if (this.messageListener) {
      chrome.runtime.onMessage.removeListener(this.messageListener);
      this.messageListener = null;
    }
    if (this.unsubscribePolicyLoaded) {
      this.unsubscribePolicyLoaded();
      this.unsubscribePolicyLoaded = null;
    }
    chrome.alarms.clear(ALARM_NAMES.RULES_REFRESH);
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

  /** Extended status for debugging. */
  getExtendedStatus(): {
    ruleCount: number;
    cachedRulesCount: number;
    lastSyncTime: number;
    matchCount: number;
  } {
    return {
      ruleCount: this.rules.filter((r) => r.enabled).length,
      cachedRulesCount: this.rules.length,
      lastSyncTime: this.lastSyncTime,
      matchCount: this.matchCount,
    };
  }

  /** Get rules matching a specific URL. */
  getRulesForUrl(url: string): PhoenixRule[] {
    let hostname: string;
    let fullUrl: string;
    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
      fullUrl = parsed.href;
    } catch {
      return [];
    }

    return this.rules
      .filter((rule) => {
        if (!rule.enabled) return false;

        // Check exclude_domains first
        if (rule.match.exclude_domains && rule.match.exclude_domains.length > 0) {
          for (const pattern of rule.match.exclude_domains) {
            if (this.matchDomain(hostname, pattern)) return false;
          }
        }

        // If domains specified, at least one must match
        if (rule.match.domains && rule.match.domains.length > 0) {
          const domainMatch = rule.match.domains.some((pattern) =>
            this.matchDomain(hostname, pattern),
          );
          if (!domainMatch) return false;
        }

        // If url_patterns specified, at least one must match
        if (rule.match.url_patterns && rule.match.url_patterns.length > 0) {
          const patternMatch = rule.match.url_patterns.some((pattern) =>
            this.matchUrlPattern(fullUrl, pattern),
          );
          if (!patternMatch) return false;
        }

        // If url_regex specified, at least one must match
        if (rule.match.url_regex && rule.match.url_regex.length > 0) {
          const regexMatch = rule.match.url_regex.some((pattern) => {
            try {
              return new RegExp(pattern).test(fullUrl);
            } catch {
              return false;
            }
          });
          if (!regexMatch) return false;
        }

        return true;
      })
      .sort((a, b) => b.priority - a.priority);
  }

  // ---- Private methods ----

  private async loadCachedRules(): Promise<void> {
    const cached = await this.storage.get<PhoenixRule[]>(RULES_STORAGE_KEY);
    if (cached && Array.isArray(cached)) {
      this.rules = cached;
      this.lastActivity = Date.now();
    }
  }

  private async fetchRules(): Promise<void> {
    const endpoint = this.getEndpoint();
    const rulesUrl = `${endpoint}/rules?enabled=true`;

    try {
      const response = await fetch(rulesUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const freshRules: PhoenixRule[] = Array.isArray(data) ? data : (data.rules ?? []);
      this.rules = freshRules;
      this.lastActivity = Date.now();
      this.lastSyncTime = Date.now();

      // Cache to storage
      await this.storage.set(RULES_STORAGE_KEY, freshRules);

      // Notify all tabs to re-initialize rules (hot reload)
      try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (tab.id && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
            chrome.tabs.sendMessage(tab.id, { type: 'rules:refresh' }).catch(() => { /* tab may not have content script */ });
          }
        }
      } catch { /* ignore */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Fetch rules failed: ${msg}`);
    }
  }

  private async handleContentMessage(
    message: { type: string; [key: string]: unknown },
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> {
    const tabId = sender.tab?.id ?? -1;

    switch (message.type) {
      case 'rules:get': {
        const url = message.url as string;
        if (!url) return { rules: [] };
        const matchingRules = this.getRulesForUrl(url);
        return { rules: matchingRules };
      }

      case 'rules:matched': {
        this.matchCount++;
        this.eventCount++;
        this.lastActivity = Date.now();

        const rule = message.rule as {
          id: string;
          name: string;
          severity: string;
          trigger: string;
        };
        const action = message.action as { type: string; params: Record<string, string | number | boolean> };
        const url = (message.url as string) || sender.tab?.url || '';
        const userInput = (message.userInput as string) || '';

        // Execute service-worker-side actions
        if (action && action.type === 'redirect' && action.params.url) {
          if (tabId !== -1) {
            chrome.tabs.update(tabId, { url: String(action.params.url) });
          }
        } else if (action && action.type === 'close_tab') {
          if (tabId !== -1) {
            chrome.tabs.remove(tabId);
          }
        } else if (action && action.type === 'notify') {
          chrome.notifications.create(`phoenix-rule-${rule.id}-${Date.now()}`, {
            type: 'basic',
            iconUrl: 'assets/icons/icon-48.png',
            title: `Phoenix Shield: ${rule.name}`,
            message: String(action.params.message || `Rule "${rule.name}" triggered`),
          });
        }

        // Publish RULE_MATCHED event
        if (this.bus) {
          const payload: RuleMatchedPayload = {
            ruleId: rule.id,
            ruleName: rule.name,
            url,
            tabId,
            trigger: rule.trigger,
            actionsExecuted: [action?.type || 'unknown'],
            severity: rule.severity,
          };
          this.bus.publish(
            EventBus.createEvent(
              EventTypes.RULE_MATCHED,
              this.id,
              payload,
              rule.severity === 'critical' ? 'critical' :
              rule.severity === 'high' ? 'high' :
              rule.severity === 'medium' ? 'medium' :
              rule.severity === 'low' ? 'low' : 'info',
            ),
          );
        }

        // Report to backend API so alerts are generated on the dashboard
        try {
          const endpoint = this.getEndpoint();
          const eventId = `rule-${rule.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const severity = rule.severity === 'critical' ? 'critical' :
            rule.severity === 'high' ? 'high' :
            rule.severity === 'medium' ? 'medium' : 'low';
          fetch(`${endpoint}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              extension_id: 'phoenix-browser-extension',
              extension_version: '1.0.0',
              machine_id: 'browser',
              timestamp: Date.now(),
              events: [{
                id: eventId,
                type: 'rule_matched',
                timestamp: Date.now(),
                severity,
                source: 'rule-engine',
                payload: {
                  rule_id: rule.id,
                  rule_name: rule.name,
                  rule_severity: rule.severity,
                  trigger: rule.trigger,
                  action: action?.type || 'matched',
                  url,
                  user_input: userInput,
                  message: `Rule "${rule.name}" triggered on ${url}`,
                },
              }],
            }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => { /* fire and forget */ });
        } catch {
          // Non-critical: don't break rule processing if API call fails
        }

        return { ok: true };
      }

      case 'rules:extract': {
        this.eventCount++;
        this.lastActivity = Date.now();

        // Publish RULE_ACTION_EXECUTED event with extracted data
        if (this.bus) {
          this.bus.publish(
            EventBus.createEvent(
              EventTypes.RULE_ACTION_EXECUTED,
              this.id,
              {
                ruleId: message.ruleId,
                ruleName: message.ruleName,
                url: message.url || sender.tab?.url || '',
                tabId,
                data: message.data,
              },
              'info',
            ),
          );
        }

        return { ok: true };
      }

      default:
        return { ok: false, error: 'Unknown rules message type' };
    }
  }

  /** Match a hostname against a domain pattern supporting * wildcards. */
  private matchDomain(hostname: string, pattern: string): boolean {
    // Convert glob pattern to regex: *.example.com -> .*\.example\.com
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '.*');
    try {
      return new RegExp(`^${escaped}$`, 'i').test(hostname);
    } catch {
      return false;
    }
  }

  /** Match a full URL against a pattern supporting * wildcards. */
  private matchUrlPattern(url: string, pattern: string): boolean {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '.*');
    try {
      return new RegExp(`^${escaped}$`, 'i').test(url);
    } catch {
      return false;
    }
  }

  private getEndpoint(): string {
    return this.policyEngine?.getPolicy()?.edr_reporter?.endpoint ?? DEFAULT_EDR_ENDPOINT;
  }
}
