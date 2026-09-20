import {describe, expect, test} from 'vitest';

import {HealthMonitor, type HealthMonitorOptions} from '../src/server/health-monitor.js';
import {RuntimeRegistry} from '../src/server/runtime-registry.js';
import type {RuntimeInstance} from '../src/server/types.js';
import {createSilentLogger} from './helpers/mock-logger.js';

/**
 * 结构化工件：真实 RuntimeRegistry + 可编程 stub supervisor。
 * monitor 只依赖 supervisor 的 start/refresh，stub 记录调用并按需成败。
 */
function createHarness(options: Partial<HealthMonitorOptions> = {}) {
  const registry = new RuntimeRegistry();
  const calls = {start: [] as string[], refresh: [] as string[]};
  let startImpl: (instance: RuntimeInstance) => Promise<RuntimeInstance> = async instance =>
    registry.update(instance.instanceId, {status: 'healthy'});

  const supervisor = {
    start: async (instance: RuntimeInstance) => {
      calls.start.push(instance.instanceId);
      return startImpl(instance);
    },
    refresh: async (instanceId: string) => {
      calls.refresh.push(instanceId);
      return registry.require(instanceId);
    },
  };

  const resolvedOptions: HealthMonitorOptions = {
    healEnabled: true,
    intervalMs: 30_000,
    healCooldownMs: 0,
    healMaxFailures: 5,
    ...options,
  };
  const monitor = new HealthMonitor(registry, supervisor, resolvedOptions, createSilentLogger());

  return {
    registry,
    calls,
    monitor,
    failStart: (message: string) => {
      startImpl = async instance => {
        // 模拟 start 失败：registry 保持 error，抛错进 monitor 的熔断计数
        registry.update(instance.instanceId, {status: 'error', lastError: message});
        throw new Error(message);
      };
    },
  };
}

function addInstance(
  registry: RuntimeRegistry,
  instanceId: string,
  mode: 'managed' | 'attached',
  status: RuntimeInstance['status'],
  extra: Partial<RuntimeInstance> = {},
): void {
  registry.create({instanceId, source: 'api-runtime', mode, chromeLaunchArgs: []});
  registry.update(instanceId, {status, ...extra});
}

describe('HealthMonitor.tick', () => {
  test('healthy managed 实例每轮被主动 refresh', async () => {
    const {registry, calls, monitor} = createHarness();
    addInstance(registry, 'm1', 'managed', 'healthy', {browserUrl: 'http://127.0.0.1:1'});

    await monitor.tick();

    expect(calls.refresh).toEqual(['m1']);
    expect(calls.start).toEqual([]);
  });

  test('attached 实例只 refresh 不 start，回收边界不混淆', async () => {
    const {registry, calls, monitor} = createHarness();
    addInstance(registry, 'a1', 'attached', 'unhealthy', {browserUrl: 'http://127.0.0.1:1'});

    await monitor.tick();

    expect(calls.refresh).toEqual(['a1']);
    expect(calls.start).toEqual([]);
  });

  test('created/stopped 的 managed 实例不自动拉起（不替用户做启动决定）', async () => {
    const {registry, calls, monitor} = createHarness();
    addInstance(registry, 'c1', 'managed', 'created');
    addInstance(registry, 's1', 'managed', 'stopped');

    await monitor.tick();

    expect(calls.start).toEqual([]);
    expect(calls.refresh).toEqual([]);
  });

  test('error 的 managed 实例触发自动恢复，成功后状态变 healthy', async () => {
    const {registry, calls, monitor} = createHarness();
    addInstance(registry, 'dead', 'managed', 'error', {lastError: 'exited'});

    await monitor.tick();

    expect(calls.start).toEqual(['dead']);
    expect(registry.require('dead').status).toBe('healthy');
  });

  test('healEnabled=false 时只探测不恢复', async () => {
    const {registry, calls, monitor} = createHarness({healEnabled: false});
    addInstance(registry, 'dead', 'managed', 'error');

    await monitor.tick();

    expect(calls.start).toEqual([]);
  });

  test('冷却窗口内同一实例不重复自愈', async () => {
    const {registry, calls, monitor, failStart} = createHarness({healCooldownMs: 60_000});
    addInstance(registry, 'dead', 'managed', 'error');
    failStart('still broken');

    await monitor.tick(); // 第 1 次尝试（失败，计入冷却起点）
    await monitor.tick(); // 冷却窗口内 → 跳过
    await monitor.tick(); // 同上

    expect(calls.start).toEqual(['dead']);
  });

  test('连续失败达到上限后熔断，不再尝试', async () => {
    const {registry, calls, monitor, failStart} = createHarness({healMaxFailures: 3});
    addInstance(registry, 'dead', 'managed', 'error');
    failStart('spawn impossible');

    for (let i = 0; i < 6; i++) {
      await monitor.tick();
    }

    expect(calls.start).toHaveLength(3);
    expect(registry.require('dead').status).toBe('error');
  });

  test('tick 防重入：上一轮未结束时并发 tick 直接跳过', async () => {
    const {registry, calls, monitor} = createHarness();
    addInstance(registry, 'slow', 'managed', 'error');

    // tick() 入口同步置 #ticking=true，因此并发第二轮必被挡下，
    // 无需人为卡住 start——第一轮在微任务中尚未跑完时第二轮已返回。
    const first = monitor.tick();
    const second = monitor.tick();
    await Promise.all([first, second]);

    expect(calls.start.filter(id => id === 'slow')).toHaveLength(1);
  });
});
