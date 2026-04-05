import { describe, it, expect, vi } from 'vitest';
import { EventBus, EventHandler } from '../../src/core/event-bus';
import { PhoenixEvent } from '../../src/types/events';

function makeEvent(type: string, payload: unknown = {}): PhoenixEvent {
  return EventBus.createEvent(type, 'test-source', payload, 'info');
}

describe('EventBus', () => {
  // ------------------------------------------------------------------
  // subscribe & publish
  // ------------------------------------------------------------------
  describe('subscribe and publish', () => {
    it('delivers an event to a matching subscriber', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.subscribe('test.event', handler);

      const event = makeEvent('test.event', { foo: 1 });
      bus.publish(event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('does not deliver events of a different type', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.subscribe('type.a', handler);

      bus.publish(makeEvent('type.b'));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // multiple subscribers
  // ------------------------------------------------------------------
  describe('multiple subscribers', () => {
    it('delivers to every subscriber for the same event type', () => {
      const bus = new EventBus();
      const h1 = vi.fn();
      const h2 = vi.fn();
      const h3 = vi.fn();

      bus.subscribe('multi', h1);
      bus.subscribe('multi', h2);
      bus.subscribe('multi', h3);

      bus.publish(makeEvent('multi'));

      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
      expect(h3).toHaveBeenCalledOnce();
    });

    it('delivers to subscribers of different event types independently', () => {
      const bus = new EventBus();
      const hA = vi.fn();
      const hB = vi.fn();

      bus.subscribe('type.a', hA);
      bus.subscribe('type.b', hB);

      bus.publish(makeEvent('type.a'));

      expect(hA).toHaveBeenCalledOnce();
      expect(hB).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // unsubscribe
  // ------------------------------------------------------------------
  describe('unsubscribe', () => {
    it('stops delivering events after unsubscribe is called', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      const unsub = bus.subscribe('unsub.test', handler);

      bus.publish(makeEvent('unsub.test'));
      expect(handler).toHaveBeenCalledOnce();

      unsub();

      bus.publish(makeEvent('unsub.test'));
      expect(handler).toHaveBeenCalledOnce(); // still 1
    });

    it('cleans up the handler set when last subscriber is removed', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      const unsub = bus.subscribe('cleanup.test', handler);

      expect(bus.getStats().subscriberCount['cleanup.test']).toBe(1);

      unsub();

      expect(bus.getStats().subscriberCount['cleanup.test']).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // subscribeAll (wildcard)
  // ------------------------------------------------------------------
  describe('subscribeAll', () => {
    it('receives events of every type', () => {
      const bus = new EventBus();
      const wildcard = vi.fn();
      bus.subscribeAll(wildcard);

      bus.publish(makeEvent('type.a'));
      bus.publish(makeEvent('type.b'));
      bus.publish(makeEvent('type.c'));

      expect(wildcard).toHaveBeenCalledTimes(3);
    });

    it('can be unsubscribed', () => {
      const bus = new EventBus();
      const wildcard = vi.fn();
      const unsub = bus.subscribeAll(wildcard);

      bus.publish(makeEvent('any'));
      expect(wildcard).toHaveBeenCalledOnce();

      unsub();

      bus.publish(makeEvent('any'));
      expect(wildcard).toHaveBeenCalledOnce();
    });

    it('receives events alongside type-specific subscribers', () => {
      const bus = new EventBus();
      const specific = vi.fn();
      const wildcard = vi.fn();

      bus.subscribe('shared', specific);
      bus.subscribeAll(wildcard);

      bus.publish(makeEvent('shared'));

      expect(specific).toHaveBeenCalledOnce();
      expect(wildcard).toHaveBeenCalledOnce();
    });
  });

  // ------------------------------------------------------------------
  // subscribeMany
  // ------------------------------------------------------------------
  describe('subscribeMany', () => {
    it('subscribes to multiple event types at once', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.subscribeMany(['a', 'b', 'c'], handler);

      bus.publish(makeEvent('a'));
      bus.publish(makeEvent('b'));
      bus.publish(makeEvent('c'));
      bus.publish(makeEvent('d')); // not subscribed

      expect(handler).toHaveBeenCalledTimes(3);
    });

    it('returns an unsubscribe that removes all subscriptions', () => {
      const bus = new EventBus();
      const handler = vi.fn();
      const unsub = bus.subscribeMany(['x', 'y'], handler);

      bus.publish(makeEvent('x'));
      expect(handler).toHaveBeenCalledOnce();

      unsub();

      bus.publish(makeEvent('x'));
      bus.publish(makeEvent('y'));
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  // ------------------------------------------------------------------
  // error isolation
  // ------------------------------------------------------------------
  describe('error isolation', () => {
    it('continues calling other handlers when one throws', () => {
      const bus = new EventBus();
      const good1 = vi.fn();
      const bad = vi.fn(() => {
        throw new Error('handler blew up');
      });
      const good2 = vi.fn();

      bus.subscribe('err', good1);
      bus.subscribe('err', bad);
      bus.subscribe('err', good2);

      // Suppress console.error during this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      bus.publish(makeEvent('err'));

      // All handlers were invoked (safeCall wraps each individually).
      expect(good1).toHaveBeenCalledOnce();
      expect(bad).toHaveBeenCalledOnce();
      expect(good2).toHaveBeenCalledOnce();

      consoleSpy.mockRestore();
    });

    it('increments error count in stats when a handler throws', async () => {
      const bus = new EventBus();
      bus.subscribe('err', () => {
        throw new Error('boom');
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      bus.publish(makeEvent('err'));

      // safeCall is async, give it a tick to settle
      await new Promise((r) => setTimeout(r, 10));

      expect(bus.getStats().errors).toBe(1);

      consoleSpy.mockRestore();
    });
  });

  // ------------------------------------------------------------------
  // stats tracking
  // ------------------------------------------------------------------
  describe('stats tracking', () => {
    it('tracks totalPublished', () => {
      const bus = new EventBus();

      bus.publish(makeEvent('a'));
      bus.publish(makeEvent('b'));
      bus.publish(makeEvent('c'));

      expect(bus.getStats().totalPublished).toBe(3);
    });

    it('tracks subscriberCount per event type', () => {
      const bus = new EventBus();
      bus.subscribe('alpha', vi.fn());
      bus.subscribe('alpha', vi.fn());
      bus.subscribe('beta', vi.fn());

      const counts = bus.getStats().subscriberCount;
      expect(counts['alpha']).toBe(2);
      expect(counts['beta']).toBe(1);
    });

    it('updates lastEventTime on publish', () => {
      const bus = new EventBus();
      expect(bus.getStats().lastEventTime).toBe(0);

      const before = Date.now();
      bus.publish(makeEvent('ts'));
      const after = Date.now();

      const last = bus.getStats().lastEventTime;
      expect(last).toBeGreaterThanOrEqual(before);
      expect(last).toBeLessThanOrEqual(after);
    });

    it('returns a copy of stats (not a reference)', () => {
      const bus = new EventBus();
      const s1 = bus.getStats();
      bus.publish(makeEvent('x'));
      const s2 = bus.getStats();

      expect(s1.totalPublished).toBe(0);
      expect(s2.totalPublished).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  // createEvent static helper
  // ------------------------------------------------------------------
  describe('createEvent', () => {
    it('creates a well-formed PhoenixEvent', () => {
      const before = Date.now();
      const event = EventBus.createEvent('test.type', 'my-module', { key: 'val' }, 'high');
      const after = Date.now();

      expect(event.type).toBe('test.type');
      expect(event.source).toBe('my-module');
      expect(event.payload).toEqual({ key: 'val' });
      expect(event.severity).toBe('high');
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });

    it('defaults severity to info', () => {
      const event = EventBus.createEvent('t', 's', {});
      expect(event.severity).toBe('info');
    });
  });

  // ------------------------------------------------------------------
  // clear
  // ------------------------------------------------------------------
  describe('clear', () => {
    it('removes all type-specific handlers', () => {
      const bus = new EventBus();
      const h = vi.fn();
      bus.subscribe('a', h);
      bus.subscribe('b', h);

      bus.clear();

      bus.publish(makeEvent('a'));
      bus.publish(makeEvent('b'));

      expect(h).not.toHaveBeenCalled();
    });

    it('removes wildcard handlers', () => {
      const bus = new EventBus();
      const h = vi.fn();
      bus.subscribeAll(h);

      bus.clear();

      bus.publish(makeEvent('any'));
      expect(h).not.toHaveBeenCalled();
    });
  });
});
