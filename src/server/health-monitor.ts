import type {ChildBrowserSupervisor} from './child-browser-supervisor.js';
import type {RuntimeRegistry} from './runtime-registry.js';
import type {Logger, OperationLogger, RuntimeInstance} from './types.js';

/**
 * HealthMonitor 的可调参数，来自 EnvPolicy（`.env` 的 HEALTH_* 键）。
 */
export interface HealthMonitorOptions {
  /** 是否对 error/unhealthy 的 managed 实例自动恢复。attached 实例永不自动恢复。 */
  healEnabled: boolean;
  /** 巡检周期（毫秒）。 */
  intervalMs: number;
  /** 同一实例两次自愈尝试的最小间隔（毫秒）。 */
  healCooldownMs: number;
  /** 同一实例连续自愈失败次数上限，达到后熔断。 */
  healMaxFailures: number;
}

/** monitor 只用 supervisor 的这两个方法，结构子集便于测试注入 stub。 */
type SupervisorProbe = Pick<ChildBrowserSupervisor, 'start' | 'refresh'>;

interface HealState {
  lastAttemptAt: number;
  consecutiveFailures: number;
}

/**
 * server 端低频健康巡检。
 *
 * 设计动机（2026-09-20 事故，见 docs/notes/case/2026-09-20-managed-exit-and-ssh-flap.md）：
 * managed 浏览器被外部因素（崩溃/SSH 会话断开/外部 kill）杀死后，实例只剩 error/unhealthy 残留，
 * 既无主动探测也无自动恢复，远端客户端只能等人工 up。本巡检把"发现 + 恢复"闭环收到 server 端：
 *
 * 注意退出码分流（child-browser-supervisor exit handler）：优雅退出（code 0 无信号，典型为用户
 * 手动关窗）落 `stopped` 而非 `error`——视为用户故意停止，本巡检不拉起，等下次业务请求懒启动；
 * 只有非 0 退出 / 信号类意外死亡才落 `error` 进入下面的自愈路径。
 *
 * - 每个 tick 对所有实例做 refresh（主动探测，替代请求时懒标记）。
 * - 对 error/unhealthy 的 **managed** 实例尝试 supervisor.start 自动恢复。
 * - `created`/`stopped` 不动：不替用户做"启动"决定；`starting`/`reclaiming` 跳过：生命周期进行中。
 * - attached 只刷新健康，绝不重启/杀外部浏览器（managed/attached 回收边界不混淆）。
 * - 冷却 + 熔断：同一实例自愈尝试间隔 ≥ healCooldownMs；连续失败 ≥ healMaxFailures 后暂停，
 *   防止下游不可恢复（如可执行文件缺失）时每个周期刷 spawn。实例被人工 start/stop 改变状态后
 *   熔断计数随成功恢复清零。
 */
export class HealthMonitor {
  #timer?: NodeJS.Timeout;
  /** tick 防重入：上一轮还没跑完（如 start 等待超时）就跳过本轮。 */
  #ticking = false;
  readonly #healStates = new Map<string, HealState>();

  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly supervisor: SupervisorProbe,
    private readonly options: HealthMonitorOptions,
    private readonly logger?: Logger,
    private readonly operationLogger?: OperationLogger,
  ) {}

  /**
   * 启动周期巡检。重复调用幂等。timer unref，不阻碍进程退出。
   */
  start(): void {
    if (this.#timer) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    this.#timer.unref();
    this.logger?.info('health monitor started', {intervalMs: this.options.intervalMs});
  }

  /**
   * 停止巡检。shutdown 路径必须先停 monitor 再回收实例，避免巡检与回收竞争。
   */
  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
      this.logger?.info('health monitor stopped');
    }
  }

  /**
   * 单轮巡检。暴露为 public 以便测试直接驱动，不依赖定时器。
   */
  async tick(): Promise<void> {
    if (this.#ticking) {
      return;
    }
    this.#ticking = true;
    try {
      for (const instance of this.registry.list()) {
        // 单实例失败不能中断整轮巡检；错误已在 checkInstance 内记录。
        await this.checkInstance(instance);
      }
    } finally {
      this.#ticking = false;
    }
  }

  private async checkInstance(instance: RuntimeInstance): Promise<void> {
    if (instance.status === 'starting' || instance.status === 'reclaiming') {
      return;
    }

    if (instance.mode === 'attached') {
      // attached 只做被动健康刷新；wsEndpoint-only 无 browserUrl 的实例暂时无法探测，跳过。
      if (!instance.browserUrl) {
        return;
      }
      await this.tryRefresh(instance.instanceId);
      return;
    }

    if (instance.status === 'healthy') {
      await this.tryRefresh(instance.instanceId);
      return;
    }

    if (instance.status === 'created' || instance.status === 'stopped') {
      return;
    }

    // managed + error/unhealthy → 自动恢复
    if (!this.options.healEnabled) {
      return;
    }
    const now = Date.now();
    const state = this.#healStates.get(instance.instanceId) ?? {
      lastAttemptAt: 0,
      consecutiveFailures: 0,
    };
    if (state.consecutiveFailures >= this.options.healMaxFailures) {
      return;
    }
    if (now - state.lastAttemptAt < this.options.healCooldownMs) {
      return;
    }
    state.lastAttemptAt = now;
    this.#healStates.set(instance.instanceId, state);

    this.operationLogger?.log('instance:heal-attempt', {
      instanceId: instance.instanceId,
      previousStatus: instance.status,
      previousError: instance.lastError,
      consecutiveFailures: state.consecutiveFailures,
    });
    try {
      await this.supervisor.start(instance);
      this.#healStates.delete(instance.instanceId);
      this.operationLogger?.log('instance:heal-success', {instanceId: instance.instanceId});
    } catch (error: unknown) {
      state.consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn('health monitor heal failed', {
        instanceId: instance.instanceId,
        error: message,
        consecutiveFailures: state.consecutiveFailures,
      });
      this.operationLogger?.log('instance:heal-failed', {
        instanceId: instance.instanceId,
        error: message,
        consecutiveFailures: state.consecutiveFailures,
      });
    }
  }

  /**
   * refresh 失败不向外抛：refresh 内部已把实例标记为 unhealthy 并记录 lastError，
   * 这里只需兜底日志，保证单实例探测失败不中断整轮巡检。
   */
  private async tryRefresh(instanceId: string): Promise<void> {
    try {
      await this.supervisor.refresh(instanceId);
    } catch (error: unknown) {
      this.logger?.warn('health monitor refresh failed', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
