import { EventBus } from '../core/event-bus';

export interface ModuleStatus {
  id: string;
  enabled: boolean;
  lastActivity: number;
  eventCount: number;
  errors: string[];
}

export interface PhoenixModule {
  readonly id: string;
  readonly version: string;
  register(bus: EventBus): void;
  destroy(): void;
  getStatus(): ModuleStatus;
}
