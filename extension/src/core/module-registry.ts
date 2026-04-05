import { PhoenixModule, ModuleStatus } from '../types/modules';
import { EventBus } from './event-bus';

export class ModuleRegistry {
  private modules: Map<string, PhoenixModule> = new Map();
  private bus: EventBus;
  private initOrder: string[] = [];

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  /**
   * Register a module. Does not initialize it yet.
   */
  register(module: PhoenixModule): void {
    if (this.modules.has(module.id)) {
      throw new Error(`Module "${module.id}" is already registered`);
    }
    this.modules.set(module.id, module);
  }

  /**
   * Initialize all registered modules in registration order.
   */
  async initAll(): Promise<void> {
    for (const [id, module] of this.modules) {
      try {
        module.register(this.bus);
        this.initOrder.push(id);
        console.log(`[ModuleRegistry] Initialized module: ${id} v${module.version}`);
      } catch (error) {
        console.error(`[ModuleRegistry] Failed to initialize module "${id}":`, error);
      }
    }
  }

  /**
   * Destroy all modules in reverse initialization order.
   */
  async destroyAll(): Promise<void> {
    const reversed = [...this.initOrder].reverse();
    for (const id of reversed) {
      try {
        const module = this.modules.get(id);
        if (module) {
          module.destroy();
          console.log(`[ModuleRegistry] Destroyed module: ${id}`);
        }
      } catch (error) {
        console.error(`[ModuleRegistry] Failed to destroy module "${id}":`, error);
      }
    }
    this.modules.clear();
    this.initOrder = [];
  }

  /**
   * Get a specific module by ID.
   */
  getModule<T extends PhoenixModule>(id: string): T | undefined {
    return this.modules.get(id) as T | undefined;
  }

  /**
   * Get status of all modules.
   */
  getAllStatus(): ModuleStatus[] {
    return Array.from(this.modules.values()).map(m => m.getStatus());
  }

  /**
   * Get count of registered modules.
   */
  get size(): number {
    return this.modules.size;
  }
}
