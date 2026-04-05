import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from '../core/event-bus';
import { ChromeStorage } from '../core/storage';
import { PhoenixEvent } from '../types/events';
import {
  ALARM_NAMES,
  BATCH_INTERVAL_MS,
  MAX_BATCH_SIZE,
  DEFAULT_EDR_ENDPOINT,
  MAX_RETRY_QUEUE_MB,
  EXTENSION_ID,
  EXTENSION_VERSION,
} from '../core/constants';
import { PolicyEngine } from './policy-engine';

interface AgentEvent {
  id: string;
  type: string;
  timestamp: number;
  severity: string;
  source: string;
  payload: Record<string, unknown>;
}

interface EventBatchRequest {
  extension_id: string;
  extension_version: string;
  machine_id: string;
  timestamp: number;
  events: AgentEvent[];
}

interface RetryEntry {
  batch: EventBatchRequest;
  attempts: number;
  nextRetryAt: number;
}

const RETRY_QUEUE_KEY = 'phoenix_retry_queue';

export class EdrReporter implements PhoenixModule {
  readonly id = 'edr-reporter';
  readonly version = '1.0.0';

  private bus: EventBus | null = null;
  private storage = new ChromeStorage();
  private buffer: PhoenixEvent[] = [];
  private machineId = '';
  private enabled = false;
  private lastActivity = 0;
  private eventCount = 0;
  private errors: string[] = [];
  private unsubscribe: (() => void) | null = null;
  private alarmListener: ((alarm: chrome.alarms.Alarm) => void) | null = null;
  private policyEngine: PolicyEngine | null = null;

  /** Optionally inject PolicyEngine for endpoint/batch settings. */
  setPolicyEngine(engine: PolicyEngine): void {
    this.policyEngine = engine;
  }

  register(bus: EventBus): void {
    this.bus = bus;
    this.enabled = true;
    this.machineId = this.generateMachineId();

    // Subscribe to all events and buffer them
    this.unsubscribe = bus.subscribeAll((event) => {
      this.bufferEvent(event);
    });

    // Set up periodic flush alarm
    chrome.alarms.create(ALARM_NAMES.EDR_REPORT_FLUSH, {
      periodInMinutes: BATCH_INTERVAL_MS / 60_000,
    });

    this.alarmListener = (alarm) => {
      if (alarm.name === ALARM_NAMES.EDR_REPORT_FLUSH) {
        this.flush().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.errors.push(`Flush failed: ${msg}`);
        });
      }
    };
    chrome.alarms.onAlarm.addListener(this.alarmListener);

    // Process any pending retries on startup
    this.processRetryQueue().catch(() => {});
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
    chrome.alarms.clear(ALARM_NAMES.EDR_REPORT_FLUSH);

    // Attempt a final flush of remaining events
    if (this.buffer.length > 0) {
      this.flush().catch(() => {});
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

  private bufferEvent(event: PhoenixEvent): void {
    const maxBatch =
      this.policyEngine?.getPolicy()?.edr_reporter?.max_batch_size ?? MAX_BATCH_SIZE;

    this.buffer.push(event);
    this.eventCount++;
    this.lastActivity = Date.now();

    // Auto-flush when buffer hits max size
    if (this.buffer.length >= maxBatch) {
      this.flush().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`Auto-flush failed: ${msg}`);
      });
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Take current buffer and reset
    const events = this.buffer.splice(0);
    const batch = this.createBatch(events);

    const endpoint = this.getEndpoint();

    try {
      const response = await fetch(`${endpoint}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.lastActivity = Date.now();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Batch send failed: ${msg}`);

      // Move to retry queue
      await this.enqueueRetry(batch);
    }

    // Also attempt to drain retry queue
    await this.processRetryQueue();
  }

  private async enqueueRetry(batch: EventBatchRequest): Promise<void> {
    try {
      const queue = (await this.storage.get<RetryEntry[]>(RETRY_QUEUE_KEY)) || [];

      const backoffMs =
        this.policyEngine?.getPolicy()?.edr_reporter?.retry_backoff_ms ?? 1000;

      const entry: RetryEntry = {
        batch,
        attempts: 0,
        nextRetryAt: Date.now() + backoffMs,
      };

      queue.push(entry);

      // Enforce max retry queue size (~5MB)
      const serialized = JSON.stringify(queue);
      const sizeBytes = new Blob([serialized]).size;
      const maxBytes = MAX_RETRY_QUEUE_MB * 1024 * 1024;

      while (queue.length > 0 && new Blob([JSON.stringify(queue)]).size > maxBytes) {
        queue.shift(); // Drop oldest entries
      }

      await this.storage.set(RETRY_QUEUE_KEY, queue);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Retry enqueue failed: ${msg}`);
    }
  }

  private async processRetryQueue(): Promise<void> {
    try {
      const queue = (await this.storage.get<RetryEntry[]>(RETRY_QUEUE_KEY)) || [];
      if (queue.length === 0) return;

      const maxAttempts =
        this.policyEngine?.getPolicy()?.edr_reporter?.retry_attempts ?? 3;
      const backoffMs =
        this.policyEngine?.getPolicy()?.edr_reporter?.retry_backoff_ms ?? 1000;
      const endpoint = this.getEndpoint();
      const now = Date.now();

      const remaining: RetryEntry[] = [];

      for (const entry of queue) {
        // Skip if not yet time to retry
        if (entry.nextRetryAt > now) {
          remaining.push(entry);
          continue;
        }

        // Skip if max attempts exceeded
        if (entry.attempts >= maxAttempts) {
          // Drop the entry silently
          continue;
        }

        try {
          const response = await fetch(`${endpoint}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry.batch),
            signal: AbortSignal.timeout(15_000),
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          // Success - don't re-add to remaining
        } catch {
          entry.attempts++;
          // Exponential backoff: backoffMs * 2^attempts
          entry.nextRetryAt = now + backoffMs * Math.pow(2, entry.attempts);
          if (entry.attempts < maxAttempts) {
            remaining.push(entry);
          }
        }
      }

      await this.storage.set(RETRY_QUEUE_KEY, remaining);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(`Retry processing failed: ${msg}`);
    }
  }

  private createBatch(events: PhoenixEvent[]): EventBatchRequest {
    const agentEvents: AgentEvent[] = events.map((e) => ({
      id: crypto.randomUUID(),
      type: e.type,
      timestamp: e.timestamp,
      severity: e.severity,
      source: e.source,
      payload: (e.payload && typeof e.payload === 'object' ? e.payload : { data: e.payload }) as Record<string, unknown>,
    }));

    return {
      extension_id: EXTENSION_ID,
      extension_version: EXTENSION_VERSION,
      machine_id: this.machineId,
      timestamp: Date.now(),
      events: agentEvents,
    };
  }

  private getEndpoint(): string {
    return this.policyEngine?.getPolicy()?.edr_reporter?.endpoint ?? DEFAULT_EDR_ENDPOINT;
  }

  private generateMachineId(): string {
    // Deterministic hash from navigator.userAgent
    const ua = navigator.userAgent;
    let hash = 0;
    for (let i = 0; i < ua.length; i++) {
      const char = ua.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `machine-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }
}
