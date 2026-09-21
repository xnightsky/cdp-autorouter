import {spawn} from 'node:child_process';
import path from 'node:path';

import {afterEach, describe, expect, test} from 'vitest';

import {ChildBrowserSupervisor} from '../src/server/child-browser-supervisor.js';
import {createAutorouterServer} from '../src/server/index.js';
import {RuntimeRegistry} from '../src/server/runtime-registry.js';
import {createSilentLogger} from './helpers/mock-logger.js';

/**
 * Path to the mock managed browser stub used as a stand-in for chrome.exe.
 * It listens on `--remote-debugging-port=N` and serves /json/version etc.
 */
const MOCK_MANAGED = path.resolve('tests/fixtures/mock-managed-browser.cjs');

describe('ChildBrowserSupervisor.start L2 stale-process safety', () => {
  // L2 残留兜底：注入一个还活着的旧 child handle，调 start，断言它被 kill。
  // 这覆盖"start() 入口必须先清残留再 spawn 新进程"的不变量，
  // 防止 exit handler 串扰新实例（旧进程退出时把刚 healthy 的新实例打回 error）。
  test('kills stale managed process before spawning a new one', async () => {
    const registry = new RuntimeRegistry();
    const supervisor = new ChildBrowserSupervisor(registry, createSilentLogger(), 5_000);

    // 手动 spawn 一个"残留进程"——模拟上一次 start 出来现在已经被认为死了的 child。
    // 监听一个单独端口，避免和后续 start() 抢端口。
    const stale = spawn(process.execPath, [MOCK_MANAGED, '--remote-debugging-port=0'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    // 提前安装 exit 监听，后面需要 await 它真的退出。
    const staleExited = new Promise<void>(resolve => {
      stale.once('exit', () => resolve());
    });
    // 等 fork 起来再继续。
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(stale.exitCode).toBeNull();
    const stalePid = stale.pid;
    expect(typeof stalePid).toBe('number');

    // 注册一个 managed 实例，把"残留进程"挂在它身上。状态置为 error，触发 L2 路径。
    const created = registry.create({
      instanceId: 'recover-target',
      source: 'api-runtime',
      mode: 'managed',
      executablePath: process.execPath,
      chromeLaunchArgs: [MOCK_MANAGED],
    });
    registry.update(created.instanceId, {
      status: 'error',
      managedProcess: stale,
      managedProcessPid: stalePid,
      browserUrl: 'http://127.0.0.1:65535', // 死端口，确认 start 不会复用
      lastError: 'Simulated previous crash.',
    });

    // 调 start：内部应当先 kill 残留，再 spawn 新 child，最终 status=healthy。
    const started = await supervisor.start(registry.require(created.instanceId));

    try {
      expect(started.status).toBe('healthy');
      // 残留 PID 一定不是新 PID
      expect(started.managedProcessPid).not.toBe(stalePid);
      expect(typeof started.managedProcessPid).toBe('number');
      // 残留进程必须退出。用 staleExited 事件验证“退出事实”。
      // exitCode 在信号退出路径上会为 null（signal !== null），terminateProcess 兑底 SIGKILL 也走信号路径。
      // 4.5s 超时包住 supervisor 内 3s SIGKILL 兑底 + 事件传播。
      const exited = await Promise.race([
        staleExited.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 4_500)),
      ]);
      expect(exited).toBe(true);
    } finally {
      // 收拾新启动的进程
      await supervisor.stop(created.instanceId);
    }
  }, 20_000);
});

describe('ChildBrowserSupervisor exit handler 退出码分流', () => {
  // 用户手动关窗是"故意停止"而非事故：落 stopped，健康巡检不拉起，
  // 下次业务请求由 resolveInstance 懒启动。崩溃/外部 kill 仍落 error 交给巡检自愈。
  async function startMockManaged(instanceId: string) {
    const registry = new RuntimeRegistry();
    const supervisor = new ChildBrowserSupervisor(registry, createSilentLogger(), 5_000);
    const created = registry.create({
      instanceId,
      source: 'api-runtime',
      mode: 'managed',
      executablePath: process.execPath,
      chromeLaunchArgs: [MOCK_MANAGED],
    });
    const started = await supervisor.start(registry.require(created.instanceId));
    const exited = new Promise<void>(resolve => started.managedProcess!.once('exit', () => resolve()));
    return {registry, supervisor, started, exited};
  }

  test('优雅退出（code 0）标记 stopped 而非 error', async () => {
    const {registry, started, exited} = await startMockManaged('graceful-close');

    await fetch(`${started.browserUrl}/simulate-exit?code=0`);
    await exited;
    // exit handler 同步更新注册表，让出一个事件循环即可读到结果
    await new Promise(resolve => setImmediate(resolve));

    const after = registry.require(started.instanceId);
    expect(after.status).toBe('stopped');
    expect(after.lastError).toBeUndefined();
    expect(after.managedProcessPid).toBeUndefined();
  }, 20_000);

  test('非 0 退出（崩溃）仍标记 error，保留巡检自愈语义', async () => {
    const {registry, started, exited} = await startMockManaged('crash-exit');

    await fetch(`${started.browserUrl}/simulate-exit?code=1`);
    await exited;
    await new Promise(resolve => setImmediate(resolve));

    const after = registry.require(started.instanceId);
    expect(after.status).toBe('error');
    expect(after.lastError).toContain('exited unexpectedly');
    expect(after.managedProcessPid).toBeUndefined();
  }, 20_000);
});

describe('ChildBrowserSupervisor.killManagedChildrenSync（进程级崩溃兜底，D-3）', () => {
  // 崩溃钩子没有异步余地：同步 SIGKILL 还活着的 managed 子进程，防孤儿。
  test('kills live managed children synchronously and marks them error', async () => {
    const registry = new RuntimeRegistry();
    const supervisor = new ChildBrowserSupervisor(registry, createSilentLogger(), 5_000);

    const created = registry.create({
      instanceId: 'crash-victim',
      source: 'api-runtime',
      mode: 'managed',
      executablePath: process.execPath,
      chromeLaunchArgs: [MOCK_MANAGED],
    });
    const started = await supervisor.start(registry.require(created.instanceId));
    const pid = started.managedProcessPid!;
    const child = started.managedProcess!;
    const exited = new Promise<boolean>(resolve => child.once('exit', () => resolve(true)));

    supervisor.killManagedChildrenSync('process:uncaughtException');

    // 同步路径：调用返回时信号已发出；exit 事件确认死亡事实
    expect(await Promise.race([
      exited,
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3_000)),
    ])).toBe(true);
    const after = registry.require(created.instanceId);
    expect(after.status).toBe('error');
    expect(after.lastError).toContain('fatal process cleanup');
    expect(after.managedProcessPid).toBeUndefined();
    expect(pid).toBeGreaterThan(0);
  }, 20_000);
});

describe('fatal hooks 注册与清理', () => {
  // createAutorouterServer 注册 uncaughtException/unhandledRejection 钩子，
  // close() 必须移除——否则测试间/多 server 场景监听器累积。
  test('server registers fatal hooks on create and removes them on close', async () => {
    const beforeUncaught = process.listenerCount('uncaughtException');
    const beforeRejection = process.listenerCount('unhandledRejection');

    const server = await createAutorouterServer({
      env: {SERVER_HOST: '127.0.0.1', SERVER_PORT: '0'},
      logger: createSilentLogger(),
    });
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection + 1);

    await server.close();
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejection);
  }, 20_000);
});
