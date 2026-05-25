import type {EnvPolicy, Logger, RuntimeInstance} from './types.js';
import {RuntimeRegistry} from './runtime-registry.js';

/**
 * 封装"根路径兼容路由 = 默认实例"这条规则。
 *
 * 此类只负责"存在性决策"：查找默认实例，或从 `.env` 创建其内存引导记录。
 * 启动或刷新实例则委托给 supervisor 层。
 */
export class DefaultInstanceResolver {
  constructor(
    private readonly policy: EnvPolicy,
    private readonly registry: RuntimeRegistry,
    private readonly logger?: Logger,
  ) {}

  /**
   * 确保默认兼容实例存在于运行时注册表中。
   *
   * 若兼容模式被禁用或模板不完整，在此处立即失败，
   * 使 HTTP 层返回明确错误，而非半服务一条路由。
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
      this.logger?.warn('default instance lazy load disabled');
      throw new Error('Compatibility lazy load is disabled.');
    }

    this.logger?.info('default instance bootstrapped from env', {instanceId: template.instanceId});
    return this.registry.create({
      ...template,
      source: 'env-bootstrap',
    });
  }
}
