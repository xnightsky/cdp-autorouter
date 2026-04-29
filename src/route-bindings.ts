import {randomUUID} from 'node:crypto';

import type {Logger, RouteBinding} from './types.js';

/**
 * 存储 autorouter 暴露的临时 WS 路由 token。
 *
 * 每个 binding 将 autorouter 签名的外部 WS URL 与真实下游 Chrome WS URL 解耦。
 * 这让 autorouter 能继续掌控 WS 层，而不泄露真实 Chrome 端点。
 */
export class RouteBindingStore {
  readonly #bindings = new Map<string, RouteBinding>();

  constructor(private readonly logger?: Logger) {}

  /**
   * 生成一个新的不透明 token，映射到下游 Chrome WS URL。
   *
   * token 通过改写的 `webSocketDebuggerUrl` 字段返回给客户端，
   * 使后续 WS 连接重新流经 autorouter。
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
    this.logger?.debug('binding registered', {token, instanceId, kind});
    return binding;
  }

  /**
   * 按 token 查找已有 binding。
   */
  get(token: string): RouteBinding | undefined {
    return this.#bindings.get(token);
  }

  /**
   * 当 WS 路由不再需要时，移除单个 binding token。
   */
  delete(token: string): void {
    this.#bindings.delete(token);
    this.logger?.debug('binding deleted', {token});
  }

  /**
   * 移除某个实例的所有 binding，通常在 stop 或回收流程中使用。
   */
  deleteForInstance(instanceId: string): void {
    for (const [token, binding] of this.#bindings) {
      if (binding.instanceId === instanceId) {
        this.#bindings.delete(token);
        this.logger?.debug('binding deleted for instance', {token, instanceId});
      }
    }
  }
}
