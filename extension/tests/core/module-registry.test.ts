import { describe, it, expect, vi } from 'vitest';
import { ModuleRegistry } from '../../src/core/module-registry';
import { EventBus } from '../../src/core/event-bus';
import { PhoenixModule, ModuleStatus } from '../../src/types/modules';

/** Create a minimal mock module. */
function makeMockModule(id: string, version = '1.0.0'): PhoenixModule {
  return {
    id,
    version,
    register: vi.fn(),
    destroy: vi.fn(),
    getStatus: vi.fn(
      (): ModuleStatus => ({
        id,
        enabled: true,
        lastActivity: 0,
        eventCount: 0,
        errors: [],
      }),
    ),
  };
}

describe('ModuleRegistry', () => {
  // ------------------------------------------------------------------
  // register
  // ------------------------------------------------------------------
  describe('register', () => {
    it('adds a module to the registry', () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);
      const mod = makeMockModule('test-mod');

      registry.register(mod);

      expect(registry.size).toBe(1);
      expect(registry.getModule('test-mod')).toBe(mod);
    });

    it('accepts multiple distinct modules', () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);

      registry.register(makeMockModule('a'));
      registry.register(makeMockModule('b'));
      registry.register(makeMockModule('c'));

      expect(registry.size).toBe(3);
    });
  });

  // ------------------------------------------------------------------
  // duplicate registration
  // ------------------------------------------------------------------
  describe('duplicate registration', () => {
    it('throws when registering a module with the same id', () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);

      registry.register(makeMockModule('dup'));

      expect(() => registry.register(makeMockModule('dup'))).toThrowError(
        'Module "dup" is already registered',
      );
    });
  });

  // ------------------------------------------------------------------
  // initAll
  // ------------------------------------------------------------------
  describe('initAll', () => {
    it('calls register(bus) on each module', async () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);
      const m1 = makeMockModule('m1');
      const m2 = makeMockModule('m2');

      registry.register(m1);
      registry.register(m2);

      await registry.initAll();

      expect(m1.register).toHaveBeenCalledOnce();
      expect(m1.register).toHaveBeenCalledWith(bus);
      expect(m2.register).toHaveBeenCalledOnce();
      expect(m2.register).toHaveBeenCalledWith(bus);
    });

    it('initializes modules in registration order', async () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);
      const order: string[] = [];

      const m1 = makeMockModule('first');
      (m1.register as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('first'));
      const m2 = makeMockModule('second');
      (m2.register as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('second'));
      const m3 = makeMockModule('third');
      (m3.register as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('third'));

      registry.register(m1);
      registry.register(m2);
      registry.register(m3);

      await registry.initAll();

      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('continues initializing when one module throws', async () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);

      const good = makeMockModule('good');
      const bad = makeMockModule('bad');
      (bad.register as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('init failed');
      });
      const alsoGood = makeMockModule('also-good');

      registry.register(good);
      registry.register(bad);
      registry.register(alsoGood);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await registry.initAll();

      expect(good.register).toHaveBeenCalledOnce();
      expect(bad.register).toHaveBeenCalledOnce();
      expect(alsoGood.register).toHaveBeenCalledOnce();

      consoleSpy.mockRestore();
    });
  });

  // ------------------------------------------------------------------
  // destroyAll
  // ------------------------------------------------------------------
  describe('destroyAll', () => {
    it('calls destroy on each initialized module', async () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);
      const m1 = makeMockModule('m1');
      const m2 = makeMockModule('m2');

      registry.register(m1);
      registry.register(m2);
      await registry.initAll();

      await registry.destroyAll();

      expect(m1.destroy).toHaveBeenCalledOnce();
      expect(m2.destroy).toHaveBeenCalledOnce();
    });

    it('destroys in reverse initialization order', async () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);
      const order: string[] = [];

      const m1 = makeMockModule('first');
      (m1.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('first'));
      const m2 = makeMockModule('second');
      (m2.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('second'));
      const m3 = makeMockModule('third');
      (m3.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('third'));

      registry.register(m1);
      registry.register(m2);
      registry.register(m3);
      await registry.initAll();

      await registry.destroyAll();

      expect(order).toEqual(['third', 'second', 'first']);
    });

    it('clears the registry after destroy', async () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);

      registry.register(makeMockModule('x'));
      await registry.initAll();
      await registry.destroyAll();

      expect(registry.size).toBe(0);
      expect(registry.getModule('x')).toBeUndefined();
    });

    it('handles destroy errors gracefully', async () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);

      const good = makeMockModule('good');
      const bad = makeMockModule('bad');
      (bad.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('destroy failed');
      });

      registry.register(good);
      registry.register(bad);
      await registry.initAll();

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Should not throw
      await registry.destroyAll();

      expect(good.destroy).toHaveBeenCalledOnce();
      expect(bad.destroy).toHaveBeenCalledOnce();
      expect(registry.size).toBe(0);

      consoleSpy.mockRestore();
    });
  });

  // ------------------------------------------------------------------
  // getModule
  // ------------------------------------------------------------------
  describe('getModule', () => {
    it('returns the registered module by id', () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);
      const mod = makeMockModule('target');

      registry.register(mod);

      expect(registry.getModule('target')).toBe(mod);
    });

    it('returns undefined for an unknown id', () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);

      expect(registry.getModule('nope')).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // getAllStatus
  // ------------------------------------------------------------------
  describe('getAllStatus', () => {
    it('returns status objects for all registered modules', () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);

      registry.register(makeMockModule('alpha'));
      registry.register(makeMockModule('beta'));

      const statuses = registry.getAllStatus();

      expect(statuses).toHaveLength(2);
      expect(statuses.map((s) => s.id)).toEqual(['alpha', 'beta']);
    });

    it('returns an empty array when no modules are registered', () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);

      expect(registry.getAllStatus()).toEqual([]);
    });
  });

  // ------------------------------------------------------------------
  // size
  // ------------------------------------------------------------------
  describe('size', () => {
    it('returns 0 for an empty registry', () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);
      expect(registry.size).toBe(0);
    });

    it('reflects the number of registered modules', () => {
      const bus = new EventBus();
      const registry = new ModuleRegistry(bus);

      registry.register(makeMockModule('a'));
      expect(registry.size).toBe(1);

      registry.register(makeMockModule('b'));
      expect(registry.size).toBe(2);
    });
  });
});
