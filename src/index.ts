import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import http from 'node:http';
import {AddressInfo} from 'node:net';
import {URL} from 'node:url';

import {WebSocket, WebSocketServer} from 'ws';

import {ChildBrowserSupervisor} from './child-browser-supervisor.js';
import {loadEnvPolicy} from './config.js';
import {DefaultInstanceResolver} from './default-instance-resolver.js';
import {fetchJson} from './http-client.js';
import {createLogger} from './logger.js';
import {RouteBindingStore} from './route-bindings.js';
import {RuntimeRegistry} from './runtime-registry.js';
import type {EnvPolicy, Logger, RuntimeInstance} from './types.js';

/** 从下游 `/json/version` 取出的最小字段集。 */
interface VersionResponse {
  Browser?: string;
  'Protocol-Version'?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

/** 从下游 `/json/list` 和 `/json` 取出的最小字段集。 */
interface ListTarget {
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
  [key: string]: unknown;
}

/**
 * {@link createAutorouterServer} 接受的选项。
 *
 * `env` 用于测试中覆盖进程环境变量。
 * `logger` 可注入，使测试保持静默且结果确定。
 */
interface CreateServerOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

function isMainModule(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }

  const entryUrl = new URL(`file://${entryArg.replace(/\\/g, '/')}`);
  return import.meta.url === entryUrl.href;
}

/**
 * 将完整运行时实例转换为对外暴露的 API 负载。
 *
 * 这里会剥离进程句柄等不可序列化的运行时引用，防止其通过 HTTP 泄漏。
 */
function serializeInstance(
  instance: RuntimeInstance,
  defaultInstanceId?: string,
  requestHost?: string,
) {
  const base: Record<string, unknown> = {
    instanceId: instance.instanceId,
    source: instance.source,
    mode: instance.mode,
    status: instance.status,
    browserUrl: instance.browserUrl,
    wsEndpoint: instance.wsEndpoint,
    version: instance.version,
    protocolVersion: instance.protocolVersion,
    extensionsSummary: instance.extensionsSummary,
    lastHeartbeatAt: instance.lastHeartbeatAt,
    lastError: instance.lastError,
    managedProcessPid: instance.managedProcessPid,
    userDataDir: instance.userDataDir,
    chromeLaunchArgs: instance.chromeLaunchArgs,
    isDefault: instance.instanceId === defaultInstanceId,
  };
  // P2-5: append connection metadata when request host is available
  if (requestHost) {
    const prefix = `/instances/${instance.instanceId}`;
    base.instanceVersionUrl = `http://${requestHost}${prefix}/json/version`;
    base.browserWebSocketDebuggerUrl = `ws://${requestHost}${prefix}/devtools/browser`;
  }
  return base;
}

/** 发送 JSON 响应，Content-Type 固定为 application/json。 */
function json(
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

/** 发送小型结构化错误负载。 */
function error(response: http.ServerResponse, statusCode: number, message: string): void {
  json(response, statusCode, {error: message});
}

/** 读取并解析 Admin API 使用的 JSON 请求体。 */
function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (bodyError) {
        reject(bodyError);
      }
    });
    request.on('error', reject);
  });
}

/**
 * Resolve the public-facing host for URL generation.
 *
 * When `trustProxy` is enabled, prefers `x-forwarded-host` (with optional
 * `x-forwarded-port` and `x-forwarded-proto` for ws/wss scheme inference).
 * Falls back to the `Host` header or server bind address.
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
      // If x-forwarded-host already includes port, use as-is
      if (host.includes(':') || !port) return host;
      return `${host}:${port}`;
    }
  }
  return request.headers.host ?? `${policy.serverHost}:${policy.serverPort}`;
}

/**
 * 构建 autorouter HTTP 服务器、WebSocket 代理、运行时注册表和关闭钩子。
 *
 * 返回的对象既是测试的入口点，也是 CLI 启动路径（`node dist/index.js`）使用的服务引导对象。
 *
 * @param options - 可选的环境变量覆盖和 logger 注入。
 */
