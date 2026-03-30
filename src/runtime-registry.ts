import type {InstanceDefinition, RuntimeInstance} from './types.js';

/**
 * In-memory source of truth for all instances known to autorouter.
 *
 * The registry deliberately does not persist anything to disk. That keeps the
 * v1 data model simple and matches the agreed contract that Admin API changes
 * are runtime-only.
 */
export class RuntimeRegistry {
  readonly #instances = new Map<string, RuntimeInstance>();

  /**
   * Creates a new runtime instance with the minimum initialized state.
   */
  create(definition: InstanceDefinition): RuntimeInstance {
    if (this.#instances.has(definition.instanceId)) {
      throw new Error(`Instance '${definition.instanceId}' already exists.`);
    }

    const instance: RuntimeInstance = {
      ...definition,
      status: 'created',
      extensionsSummary: [],
    };

    this.#instances.set(instance.instanceId, instance);
    return instance;
  }

  /**
   * Returns an instance if present, otherwise undefined.
   */
  get(instanceId: string): RuntimeInstance | undefined {
    return this.#instances.get(instanceId);
  }

  /**
   * Returns instances in a stable order so API responses and tests stay
   * deterministic.
   */
  list(): RuntimeInstance[] {
    return [...this.#instances.values()].sort((left, right) => {
      return left.instanceId.localeCompare(right.instanceId);
    });
  }

  /**
   * Applies a partial runtime patch while protecting immutable identity fields.
   */
  update(
    instanceId: string,
    patch: Partial<RuntimeInstance>,
  ): RuntimeInstance {
    const current = this.require(instanceId);
    const next = {
      ...current,
      ...patch,
      instanceId: current.instanceId,
      source: current.source,
    };
    this.#instances.set(instanceId, next);
    return next;
  }

  /**
   * Deletes the instance from the registry. Callers are responsible for cleanup
   * before removal if the instance still owns live resources.
   */
  delete(instanceId: string): void {
    this.#instances.delete(instanceId);
  }

  /**
   * Variant of {@link get} that throws a descriptive error for API and routing
   * code paths where absence is exceptional.
   */
  require(instanceId: string): RuntimeInstance {
    const instance = this.get(instanceId);
    if (!instance) {
      throw new Error(`Instance '${instanceId}' not found.`);
    }
    return instance;
  }
}
