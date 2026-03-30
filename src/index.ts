import http from 'node:http';
import {AddressInfo} from 'node:net';
import {URL} from 'node:url';

import {WebSocket, WebSocketServer} from 'ws';

import {ChildBrowserSupervisor} from './child-browser-supervisor.js';
import {loadEnvPolicy} from './config.js';
import {DefaultInstanceResolver} from './default-instance-resolver.js';
import {fetchJson} from './http-client.js';
import {RouteBindingStore} from './route-bindings.js';
import {RuntimeRegistry} from './runtime-registry.js';
import type {EnvPolicy, RuntimeInstance} from './types.js';

/**
 * Minimal shape used from downstream `/json/version`.
 */
interface VersionResponse {
  Browser?: string;
  'Protocol-Version'?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

/**
 * Minimal shape used from downstream `/json/list` and `/json`.
 */
interface ListTarget {
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

interface CreateServerOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * Converts a full runtime instance into the API payload we want to expose.
 *
 * In particular, this strips process handles and other non-serializable runtime
 * references that should never leak over HTTP.
 */
function serializeInstance(
  instance: RuntimeInstance,
  defaultInstanceId?: string,
) {
  return {
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
}

/**
 * Sends a JSON response with a stable content-type.
 */
function json(
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

/**
 * Sends a small structured error payload.
 */
function error(response: http.ServerResponse, statusCode: number, message: string): void {
  json(response, statusCode, {error: message});
}

/**
 * Reads and parses a JSON request body used by the Admin API.
 */
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
 * Builds the autorouter HTTP server, websocket proxy, runtime registry, and
 * shutdown hooks.
 *
 * The returned object is both the application entry point for tests and the
 * service bootstrap used by the CLI-style `node dist/index.js` start path.
 */
export async function createAutorouterServer(options: CreateServerOptions = {}) {
  const policy = loadEnvPolicy({...process.env, ...options.env});
  const registry = new RuntimeRegistry();
  const bindings = new RouteBindingStore();
  const supervisor = new ChildBrowserSupervisor(registry);
  const defaultResolver = new DefaultInstanceResolver(policy, registry);
  const wsServer = new WebSocketServer({noServer: true});

  const activeSockets = new Set<WebSocket>();

  /**
   * Resolves an instance for an HTTP or WS request and ensures it is usable.
   *
   * Root compat routes implicitly use the default instance. Explicit routes use
   * the registry entry named in the path. Newly created or stopped instances are
   * started lazily on demand.
   */
  const resolveInstance = async (
    instanceId?: string,
    method: 'http' | 'ws' = 'http',
  ): Promise<RuntimeInstance> => {
    let instance: RuntimeInstance;
    if (instanceId) {
      instance = registry.require(instanceId);
    } else {
      instance = defaultResolver.ensureDefaultInstance();
    }

    if (instance.status === 'created' || instance.status === 'stopped') {
      if (!instanceId && !policy.compatLazyLoadEnabled && method === 'http') {
        throw new Error('Default instance lazy load is disabled.');
      }
      instance = await supervisor.start(instance);
    } else if (instance.status !== 'healthy') {
      instance = await supervisor.refresh(instance.instanceId);
      if (instance.status !== 'healthy') {
        throw new Error(instance.lastError || `Instance '${instance.instanceId}' is not healthy.`);
      }
    }

    return instance;
  };

  /**
   * Rewrites the downstream browser websocket URL so clients connect back to
   * autorouter instead of connecting directly to the real Chrome instance.
   */
  const rewriteVersion = (
    payload: VersionResponse,
    requestHost: string,
    routeInstanceId?: string,
    bindingInstanceId?: string,
  ) => {
    if (!payload.webSocketDebuggerUrl) {
      return payload;
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
    };
  };

  /**
   * Rewrites each target websocket URL returned by `/json/list` or `/json`.
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
      return {
        ...entry,
        webSocketDebuggerUrl: `ws://${requestHost}${prefix}/devtools/page/${binding.token}`,
      };
    });
  };

  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? `${policy.serverHost}:${policy.serverPort}`;
      const url = new URL(request.url ?? '/', `http://${host}`);
      const path = url.pathname;
      const method = request.method ?? 'GET';

      // Admin API: returns the autorouter instance registry, not Chrome tabs.
      if (method === 'GET' && path === '/api/instances') {
        json(
          response,
          200,
          registry
            .list()
            .map(instance =>
              serializeInstance(instance, policy.defaultInstanceTemplate?.instanceId),
            ),
        );
        return;
      }

      // Admin API: runtime-only instance creation. Nothing here is persisted.
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
        json(response, 201, serializeInstance(instance, policy.defaultInstanceTemplate?.instanceId));
        return;
      }

      // Admin API: global reclaim entry point for managed browsers.
      if (method === 'POST' && path === '/api/instances/reclaim-managed') {
        await supervisor.reclaimManaged();
        json(response, 200, {reclaimed: true});
        return;
      }

      const instanceActionMatch = path.match(
        /^\/api\/instances\/([^/]+)(?:\/(start|stop|refresh|health|extensions))?$/,
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
              policy.defaultInstanceTemplate?.instanceId,
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
              policy.defaultInstanceTemplate?.instanceId,
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
              policy.defaultInstanceTemplate?.instanceId,
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
              policy.defaultInstanceTemplate?.instanceId,
            ),
          );
          return;
        }
        if (method === 'POST' && action === 'refresh') {
          json(
            response,
            200,
            serializeInstance(
              await supervisor.refresh(instanceId),
              policy.defaultInstanceTemplate?.instanceId,
            ),
          );
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
      }

      // HTTP compat routes that mimic Chrome remote debugging endpoints.
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

      error(response, 404, `Route not found: ${method} ${path}`);
    } catch (requestError) {
      error(
        response,
        500,
        requestError instanceof Error ? requestError.message : String(requestError),
      );
    }
  });

  server.on('upgrade', async (request, socket, head) => {
    try {
      const host = request.headers.host ?? `${policy.serverHost}:${policy.serverPort}`;
      const url = new URL(request.url ?? '/', `http://${host}`);
      const match = url.pathname.match(
        /^(?:\/instances\/([^/]+))?\/devtools\/(browser|page)\/([^/]+)$/,
      );

      if (!match) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // Every incoming WS token must have been minted earlier by rewriteVersion
      // or rewriteList; this is how we keep real Chrome WS URLs private.
      const [, rawInstanceId, kind, token] = match;
      const binding = bindings.get(token ?? '');
      if (!binding || binding.kind !== kind) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      if (rawInstanceId && decodeURIComponent(rawInstanceId) !== binding.instanceId) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      await resolveInstance(binding.instanceId, 'ws');

      wsServer.handleUpgrade(request, socket, head, clientSocket => {
        const downstreamSocket = new WebSocket(binding.downstreamWsUrl);
        activeSockets.add(clientSocket);
        supervisor.trackConnection(binding.instanceId, clientSocket);
        // Buffer early client messages until the downstream websocket is ready.
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
    } catch {
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
   * Shared shutdown path used by tests, CLI starts, and process signal hooks.
   */
  const shutdown = async () => {
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
  };

  const closeHandler = () => {
    void shutdown();
  };

  // v1 covers the most common service-exit cases so managed child browsers are
  // not left behind after local runs.
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
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await createAutorouterServer();
  process.stdout.write(`autorouter listening at ${server.origin}\n`);
}