export async function createAutorouterServer(options: CreateServerOptions = {}) {
  // Read package version once at startup for metadata injection.
  // Works from both src/ (vitest) and dist/src/ (production) by walking up to find package.json.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const require = createRequire(import.meta.url);
  // From src/index.ts → ../package.json; from dist/src/index.js → ../../package.json
  let packageVersion = '0.0.0';
  try {
    ({version: packageVersion} = require(resolve(__dirname, '../package.json')));
  } catch {
    ({version: packageVersion} = require(resolve(__dirname, '../../package.json')));
  }

  const policy = loadEnvPolicy({...process.env, ...options.env});

  // 使用注入的 logger，或根据 env policy 构建一个。
  // 测试中传入 silent logger，避免断言依赖 stderr 副作用。
  const logger = options.logger ?? createLogger({
    level: policy.logLevel,
    format: policy.logFormat,
    file: policy.logFile,
  });
  const registry = new RuntimeRegistry(logger);
  const bindings = new RouteBindingStore(logger);
  const supervisor = new ChildBrowserSupervisor(registry, logger);
  const defaultResolver = new DefaultInstanceResolver(policy, registry, logger);
  const wsServer = new WebSocketServer({noServer: true});

  const activeSockets = new Set<WebSocket>();

  // Mutable default instance ID — initially from env, switchable at runtime via Admin API.
  let currentDefaultInstanceId: string | undefined = policy.defaultInstanceTemplate?.instanceId;

  /**
   * 为 HTTP 或 WS 请求解析实例并确保其可用。
   *
   * 根路径兼容路由隐式使用默认实例；显式路由使用路径中指定的注册表项。
   * 新创建或已停止的实例会按需懒启动。
   */
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
      if (!instanceId && !policy.compatLazyLoadEnabled && method === 'http') {
        logger.error('default instance lazy load disabled');
        throw new Error('Default instance lazy load is disabled.');
      }
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

  /**
   * 改写下游浏览器 WebSocket URL，使客户端回连到 autorouter，
   * 而非直接连接到真实 Chrome 实例。
   */
  const rewriteVersion = (
    payload: VersionResponse,
    requestHost: string,
    routeInstanceId?: string,
    bindingInstanceId?: string,
  ) => {
    const defaultInstanceId = currentDefaultInstanceId ?? null;
    const autorouterMeta = {
      name: 'chrome-devtools-mcp-autorouter',
      version: packageVersion,
      multiInstance: true,
      defaultInstanceId,
      capabilitiesEndpoint: `http://${requestHost}/api/capabilities`,
    };

    if (!payload.webSocketDebuggerUrl) {
      return {...payload, autorouter: autorouterMeta};
    }
    const binding = bindings.register(
      bindingInstanceId ?? defaultResolver.ensureDefaultInstance().instanceId,
      payload.webSocketDebuggerUrl,
      'browser',
    );
    const prefix = routeInstanceId ? `/instances/${routeInstanceId}` : '';
    return {
      ...payload,
      webSocketDebuggerUrl: `ws://${requestHost}${prefix}/devtools/browser/${binding.token}`,
      autorouter: autorouterMeta,
    };
  };

  /**
   * Rewrite `devtoolsFrontendUrl` so that ws/wss query params point through autorouter.
   *
   * Handles both absolute (`http://host/devtools/...`) and relative (`/devtools/...`) formats.
   * The `ws` or `wss` query param is replaced with the already-tokenized WS URL (host-only, no scheme).
   */
  const rewriteDevtoolsFrontendUrl = (
    originalUrl: string,
    requestHost: string,
    rewrittenWsUrl: string,
    instancePrefix: string,
  ): string => {
    const isAbsolute = /^https?:\/\//i.test(originalUrl);
    const parsed = new URL(originalUrl, 'http://placeholder');

    // Rewrite pathname to include instance prefix if it starts with /devtools/
    if (parsed.pathname.startsWith('/devtools/')) {
      parsed.pathname = `${instancePrefix}${parsed.pathname}`;
    }

    // Replace ws/wss query param with the tokenized autorouter WS address
    const wsHost = rewrittenWsUrl.replace(/^wss?:\/\//, '');
    for (const key of ['ws', 'wss']) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, wsHost);
      }
    }

    if (isAbsolute) {
      parsed.protocol = 'http:';
      parsed.host = requestHost;
      return parsed.toString();
    }
    return `${parsed.pathname}${parsed.search}`;
  };

  /**
   * 改写 `/json/list` 或 `/json` 返回的每个目标 WebSocket URL 和 devtoolsFrontendUrl。
   */
  const rewriteList = (
    payload: ListTarget[],
    requestHost: string,
    routeInstanceId?: string,
    bindingInstanceId?: string,
  ) => {
    const prefix = routeInstanceId ? `/instances/${routeInstanceId}` : '';
    return payload.map(entry => {
      if (!entry.webSocketDebuggerUrl) {
        return entry;
      }
      const binding = bindings.register(
        bindingInstanceId ?? defaultResolver.ensureDefaultInstance().instanceId,
        entry.webSocketDebuggerUrl,
        'page',
      );
      const rewrittenWsUrl = `ws://${requestHost}${prefix}/devtools/page/${binding.token}`;
      const result: ListTarget = {
        ...entry,
        webSocketDebuggerUrl: rewrittenWsUrl,
      };
      // P1-3: rewrite devtoolsFrontendUrl to point through autorouter
      if (entry.devtoolsFrontendUrl) {
        result.devtoolsFrontendUrl = rewriteDevtoolsFrontendUrl(
          entry.devtoolsFrontendUrl,
          requestHost,
          rewrittenWsUrl,
          prefix,
        );
      }
      return result;
    });
  };

  const server = http.createServer(async (request, response) => {
    // 提前提取请求元数据，确保正常路径和 catch 块都能访问。
    const host = resolvePublicHost(request, policy);
    const url = new URL(request.url ?? '/', `http://${host}`);
    const path = url.pathname;
    const method = request.method ?? 'GET';

    try {
      logger.debug('processing request', {method, path});

      // Admin API: service capabilities and endpoint discovery.
      if (method === 'GET' && path === '/api/capabilities') {
        json(response, 200, {
          name: 'chrome-devtools-mcp-autorouter',
          version: packageVersion,
          capabilities: {
            multiInstance: true,
            instanceRouting: true,
            defaultInstanceSwitch: true,
            managementApi: true,
            compatibilityMode: policy.compatModeEnabled,
            wsTokenIsolation: true,
            supportedModes: ['managed', 'attached'],
          },
          endpoints: {
            instances: `http://${host}/api/instances`,
            capabilities: `http://${host}/api/capabilities`,
          },
          runtime: {
            totalInstances: registry.list().length,
            defaultInstanceId: currentDefaultInstanceId ?? null,
          },
        });
        return;
      }

      // Admin API：返回 autorouter 的实例注册表，而非 Chrome 标签页。
      if (method === 'GET' && path === '/api/instances') {
        json(
          response,
          200,
          registry
            .list()
            .map(instance =>
              serializeInstance(instance, currentDefaultInstanceId, host),
            ),
        );
        return;
      }

      // Admin API：仅运行时创建实例，不做持久化。
      if (method === 'POST' && path === '/api/instances') {
        const body = (await readJsonBody(request)) as Partial<RuntimeInstance>;
        if (!body.instanceId || !body.mode) {
          error(response, 400, 'instanceId and mode are required.');
          return;
        }
        const instance = registry.create({
          instanceId: body.instanceId,
          mode: body.mode,
          source: 'api-runtime',
          browserUrl: body.browserUrl,
          wsEndpoint: body.wsEndpoint,
          userDataDir: body.userDataDir,
          chromeLaunchArgs: body.chromeLaunchArgs ?? [],
          headless: body.headless,
          remoteDebuggingPort: body.remoteDebuggingPort,
          executablePath: body.executablePath,
        });
        json(response, 201, serializeInstance(instance, currentDefaultInstanceId, host));
        return;
      }

      // Admin API：managed 浏览器的全局回收入口。
      if (method === 'POST' && path === '/api/instances/reclaim-managed') {
        await supervisor.reclaimManaged();
        json(response, 200, {reclaimed: true});
        return;
      }

      const instanceActionMatch = path.match(
        /^\/api\/instances\/([^/]+)(?:\/(start|stop|restart|refresh|health|status|extensions|switch))?$/,
      );
      if (instanceActionMatch) {
        const [, rawInstanceId, action] = instanceActionMatch;
        const instanceId = decodeURIComponent(rawInstanceId ?? '');
        if (method === 'GET' && !action) {
          json(
            response,
            200,
            serializeInstance(
              registry.require(instanceId),
              currentDefaultInstanceId,
              host,
            ),
          );
          return;
        }
        if (method === 'PATCH' && !action) {
          const body = (await readJsonBody(request)) as Partial<RuntimeInstance>;
          json(
            response,
            200,
            serializeInstance(
              registry.update(instanceId, body),
              currentDefaultInstanceId,
              host,
            ),
          );
          return;
        }
        if (method === 'DELETE' && !action) {
          registry.delete(instanceId);
          json(response, 200, {deleted: true});
          return;
        }
        if (method === 'POST' && action === 'start') {
          json(
            response,
            200,
            serializeInstance(
              await supervisor.start(registry.require(instanceId)),
              currentDefaultInstanceId,
              host,
            ),
          );
          return;
        }
        if (method === 'POST' && action === 'stop') {
          await supervisor.stop(instanceId);
          json(
            response,
            200,
            serializeInstance(
              registry.require(instanceId),
              currentDefaultInstanceId,
              host,
            ),
          );
          return;
        }
        if (method === 'POST' && action === 'restart') {
          await supervisor.stop(instanceId);
          const restarted = await supervisor.start(registry.require(instanceId));
          json(response, 200, serializeInstance(restarted, currentDefaultInstanceId, host));
          return;
        }
        if (method === 'POST' && action === 'refresh') {
          json(
            response,
            200,
            serializeInstance(
              await supervisor.refresh(instanceId),
              currentDefaultInstanceId,
              host,
            ),
          );
          return;
        }
        if (method === 'GET' && action === 'status') {
          const instance = registry.require(instanceId);
          json(response, 200, {
            instanceId: instance.instanceId,
            status: instance.status,
            version: instance.version,
            protocolVersion: instance.protocolVersion,
            lastHeartbeatAt: instance.lastHeartbeatAt,
            lastError: instance.lastError,
          });
          return;
        }
        if (method === 'GET' && action === 'health') {
          const instance = registry.require(instanceId);
          json(response, 200, {
            instanceId: instance.instanceId,
            status: instance.status,
            lastHeartbeatAt: instance.lastHeartbeatAt,
            lastError: instance.lastError,
          });
          return;
        }
        if (method === 'GET' && action === 'extensions') {
          const instance = registry.require(instanceId);
          json(response, 200, {
            instanceId: instance.instanceId,
            extensions: instance.extensionsSummary,
          });
          return;
        }
        if (method === 'POST' && action === 'switch') {
          const instance = registry.require(instanceId);
          if (instance.status !== 'healthy') {
            error(response, 409, `Cannot switch to instance '${instanceId}': status is '${instance.status}', must be 'healthy'.`);
            return;
          }
          currentDefaultInstanceId = instanceId;
          json(response, 200, serializeInstance(instance, currentDefaultInstanceId, host));
          return;
        }
      }

      // HTTP 兼容路由：模拟 Chrome 远程调试端点。
      const compatMatch = path.match(
        /^(?:\/instances\/([^/]+))?(\/json(?:\/version|\/list|\/protocol)?|\/json)$/,
      );
      if (method === 'GET' && compatMatch) {
        const [, rawInstanceId, suffix] = compatMatch;
        const instanceId = rawInstanceId ? decodeURIComponent(rawInstanceId) : undefined;
        const instance = await resolveInstance(instanceId);
        if (!instance.browserUrl) {
          throw new Error(`Instance '${instance.instanceId}' does not have browserUrl for HTTP compat.`);
        }

        const downstreamUrl = `${instance.browserUrl}${suffix}`;
        if (suffix === '/json/version') {
          const version = await fetchJson<VersionResponse>(downstreamUrl);
          json(
            response,
            200,
            rewriteVersion(version, host, instanceId, instance.instanceId),
          );
          return;
        }

        if (suffix === '/json/list' || suffix === '/json') {
          const list = await fetchJson<ListTarget[]>(downstreamUrl);
          json(
            response,
            200,
            rewriteList(list, host, instanceId, instance.instanceId),
          );
          return;
        }

        const protocol = await fetchJson<unknown>(downstreamUrl);
        json(response, 200, protocol);
        return;
      }

      // 无路由匹配 —— 返回结构化 404，让调用方区分"未知端点"和"实例不存在"。
      logger.warn('route not found', {method, path});
      error(response, 404, `Route not found: ${method} ${path}`);
    } catch (requestError) {
      // 兜底：绝不向 HTTP 客户端泄漏堆栈跟踪。
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      logger.error('internal error', {path, error: message});
      error(response, 500, message);
    }
  });

  server.on('upgrade', async (request, socket, head) => {
    try {
      const host = resolvePublicHost(request, policy);
      const url = new URL(request.url ?? '/', `http://${host}`);
      const match = url.pathname.match(
        /^(?:\/instances\/([^/]+))?\/devtools\/(browser|page)\/([^/]+)$/,
      );

      if (!match) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // 每个入站 WS token 必须早前由 rewriteVersion 或 rewriteList 生成；
      // 这是保持真实 Chrome WS URL 不对外暴露的关键。
      const [, rawInstanceId, kind, token] = match;
      const binding = bindings.get(token ?? '');
      if (!binding || binding.kind !== kind) {
        logger.warn('ws token not found', {token, kind});
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      if (rawInstanceId && decodeURIComponent(rawInstanceId) !== binding.instanceId) {
        logger.warn('ws instance mismatch', {expected: binding.instanceId, received: rawInstanceId});
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      logger.info('ws connection', {instanceId: binding.instanceId, kind, token});
      await resolveInstance(binding.instanceId, 'ws');

      wsServer.handleUpgrade(request, socket, head, clientSocket => {
        const downstreamSocket = new WebSocket(binding.downstreamWsUrl);
        activeSockets.add(clientSocket);
        supervisor.trackConnection(binding.instanceId, clientSocket);
        // 在下游 WebSocket 就绪前缓冲客户端的早期消息。
        const pendingMessages: Buffer[] = [];

        const dispose = () => {
          activeSockets.delete(clientSocket);
          bindings.delete(token ?? '');
          if (clientSocket.readyState < WebSocket.CLOSING) {
            clientSocket.close();
          }
          if (downstreamSocket.readyState < WebSocket.CLOSING) {
            downstreamSocket.close();
          }
        };

        clientSocket.on('message', data => {
          if (downstreamSocket.readyState === WebSocket.OPEN) {
            downstreamSocket.send(data);
          } else {
            pendingMessages.push(
              Buffer.isBuffer(data) ? data : Buffer.from(data.toString()),
            );
          }
        });
        downstreamSocket.on('open', () => {
          for (const message of pendingMessages.splice(0)) {
            downstreamSocket.send(message);
          }
        });
        downstreamSocket.on('message', data => {
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(data);
          }
        });
        clientSocket.on('close', dispose);
        downstreamSocket.on('close', dispose);
        clientSocket.on('error', dispose);
        downstreamSocket.on('error', dispose);
      });
    } catch (upgradeError) {
      const message = upgradeError instanceof Error ? upgradeError.message : String(upgradeError);
      logger.error('ws upgrade error', {error: message});
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(policy.serverPort, policy.serverHost, () => resolve());
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo;
  const origin = `http://${address.address}:${address.port}`;

  /**
   * 测试、CLI 启动和进程信号钩子共享的关闭路径。
   *
   * 顺序很重要：
   * 1. 关闭活跃 WS socket，让客户端收到干净断开。
   * 2. 回收 managed 浏览器进程。
   * 3. 停止接受新的 HTTP 连接。
   * 4. 将待写入日志刷盘。
   */
  const shutdown = async () => {
    logger.info('shutting down');
    for (const socket of activeSockets) {
      socket.close();
    }
    await supervisor.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await logger.destroy();
  };

  const closeHandler = () => {
    void shutdown();
  };

  // v1 覆盖最常见的服务退出场景，防止本地运行后残留 managed 子浏览器。
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

if (isMainModule()) {
  const server = await createAutorouterServer();
  // 使用结构化日志打印启动横幅，使其在 JSON 模式下仍可被查询。
  server.logger.info(`autorouter listening at ${server.origin}`, {
    host: server.policy.serverHost,
    port: server.policy.serverPort,
    defaultInstanceId: server.policy.defaultInstanceTemplate?.instanceId,
    compatModeEnabled: server.policy.compatModeEnabled,
  });
}
