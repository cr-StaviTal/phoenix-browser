import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from '../core/event-bus';
import { ForensicLogDB, ForensicLogEntry, LogQueryOptions } from '../core/storage';
import { PhoenixEvent } from '../types/events';
import {
  ALARM_NAMES,
  LOG_ROTATION_INTERVAL_MS,
  LOG_RETENTION_DAYS,
  MAX_FORENSIC_STORAGE_MB,
} from '../core/constants';
import { PolicyEngine } from './policy-engine';

export class ForensicLogger implements PhoenixModule {
  readonly id = 'forensic-logger';
  readonly version = '1.0.0';

  private bus: EventBus | null = null;
  private db = new ForensicLogDB();
  private sessionId: string = '';
  private enabled = false;
  private lastActivity = 0;
  private eventCount = 0;
  private errors: string[] = [];
  private unsubscribe: (() => void) | null = null;
  private alarmListener: ((alarm: chrome.alarms.Alarm) => void) | null = null;
  private policyEngine: PolicyEngine | null = null;

  /** Optionally inject PolicyEngine for retention settings. */
  setPolicyEngine(engine: PolicyEngine): void {
    this.policyEngine = engine;
  }

  register(bus: EventBus): void {
    this.bus = bus;
    this.enabled = true;
    this.sessionId = crypto.randomUUID();

    // Open IndexedDB, then subscribe to all events
    this.db
      .open()
      .then(() => {
        this.unsubscribe = bus.subscribeAll((event) => {
          this.handleEvent(event).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.errors.push(`Log write failed: ${msg}`);
          });
        });
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`IndexedDB open failed: ${msg}`);
      });

    // Set up log rotation alarm
    chrome.alarms.create(ALARM_NAMES.LOG_ROTATION, {
      periodInMinutes: LOG_ROTATION_INTERVAL_MS / 60_000,
    });

    this.alarmListener = (alarm) => {
      if (alarm.name === ALARM_NAMES.LOG_ROTATION) {
        this.rotateAndEvict().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.errors.push(`Log rotation failed: ${msg}`);
        });
      }
    };
    chrome.alarms.onAlarm.addListener(this.alarmListener);
  }

  destroy(): void {
    this.enabled = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.alarmListener) {
      chrome.alarms.onAlarm.removeListener(this.alarmListener);
      this.alarmListener = null;
    }
    chrome.alarms.clear(ALARM_NAMES.LOG_ROTATION);
    this.db.close();
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

  /** Query forensic logs with optional filters. */
  async queryLogs(options?: LogQueryOptions): Promise<ForensicLogEntry[]> {
    return this.db.query(options);
  }

  private async handleEvent(event: PhoenixEvent): Promise<void> {
    const entry: ForensicLogEntry = {
      id: crypto.randomUUID(),
      timestamp: event.timestamp,
      type: event.type,
      severity: event.severity,
      source: event.source,
      payload: event.payload as Record<string, unknown>,
      tabId: (event.payload as Record<string, unknown>)?.tabId as number | undefined,
      url: (event.payload as Record<string, unknown>)?.url as string | undefined,
      sessionId: this.sessionId,
    };

    await this.db.write(entry);
    this.eventCount++;
    this.lastActivity = Date.now();
  }

  private async rotateAndEvict(): Promise<void> {
    // Determine retention from policy or use default
    const retentionDays =
      this.policyEngine?.getPolicy()?.forensic_logger?.retention_days ?? LOG_RETENTION_DAYS;
    const maxStorageMb =
      this.policyEngine?.getPolicy()?.forensic_logger?.max_storage_mb ?? MAX_FORENSIC_STORAGE_MB;

    // Delete logs older than retention period
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const deleted = await this.db.deleteOlderThan(cutoff);
    if (deleted > 0) {
      console.log(`[ForensicLogger] Rotated ${deleted} log entries older than ${retentionDays}d`);
    }

    // Check storage usage and evict oldest if over budget
    const usageBytes = await this.db.estimateStorageBytes();
    const maxBytes = maxStorageMb * 1024 * 1024;

    if (usageBytes > maxBytes) {
      // Evict oldest 10% of logs iteratively until under budget
      const count = await this.db.getCount();
      const evictTarget = Math.max(Math.ceil(count * 0.1), 100);

      // Get oldest entries and delete them by finding a timestamp threshold
      const oldest = await this.db.query({ limit: evictTarget });
      if (oldest.length > 0) {
        const threshold = oldest[oldest.length - 1].timestamp;
        const evicted = await this.db.deleteOlderThan(threshold + 1);
        console.log(
          `[ForensicLogger] Evicted ${evicted} entries to stay within ${maxStorageMb}MB budget`
        );
      }
    }

    this.lastActivity = Date.now();
  }
}
