import {spawn} from 'node:child_process';
import path from 'node:path';

import {afterEach, describe, expect, test} from 'vitest';

import {ChildBrowserSupervisor} from '../src/server/child-browser-supervisor.js';
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
