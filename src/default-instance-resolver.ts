import type {EnvPolicy, RuntimeInstance} from './types.js';
import {RuntimeRegistry} from './runtime-registry.js';

/**
 * Encapsulates the "root compat route means default instance" rule.
 *
 * This class owns only the existence decision: find the default instance or
 * create its in-memory bootstrap record from `.env`. Starting or refreshing the
 * instance is delegated to the supervisor layer.
 */
export class DefaultInstanceResolver {
  constructor(
    private readonly policy: EnvPolicy,
    private readonly registry: RuntimeRegistry,
  ) {}

  /**
   * Ensures that the default compat instance exists in the runtime registry.
   *
   * If compat mode is disabled or the template is incomplete, we fail fast here
   * so the HTTP layer can return a clear error instead of half-serving a route.
   */
  ensureDefaultInstance(): RuntimeInstance {
    if (!this.policy.compatModeEnabled) {
      throw new Error('Compatibility mode is disabled.');
    }

    const template = this.policy.defaultInstanceTemplate;
    if (!template) {
      throw new Error('DEFAULT_INSTANCE_ID is not configured.');
    }

    const existing = this.registry.get(template.instanceId);
    if (existing) {
      return existing;
    }

    if (!this.policy.compatLazyLoadEnabled) {
      throw new Error('Compatibility lazy load is disabled.');
    }

    return this.registry.create({
      ...template,
      source: 'env-bootstrap',
    });
  }
}
