import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import {detectChromePath} from './detect-chrome.js';
import {fetchJson} from './http-client.js';
import {RuntimeRegistry} from './runtime-registry.js';
import type {Logger, RuntimeInstance} from './types.js';

interface VersionPayload {
  Browser?: string;
  'Protocol-Version'?: string;
}

/**
 * 为 managed 浏览器实例寻找一个可用的本地 TCP 端口。
 */
async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not allocate a port.'));
        return;
      }
      const port = address.port;
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.once('error', reject);
  });
}

/**
 * 负责 managed 和 attached 两种实例的浏览器生命周期操作。
 *
 * - 对 `attached` 实例仅做健康刷新和校验。
 * - 对 `managed` 实例负责启动、跟踪和回收子浏览器进程及其 WS 代理连接。
 */
export class ChildBrowserSupervisor {
  /** 按实例跟踪活跃 WS 代理 socket，stop() 时可统一关闭。 */
  readonly #managedConnections = new Map<string, Set<import('ws').WebSocket>>();

  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly logger?: Logger,
  ) {}

  /**
   * 将实例带入健康、可达状态。
   */
  async start(instance: RuntimeInstance): Promise<RuntimeInstance> {
    this.logger?.info('starting instance', {instanceId: instance.instanceId, mode: instance.mode});
    if (instance.mode === 'attached') {
      if (!instance.browserUrl && !instance.wsEndpoint) {
        throw new Error(`Attached instance '${instance.instanceId}' requires browserUrl or wsEndpoint.`);
      }
      const next = this.registry.update(instance.instanceId, {status: 'starting'});
      return await this.refresh(next.instanceId);
    }

    const executablePath =
      instance.executablePath || process.env.CHROME_EXECUTABLE_PATH || detectChromePath();
    if (!executablePath) {
      throw new Error(
        `Managed instance '${instance.instanceId}' requires executablePath or CHROME_EXECUTABLE_PATH (auto-detect also failed).`,
      );
    }
    this.logger?.info('using chrome executable', {instanceId: instance.instanceId, executablePath});

    let userDataDir = instance.userDataDir;
    let autoCreatedUserDataDir = false;
    if (!userDataDir) {
      // managed 实例需要隔离的 profile 目录，以便 shutdown 时能清理 autorouter 自己创建的所有状态。
      userDataDir = path.resolve('.tmp', `${instance.instanceId}-${Date.now()}`);
      await fs.mkdir(userDataDir, {recursive: true});
      autoCreatedUserDataDir = true;
    }

    const port = instance.remoteDebuggingPort ?? (await findAvailablePort());
    // Baseline args for all managed instances: suppress first-run UI that spawns
    // an extra welcome window (chrome://intro), which confuses process accounting.
    // Only injected when the executable looks like a Chrome/Chromium binary.
    const isChrome = /chrome|chromium/i.test(executablePath);
    const baselineArgs = isChrome ? ['--no-first-run', '--no-default-browser-check'] : [];
    const args = [
      ...baselineArgs,
      ...instance.chromeLaunchArgs,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      ...(instance.headless ? ['--headless=new'] : []),
    ];

    const child = spawn(executablePath, args, {
      stdio: 'ignore',
      windowsHide: instance.headless ?? false,
      detached: process.platform !== 'win32',
    });

    const browserUrl = `http://127.0.0.1:${port}`;

    // 立即记录子进程，这样即使进程在健康检查完成前退出，回收逻辑仍能定位到它。
    this.registry.update(instance.instanceId, {
      status: 'starting',
      managedProcess: child,
      managedProcessPid: child.pid,
      userDataDir,
      autoCreatedUserDataDir,
      browserUrl,
      lastError: undefined,
    });

    child.once('exit', (code, signal) => {
      // 区分 deliberate reclaim（预期退出）与 crash。
      const current = this.registry.get(instance.instanceId);
      if (!current) {
        return;
      }
      const isReclaiming = current.status === 'reclaiming';
      this.logger?.error('managed browser exited', {
        instanceId: instance.instanceId,
        code,
        signal,
        reclaiming: isReclaiming,
      });
      this.registry.update(instance.instanceId, {
        status: isReclaiming ? 'stopped' : 'error',
        lastError: isReclaiming
          ? undefined
          : `Managed browser exited unexpectedly (code=${code}, signal=${signal}).`,
        managedProcess: undefined,
        managedProcessPid: undefined,
      });
    });

    const result = await this.waitUntilAvailable(instance.instanceId, browserUrl);
    this.logger?.info('instance started', {instanceId: instance.instanceId, status: result.status});
    return result;
  }

  /**
   * 重新读取下游浏览器的 `/json/version` 并更新注册表中的健康元数据。
   */
  async refresh(instanceId: string): Promise<RuntimeInstance> {
    const instance = this.registry.require(instanceId);
    const browserUrl = instance.browserUrl;
    if (!browserUrl) {
      throw new Error(`Instance '${instanceId}' has no browserUrl.`);
    }

    try {
      const version = await fetchJson<VersionPayload>(`${browserUrl}/json/version`);
      this.logger?.debug('instance refreshed', {instanceId, status: 'healthy', version: version.Browser});
      return this.registry.update(instanceId, {
        status: 'healthy',
        version: version.Browser,
        protocolVersion: version['Protocol-Version'],
        lastHeartbeatAt: new Date().toISOString(),
        lastError: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn('instance refresh failed', {instanceId, error: message});
      return this.registry.update(instanceId, {
        status: 'unhealthy',
        lastError: message,
      });
    }
  }

  /**
   * 停止单个实例，必要时回收其拥有的资源。
   */
  async stop(instanceId: string): Promise<void> {
    this.logger?.info('stopping instance', {instanceId});
    const instance = this.registry.require(instanceId);
    // 在 kill 前先标记 reclaiming，让 exit handler 知道这是预期行为。
    this.registry.update(instanceId, {status: 'reclaiming'});
    this.closeConnections(instanceId);

    if (instance.mode === 'managed' && instance.managedProcess) {
      await this.terminateProcess(instance.managedProcess);
      // 只清理 autorouter 自己创建的目录，避免误删用户数据。
      if (instance.autoCreatedUserDataDir && instance.userDataDir) {
        await fs.rm(instance.userDataDir, {recursive: true, force: true});
      }
    }

    this.registry.update(instanceId, {
      status: 'stopped',
      managedProcess: undefined,
      managedProcessPid: undefined,
    });
    this.logger?.info('instance stopped', {instanceId});
  }

  /**
   * 停止注册表中当前所有 managed 实例。
   */
  async reclaimManaged(): Promise<void> {
    const managedInstances = this.registry
      .list()
      .filter(instance => instance.mode === 'managed');

    this.logger?.info('reclaiming managed instances', {count: managedInstances.length});

    for (const instance of managedInstances) {
      await this.stop(instance.instanceId);
    }
  }

  /**
   * 注册一条被代理的 websocket 连接，使 stop/reclaim 能在关闭 managed 浏览器前先断开它。
   */
  trackConnection(instanceId: string, socket: import('ws').WebSocket): void {
    const connections = this.#managedConnections.get(instanceId) ?? new Set();
    connections.add(socket);
    this.#managedConnections.set(instanceId, connections);
    socket.once('close', () => {
      connections.delete(socket);
      if (connections.size === 0) {
        this.#managedConnections.delete(instanceId);
      }
    });
  }

  /**
   * 服务级关闭钩子。v1 中等价于回收所有 managed 实例。
   */
  async shutdown(): Promise<void> {
    this.logger?.info('supervisor shutting down');
    await this.reclaimManaged();
  }

  /**
   * 轮询直到新启动的 managed 浏览器暴露 `/json/version`。
   */
  private async waitUntilAvailable(
    instanceId: string,
    browserUrl: string,
  ): Promise<RuntimeInstance> {
    const startedAt = Date.now();
    const timeoutMs = 15_000;

    while (Date.now() - startedAt < timeoutMs) {
      const refreshed = await this.refresh(instanceId);
      if (refreshed.status === 'healthy') {
        return refreshed;
      }
      // 每 250 ms 轮询一次——对快速启动够快，对下游浏览器未就绪时也不会过于频繁。
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    this.logger?.error('instance health check timed out', {instanceId, browserUrl});
    throw new Error(`Managed instance '${instanceId}' did not become healthy in time at ${browserUrl}.`);
  }

  /**
   * 关闭与某个实例关联的所有被代理 websocket 连接。
   */
  private closeConnections(instanceId: string): void {
    const connections = this.#managedConnections.get(instanceId);
    if (!connections) {
      return;
    }

    for (const socket of connections) {
      socket.close();
    }
    this.#managedConnections.delete(instanceId);
  }

  /**
   * 尽力优雅关闭，若浏览器拒绝及时退出则回退到 SIGKILL。
   */
  private async terminateProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) {
      return;
    }

    child.kill('SIGTERM');

    await Promise.race([
      new Promise<void>(resolve => {
        child.once('exit', () => resolve());
      }),
      new Promise<void>(resolve => {
        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
          }
          resolve();
        }, 3_000);
      }),
    ]);
  }
}
