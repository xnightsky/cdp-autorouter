import {randomUUID} from 'node:crypto';

import type {RouteBinding} from './types.js';

/**
 * Stores temporary WS route tokens exposed by autorouter.
 *
 * Each binding decouples the external WS URL signed by autorouter from the real
 * downstream Chrome WS URL. This is what lets autorouter keep ownership of the
 * WS layer instead of leaking real Chrome endpoints.
 */
export class RouteBindingStore {
  readonly #bindings = new Map<string, RouteBinding>();

  /**
   * Creates a new one-time-ish route binding for a browser or page websocket.
   */
  register(instanceId: string, downstreamWsUrl: string, kind: 'browser' | 'page') {
    const token = randomUUID();
    const binding: RouteBinding = {
      token,
      instanceId,
      downstreamWsUrl,
      kind,
      createdAt: Date.now(),
    };
    this.#bindings.set(token, binding);
    return binding;
  }

  /**
   * Looks up an existing binding token.
   */
  get(token: string): RouteBinding | undefined {
    return this.#bindings.get(token);
  }

  /**
   * Removes a single binding token once the WS route is no longer needed.
   */
  delete(token: string): void {
    this.#bindings.delete(token);
  }

  /**
   * Removes all bindings created for a specific instance, typically during stop
   * or reclaim flows.
   */
  deleteForInstance(instanceId: string): void {
    for (const [token, binding] of this.#bindings) {
      if (binding.instanceId === instanceId) {
        this.#bindings.delete(token);
      }
    }
  }
}
