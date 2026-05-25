import type {InstanceDefinition, Logger, RuntimeInstance} from './types.js';

/**
 * autorouter 所有已知实例的内存唯一真相源。
 *
 * 注册表刻意不持久化到磁盘，保持 v1 数据模型简单，并契合 Admin API 变更仅运行时生效的约定。
 */
export class RuntimeRegistry {
  readonly #instances = new Map<string, RuntimeInstance>();

  constructor(private readonly logger?: Logger) {}

  /**
   * 以最小初始化状态创建新的运行时实例。
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
    this.logger?.info('instance created', {instanceId: instance.instanceId, mode: instance.mode});
    return instance;
  }

  /**
   * 若实例存在则返回，否则返回 undefined。
   */
  get(instanceId: string): RuntimeInstance | undefined {
    return this.#instances.get(instanceId);
  }

  /**
   * 以稳定顺序返回实例，使 API 响应和测试结果保持确定性。
   */
  list(): RuntimeInstance[] {
    return [...this.#instances.values()].sort((left, right) => {
      return left.instanceId.localeCompare(right.instanceId);
    });
  }

  /**
   * 应用部分运行时补丁，同时保护不可变的身份字段。
   *
   * `instanceId` 和 `source` 始终被保留，防止调用方意外改写记录身份。
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
   * 从注册表中删除实例。
   * 若实例仍持有活跃资源，调用方应在删除前负责清理。
   */
  delete(instanceId: string): void {
    this.#instances.delete(instanceId);
    this.logger?.info('instance deleted', {instanceId});
  }

  /**
   * {@link get} 的变体：当实例缺失时抛出描述性错误，用于 API 和路由中缺失即异常的场景。
   */
  require(instanceId: string): RuntimeInstance {
    const instance = this.get(instanceId);
    if (!instance) {
      throw new Error(`Instance '${instanceId}' not found.`);
    }
    return instance;
  }
}
