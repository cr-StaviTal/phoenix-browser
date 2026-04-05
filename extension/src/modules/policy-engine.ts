import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from '../core/event-bus';
import { ChromeStorage } from '../core/storage';
import { PolicyConfig } from '../types/policy';
import { EventTypes, PolicyPayload } from '../types/events';
import {
  POLICY_STORAGE_KEY,
  POLICY_REFRESH_INTERVAL_MS,
  DEFAULT_EDR_ENDPOINT,
  ALARM_NAMES,
} from '../core/constants';

const DEFAULT_POLICY: PolicyConfig = {
  version: '0.0.0',
  updated_at: new Date().toISOString(),
  threat_detection: {
    enabled: true,
    blocked_urls: [],
    blocked_domains: [],
    blocked_patterns: [],
    action: 'block',
  },
  dlp: {
    enabled: true,
    file_upload: {
      blocked_extensions: ['.exe', '.bat', '.cmd', '.scr'],
      max_file_size_mb: 50,
      blocked_domains: [],
    },
    clipboard: {
      monitor_paste: true,
      monitor_copy: false,
    },
    sensitive_patterns: {
      ssn: true,
      credit_card: true,
      email: false,
      custom_patterns: [],
    },
  },
  extension_monitor: {
    enabled: true,
    blocked_extensions: [],
    max_permissions_risk_score: 70,
    auto_disable_risky: false,
  },
  identity_protection: {
    enabled: true,
    monitored_domains: [],
    alert_on_session_cookie_removal: true,
  },
  forensic_logger: {
    enabled: true,
    retention_days: 7,
    max_storage_mb: 80,
  },
  governance: {
    copy_paste_restrictions: [],
    download_restrictions: {
      blocked_extensions: [],
      require_scan: false,
    },
  },
  edr_reporter: {
    endpoint: DEFAULT_EDR_ENDPOINT,
    batch_interval_seconds: 30,
    max_batch_size: 500,
    retry_attempts: 3,
    retry_backoff_ms: 1000,
  },
};

export class PolicyEngine implements PhoenixModule {
  readonly id = 'policy-engine';
  readonly version = '1.0.0';

  private bus: EventBus | null = null;
  private storage = new ChromeStorage();
  private policy: PolicyConfig = { ...DEFAULT_POLICY };
  private enabled = false;
  private lastActivity = 0;
  private eventCount = 0;
  private errors: string[] = [];
  private alarmListener: ((alarm: chrome.alarms.Alarm) => void) | null = null;

  register(bus: EventBus): void {
    this.bus = bus;
    this.enabled = true;

    // Load cached policy first, then fetch fresh from EDR
    this.loadCachedPolicy()
      .then(() => this.fetchPolicyFromAgent())
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Initial policy load failed: ${msg}`);
      });

    // Set up periodic refresh alarm
    chrome.alarms.create(ALARM_NAMES.POLICY_REFRESH, {
      periodInMinutes: POLICY_REFRESH_INTERVAL_MS / 60_000,
    });

    this.alarmListener = (alarm) => {
      if (alarm.name === ALARM_NAMES.POLICY_REFRESH) {
        this.fetchPolicyFromAgent().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.errors.push(`Policy refresh failed: ${msg}`);
        });
      }
    };
    chrome.alarms.onAlarm.addListener(this.alarmListener);
  }

  destroy(): void {
    this.enabled = false;
    if (this.alarmListener) {
      chrome.alarms.onAlarm.removeListener(this.alarmListener);
      this.alarmListener = null;
    }
    chrome.alarms.clear(ALARM_NAMES.POLICY_REFRESH);
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

  /** Returns the current active policy. */
  getPolicy(): PolicyConfig {
    return this.policy;
  }

  private async loadCachedPolicy(): Promise<void> {
    const cached = await this.storage.get<PolicyConfig>(POLICY_STORAGE_KEY);
    if (cached) {
      this.policy = cached;
      this.lastActivity = Date.now();
      this.publishPolicyLoaded();
    }
  }

  private async fetchPolicyFromAgent(): Promise<void> {
    const endpoint = this.policy.edr_reporter?.endpoint || DEFAULT_EDR_ENDPOINT;
    const policyUrl = `${endpoint}/policy`;

    try {
      const response = await fetch(policyUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const freshPolicy = (await response.json()) as PolicyConfig;
      this.policy = freshPolicy;
      this.lastActivity = Date.now();

      // Cache to storage
      await this.storage.set(POLICY_STORAGE_KEY, freshPolicy);
      this.publishPolicyLoaded();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Fetch policy failed: ${msg}`);
      this.publishPolicyUpdateFailed(msg);

      // Fall back to default if nothing loaded yet
      if (this.policy.version === '0.0.0') {
        this.policy = { ...DEFAULT_POLICY };
      }
    }
  }

  private publishPolicyLoaded(): void {
    if (!this.bus) return;
    this.eventCount++;
    const payload: PolicyPayload = {
      action: 'policy_loaded',
      policyVersion: this.policy.version,
    };
    this.bus.publish(
      EventBus.createEvent(EventTypes.POLICY_LOADED, this.id, payload, 'info')
    );
  }

  private publishPolicyUpdateFailed(details: string): void {
    if (!this.bus) return;
    this.eventCount++;
    const payload: PolicyPayload = {
      action: 'policy_update_failed',
      policyVersion: this.policy.version,
      details,
    };
    this.bus.publish(
      EventBus.createEvent(EventTypes.POLICY_UPDATE_FAILED, this.id, payload, 'medium')
    );
  }
}
