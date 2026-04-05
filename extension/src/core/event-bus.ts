import { PhoenixEvent, Severity } from '../types/events';

export type EventHandler<T = unknown> = (event: PhoenixEvent<T>) => void | Promise<void>;
type Unsubscribe = () => void;

interface BusStats {
  totalPublished: number;
  subscriberCount: Record<string, number>;
  lastEventTime: number;
  errors: number;
}

export class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private wildcardHandlers: Set<EventHandler> = new Set();
  private stats: BusStats = {
    totalPublished: 0,
    subscriberCount: {},
    lastEventTime: 0,
    errors: 0,
  };

  /**
   * Subscribe to a specific event type.
   */
  subscribe<T = unknown>(eventType: string, handler: EventHandler<T>): Unsubscribe {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    const typedHandler = handler as EventHandler;
    this.handlers.get(eventType)!.add(typedHandler);
    this.updateSubscriberCount();

    return () => {
      this.handlers.get(eventType)?.delete(typedHandler);
      if (this.handlers.get(eventType)?.size === 0) {
        this.handlers.delete(eventType);
      }
      this.updateSubscriberCount();
    };
  }

  /**
   * Subscribe to multiple event types with a single handler.
   */
  subscribeMany(eventTypes: string[], handler: EventHandler): Unsubscribe {
    const unsubscribes = eventTypes.map(type => this.subscribe(type, handler));
    return () => unsubscribes.forEach(unsub => unsub());
  }

  /**
   * Subscribe to ALL events (wildcard).
   */
  subscribeAll(handler: EventHandler): Unsubscribe {
    this.wildcardHandlers.add(handler);
    return () => {
      this.wildcardHandlers.delete(handler);
    };
  }

  /**
   * Publish an event. Handlers are called asynchronously.
   * Errors in one handler do NOT prevent other handlers from executing.
   */
  publish<T = unknown>(event: PhoenixEvent<T>): void {
    this.stats.totalPublished++;
    this.stats.lastEventTime = Date.now();

    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        this.safeCall(handler, event);
      }
    }

    // Wildcard handlers get all events
    for (const handler of this.wildcardHandlers) {
      this.safeCall(handler, event);
    }
  }

  /**
   * Create a typed event helper.
   */
  static createEvent<T>(
    type: string,
    source: string,
    payload: T,
    severity: Severity = 'info'
  ): PhoenixEvent<T> {
    return {
      type,
      timestamp: Date.now(),
      source,
      payload,
      severity,
    };
  }

  getStats(): BusStats {
    return { ...this.stats };
  }

  /**
   * Remove all handlers (used in destroy/cleanup).
   */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }

  private async safeCall<T>(handler: EventHandler, event: PhoenixEvent<T>): Promise<void> {
    try {
      await handler(event as PhoenixEvent);
    } catch (error) {
      this.stats.errors++;
      console.error(`[EventBus] Handler error for event "${event.type}":`, error);
    }
  }

  private updateSubscriberCount(): void {
    const counts: Record<string, number> = {};
    for (const [type, handlers] of this.handlers) {
      counts[type] = handlers.size;
    }
    this.stats.subscriberCount = counts;
  }
}
