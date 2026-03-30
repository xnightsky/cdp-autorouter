import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import {fetchJson} from './http-client.js';
import {RuntimeRegistry} from './runtime-registry.js';
import type {RuntimeInstance} from './types.js';

interface VersionPayload {
  Browser?: string;
  'Protocol-Version'?: string;
}

/**
 * Finds a free local TCP port for a managed browser instance.
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
 * Owns browser lifecycle operations for both managed and attached instances.
 *
 * - For `attached` instances it performs health refreshes and validation only.
 * - For `managed` instances it launches, tracks, and reclaims child browser
 *   processes as well as their active websocket proxy connections.
 */
export class ChildBrowserSupervisor {
  readonly #managedConnections = new Map<string, Set<import('ws').WebSocket>>();

  constructor(private readonly registry: RuntimeRegistry) {}

  /**
   * Brings an instance into a healthy, reachable state.
   */
  async start(instance: RuntimeInstance): Promise<RuntimeInstance> {
    if (instance.mode === 'attached') {
      if (!instance.browserUrl && !instance.wsEndpoint) {
        throw new Error(`Attached instance '${instance.instanceId}' requires browserUrl or wsEndpoint.`);
      }
      const next = this.registry.update(instance.instanceId, {status: 'starting'});
      return await this.refresh(next.instanceId);
    }

    const executablePath =
      instance.executablePath || process.env.CHROME_EXECUTABLE_PATH;
    if (!executablePath) {
      throw new Error(
        `Managed instance '${instance.instanceId}' requires executablePath or CHROME_EXECUTABLE_PATH.`,
      );
    }

    let userDataDir = instance.userDataDir;
    let autoCreatedUserDataDir = false;
    if (!userDataDir) {
      // Managed instances need an isolated profile directory so shutdown can
      // clean up all state created by autorouter itself.
      userDataDir = path.resolve('.tmp', `${instance.instanceId}-${Date.now()}`);
      await fs.mkdir(userDataDir, {recursive: true});
      autoCreatedUserDataDir = true;
    }

    const port = instance.remoteDebuggingPort ?? (await findAvailablePort());
    const args = [
      ...instance.chromeLaunchArgs,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      ...(instance.headless ? ['--headless=new'] : []),
    ];

    const child = spawn(executablePath, args, {
      stdio: 'ignore',
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const browserUrl = `http://127.0.0.1:${port}`;

    // We record the child process immediately so reclaim logic can still find
    // it even if the process exits before health checks complete.
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
      // Unexpected exits should mark the instance as unhealthy/error, but a
      // deliberate reclaim flow should settle in `stopped`.
      const current = this.registry.get(instance.instanceId);
      if (!current) {
        return;
      }
      this.registry.update(instance.instanceId, {
        status: current.status === 'reclaiming' ? 'stopped' : 'error',
        lastError:
          current.status === 'reclaiming'
            ? undefined
            : `Managed browser exited unexpectedly (code=${code}, signal=${signal}).`,
        managedProcess: undefined,
        managedProcessPid: undefined,
      });
    });

    return await this.waitUntilAvailable(instance.instanceId, browserUrl);
  }

  /**
   * Re-reads `/json/version` from the downstream browser and updates health
   * metadata in the registry.
   */
  async refresh(instanceId: string): Promise<RuntimeInstance> {
    const instance = this.registry.require(instanceId);
    const browserUrl = instance.browserUrl;
    if (!browserUrl) {
      throw new Error(`Instance '${instanceId}' has no browserUrl.`);
    }

    try {
      const version = await fetchJson<VersionPayload>(`${browserUrl}/json/version`);
      return this.registry.update(instanceId, {
        status: 'healthy',
        version: version.Browser,
        protocolVersion: version['Protocol-Version'],
        lastHeartbeatAt: new Date().toISOString(),
        lastError: undefined,
      });
    } catch (error) {
      return this.registry.update(instanceId, {
        status: 'unhealthy',
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stops a single instance and reclaims owned resources if necessary.
   */
  async stop(instanceId: string): Promise<void> {
    const instance = this.registry.require(instanceId);
    this.registry.update(instanceId, {status: 'reclaiming'});
    this.closeConnections(instanceId);

    if (instance.mode === 'managed' && instance.managedProcess) {
      await this.terminateProcess(instance.managedProcess);
      if (instance.autoCreatedUserDataDir && instance.userDataDir) {
        await fs.rm(instance.userDataDir, {recursive: true, force: true});
      }
    }

    this.registry.update(instanceId, {
      status: 'stopped',
      managedProcess: undefined,
      managedProcessPid: undefined,
    });
  }

  /**
   * Stops every managed instance currently known to the registry.
   */
  async reclaimManaged(): Promise<void> {
    const managedInstances = this.registry
      .list()
      .filter(instance => instance.mode === 'managed');

    for (const instance of managedInstances) {
      await this.stop(instance.instanceId);
    }
  }

  /**
   * Registers a proxied websocket connection so stop/reclaim can close it
   * before shutting down the managed browser.
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
   * Service-level shutdown hook. For v1 this is equivalent to reclaiming all
   * managed instances.
   */
  async shutdown(): Promise<void> {
    await this.reclaimManaged();
  }

  /**
   * Polls until a newly launched managed browser exposes `/json/version`.
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
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(`Managed instance '${instanceId}' did not become healthy in time at ${browserUrl}.`);
  }

  /**
   * Closes all proxied websocket connections associated with an instance.
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
   * Performs a best-effort graceful shutdown and falls back to SIGKILL if the
   * browser refuses to exit promptly.
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
