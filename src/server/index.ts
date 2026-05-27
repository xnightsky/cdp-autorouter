#!/usr/bin/env node
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import http from 'node:http';
import {AddressInfo} from 'node:net';

import {WebSocket, WebSocketServer} from 'ws';

import {ChildBrowserSupervisor} from './child-browser-supervisor.js';
import {loadEnvPolicy} from './config.js';
import {DefaultInstanceResolver} from './default-instance-resolver.js';
import {createLogger} from './logger.js';
import {RouteBindingStore} from './route-bindings.js';
import {RuntimeRegistry} from './runtime-registry.js';
import type {Logger, RuntimeInstance} from './types.js';

import {dispatchHttp} from './routing/dispatch-http.js';
import {dispatchWs} from './routing/dispatch-ws.js';
import type {Route, RouteContext} from './routing/route.js';

import {capabilitiesRoute} from './routes/capabilities.js';
import {adminInstanceRoutes} from './routes/admin-instances.js';
import {jsonCompatRoutes} from './routes/json-compat.js';
import {devtoolsProxyRoutes} from './routes/devtools-proxy.js';
import {wsUpgradeRoutes} from './routes/ws-upgrade.js';

function isMainModule(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  let metaPath: string;
  try { metaPath = realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
  let argvPath: string;
  try { argvPath = realpathSync(entryArg); }
  catch { return false; }
  return pathToFileURL(metaPath).href === pathToFileURL(argvPath).href;
}

/**
 * {@link createAutorouterServer} options.
 * `env` overrides process env (for tests). `logger` can be injected for silence.
 */
interface CreateServerOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

/**
 * Resolve the public-facing host for URL generation.
 * When trustProxy is enabled, prefers x-forwarded-host.
 */
function resolvePublicHost(
  request: http.IncomingMessage,
  policy: {trustProxy: boolean; serverHost: string; serverPort: number},
): string {
  if (policy.trustProxy) {
    const fwdHost = request.headers['x-forwarded-host'];
    if (fwdHost) {
      const host = Array.isArray(fwdHost) ? fwdHost[0] : fwdHost;
      const fwdPort = request.headers['x-forwarded-port'];
      const port = Array.isArray(fwdPort) ? fwdPort[0] : fwdPort;
      if (host.includes(':') || !port) return host;
      return `${host}:${port}`;
    }
  }
  return request.headers.host ?? `${policy.serverHost}:${policy.serverPort}`;
}

/**
 * 构建 autorouter HTTP+WS 服务器、运行时注册表和关闭钩子。
 *
 * 这是整个服务的 composition root：
 * 1. 装配所有依赖（policy/logger/registry/bindings/supervisor）
 * 2. 构建 RouteContext（所有 handler 共享的依赖容器）
 * 3. 注册路由表（HTTP + WS 共用同一张 Route[]）
 * 4. 启动 HTTP server + WS upgrade
 * 5. 注册进程信号钩子（SIGINT/SIGTERM/beforeExit）
 *
 * @param options - 可选的环境变量覆盖和 logger 注入。
 */
export async function createAutorouterServer(options: CreateServerOptions = {}) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const require = createRequire(import.meta.url);
  // 从包根目录读取版本号，用于元数据注入。源码和编译后的相对路径不同，因此尝试两个位置。
  let packageVersion = '0.0.0';
  try { ({version: packageVersion} = require(resolve(__dirname, '../../package.json'))); }
  catch { ({version: packageVersion} = require(resolve(__dirname, '../../../package.json'))); }

  const policy = loadEnvPolicy({...process.env, ...options.env});
  const logger = options.logger ?? createLogger({
    level: policy.logLevel, format: policy.logFormat, file: policy.logFile,
  });
  const registry = new RuntimeRegistry(logger);
  const bindings = new RouteBindingStore(logger);
  const supervisor = new ChildBrowserSupervisor(registry, logger, policy.restartTimeoutMs);
  const defaultResolver = new DefaultInstanceResolver(policy, registry, logger);
  const wsServer = new WebSocketServer({noServer: true});
  const activeSockets = new Set<WebSocket>();

  // 可变的默认实例 ID，初始值来自 env，运行时可通过 Admin API switch 命令切换。
  // 通过 ctx.getDefaultInstanceId/setDefaultInstanceId 暴露，保证单一来源。
  let currentDefaultInstanceId: string | undefined = policy.defaultInstanceTemplate?.instanceId;

  // --- resolveInstance：HTTP 和 WS handler 共享的实例解析逻辑 ---
  // 职责：根据 instanceId 查找或创建实例，确保其处于 healthy 状态。
  // 包含 Trigger A 主动 self-heal 逻辑（managed 默认实例非 healthy 时自动重拉）。
  const resolveInstance = async (
    instanceId?: string,
    method: 'http' | 'ws' = 'http',
  ): Promise<RuntimeInstance> => {
    logger.debug('resolving instance', {instanceId, method});
    let instance: RuntimeInstance;
    if (instanceId) {
      instance = registry.require(instanceId);
    } else {
      instance = defaultResolver.ensureDefaultInstance();
    }

    if (instance.status === 'created' || instance.status === 'stopped') {
      // 首次懒加载：实例还未启动，交给 supervisor 拉起
      if (!instanceId && !policy.compatLazyLoadEnabled && method === 'http') {
        logger.error('default instance lazy load disabled');
        throw new Error('Default instance lazy load is disabled.');
      }
      instance = await supervisor.start(instance);
    } else if (
      // Trigger A（主动 self-heal）：managed 默认实例非 healthy 时，交 supervisor.start 重拉。
      // inflight dedup 在 supervisor 内部处理，并发请求不会重复 spawn。
      instance.status !== 'healthy' &&
      instance.mode === 'managed' &&
      !instanceId
    ) {
      logger.info('default instance self-heal triggered', {
        instanceId: instance.instanceId,
        previousError: instance.lastError,
        previousStatus: instance.status,
      });
      instance = await supervisor.start(instance);
    } else if (instance.status !== 'healthy') {
      instance = await supervisor.refresh(instance.instanceId);
      if (instance.status !== 'healthy') {
        logger.error('instance not healthy', {instanceId: instance.instanceId, error: instance.lastError});
        throw new Error(instance.lastError || `Instance '${instance.instanceId}' is not healthy.`);
      }
    }
    logger.debug('instance resolved', {instanceId: instance.instanceId, status: instance.status});
    return instance;
  };

  // --- RouteContext：所有 handler 共享的依赖容器（单一来源） ---
  const ctx: RouteContext = {
    policy,
    logger,
    registry,
    bindings,
    supervisor,
    defaultResolver,
    packageVersion,
    activeSockets,
    wsServer,
    getDefaultInstanceId: () => currentDefaultInstanceId,
    setDefaultInstanceId: (id: string) => { currentDefaultInstanceId = id; },
    resolveInstance,
    resolvePublicHost: (req) => resolvePublicHost(req, policy),
  };

  // --- 路由表：顺序敏感，catch-all 必须在最后 ---
  const routes: Route[] = [
    capabilitiesRoute(),
    ...adminInstanceRoutes(),
    ...jsonCompatRoutes(),
    ...devtoolsProxyRoutes(),  // catch-all: must be after json-compat
    ...wsUpgradeRoutes(),
  ];

  // --- HTTP 服务器：请求通过 dispatchHttp/dispatchWs 分派到路由表 ---
  const server = http.createServer((req, res) => {
    void dispatchHttp(ctx, req, res, routes);
  });

  server.on('upgrade', (req, socket, head) => {
    void dispatchWs(ctx, req, socket, head, routes);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(policy.serverPort, policy.serverHost, () => resolve());
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo;
  const origin = `http://${address.address}:${address.port}`;

  // --- 关闭路径：顺序很重要 ---
  // 1. 关闭活跃 WS socket，让客户端收到干净断开
  // 2. 回收 managed 浏览器进程
  // 3. 停止接受新的 HTTP 连接
  // 4. 将待写入日志刷盘
  const shutdown = async () => {
    logger.info('shutting down');
    for (const socket of activeSockets) socket.close();
    await supervisor.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
    await logger.destroy();
  };

  const closeHandler = () => { void shutdown(); };
  process.once('SIGINT', closeHandler);
  process.once('SIGTERM', closeHandler);
  process.once('beforeExit', closeHandler);

  return {
    origin,
    close: async () => {
      process.removeListener('SIGINT', closeHandler);
      process.removeListener('SIGTERM', closeHandler);
      process.removeListener('beforeExit', closeHandler);
      await shutdown();
    },
    policy,
    registry,
    logger,
  };
}

async function killPortOccupant(port: number): Promise<void> {
  const {execSync} = await import('node:child_process');
  const red = process.stdout.hasColors?.() || process.env.FORCE_COLOR ? '\x1b[31m' : '';
  const reset = red ? '\x1b[0m' : '';
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, {encoding: 'utf8'});
      const pids = new Set<number>();
      for (const line of out.split('\n')) {
        if (/LISTENING/i.test(line)) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1] ?? '', 10);
          if (pid > 0) pids.add(pid);
        }
      }
      for (const pid of pids) {
        execSync(`taskkill /F /PID ${pid}`, {encoding: 'utf8'});
        process.stderr.write(`${red}[force] killed PID ${pid} on port ${port}${reset}\n`);
      }
    } else {
      const out = execSync(`lsof -ti tcp:${port}`, {encoding: 'utf8'}).trim();
      if (out) {
        execSync(`kill -9 ${out}`, {encoding: 'utf8'});
        process.stderr.write(`${red}[force] killed PID ${out} on port ${port}${reset}\n`);
      }
    }
  } catch { /* No process on port or kill failed */ }
}

if (isMainModule()) {
  const forceFlag = process.argv.includes('--force');
  const policy = loadEnvPolicy();
  if (forceFlag) await killPortOccupant(policy.serverPort);
  const server = await createAutorouterServer();
  server.logger.info(`autorouter listening at ${server.origin}`, {
    host: server.policy.serverHost,
    port: server.policy.serverPort,
    defaultInstanceId: server.policy.defaultInstanceTemplate?.instanceId,
    compatModeEnabled: server.policy.compatModeEnabled,
  });
}
