import http from 'node:http';

import {compile} from '../routing/pattern.js';
import type {Route, RouteContext} from '../routing/route.js';
import type {RuntimeInstance} from '../types.js';

// --- helpers ---

/** 发送 JSON 响应，Content-Type 固定为 application/json。 */
function json(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

/** 发送结构化错误负载。 */
function error(res: http.ServerResponse, statusCode: number, message: string): void {
  json(res, statusCode, {error: message});
}

/** 读取并解析 Admin API 使用的 JSON 请求体。 */
function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e: unknown) { reject(e); }
    });
    request.on('error', reject);
  });
}

/**
 * 将完整运行时实例转换为对外暴露的 API 负载。
 * 剥离进程句柄等不可序列化的运行时引用，防止通过 HTTP 泄漏。
 */
function serializeInstance(
  instance: RuntimeInstance,
  defaultInstanceId: string | undefined,
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
    pageCount: instance.pageCount,
    managedProcessPid: instance.managedProcessPid,
    userDataDir: instance.userDataDir,
    chromeLaunchArgs: instance.chromeLaunchArgs,
    isDefault: instance.instanceId === defaultInstanceId,
  };
  if (requestHost) {
    const prefix = `/instances/${instance.instanceId}`;
    base.instanceVersionUrl = `http://${requestHost}${prefix}/json/version`;
    base.browserWebSocketDebuggerUrl = `ws://${requestHost}${prefix}/devtools/browser`;
  }
  return base;
}

// --- route builders ---

/** GET /api/instances — 列出 autorouter 管理的实例（不是 Chrome targets）。 */
function listInstances(): Route {
  return {
    kind: 'http',
    methods: ['GET'],
    pattern: compile('/api/instances'),
    handle: async (ctx, req, res) => {
      const host = ctx.resolvePublicHost(req);
      const instances = ctx.registry.list();
      await Promise.all(
        instances
          .filter(i => (i.status === 'healthy' || i.status === 'unhealthy' || i.status === 'starting') && i.browserUrl)
          .map(i => ctx.supervisor.refresh(i.instanceId).catch(() => {})),
      );
      json(res, 200, ctx.registry.list().map(i => serializeInstance(i, ctx.getDefaultInstanceId(), host)));
    },
  };
}

/** POST /api/instances — 运行时注册新实例，不做持久化。 */
function createInstance(): Route {
  return {
    kind: 'http',
    methods: ['POST'],
    pattern: compile('/api/instances'),
    handle: async (ctx, req, res) => {
      const host = ctx.resolvePublicHost(req);
      const body = (await readJsonBody(req)) as Partial<RuntimeInstance>;
      if (!body.instanceId || !body.mode) {
        error(res, 400, 'instanceId and mode are required.');
        return;
      }
      const instance = ctx.registry.create({
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
      json(res, 201, serializeInstance(instance, ctx.getDefaultInstanceId(), host));
    },
  };
}

/** POST /api/instances/reclaim-managed — 统一回收所有 managed 浏览器。 */
function reclaimManaged(): Route {
  return {
    kind: 'http',
    methods: ['POST'],
    pattern: compile('/api/instances/reclaim-managed'),
    handle: async (ctx, _req, res) => {
      await ctx.supervisor.reclaimManaged();
      json(res, 200, {reclaimed: true});
    },
  };
}

/** /api/instances/:id/:action? — 单实例 CRUD + 生命周期操作（start/stop/restart/refresh/health/status/extensions/switch）。 */
function instanceActions(): Route {
  return {
    kind: 'http',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    pattern: compile('/api/instances/:id/:action?'),
    handle: async (ctx, req, res, params) => {
      const host = ctx.resolvePublicHost(req);
      const instanceId = params.id;
      const action = params.action;
      const method = req.method ?? 'GET';
      const ser = (i: RuntimeInstance) => serializeInstance(i, ctx.getDefaultInstanceId(), host);

      if (method === 'GET' && !action) {
        json(res, 200, ser(ctx.registry.require(instanceId)));
        return;
      }
      if (method === 'PATCH' && !action) {
        const body = (await readJsonBody(req)) as Partial<RuntimeInstance>;
        json(res, 200, ser(ctx.registry.update(instanceId, body)));
        return;
      }
      if (method === 'DELETE' && !action) {
        ctx.registry.delete(instanceId);
        json(res, 200, {deleted: true});
        return;
      }
      if (method === 'POST' && action === 'start') {
        json(res, 200, ser(await ctx.supervisor.start(ctx.registry.require(instanceId))));
        return;
      }
      if (method === 'POST' && action === 'stop') {
        await ctx.supervisor.stop(instanceId);
        json(res, 200, ser(ctx.registry.require(instanceId)));
        return;
      }
      if (method === 'POST' && action === 'restart') {
        await ctx.supervisor.stop(instanceId);
        const restarted = await ctx.supervisor.start(ctx.registry.require(instanceId));
        json(res, 200, ser(restarted));
        return;
      }
      if (method === 'POST' && action === 'refresh') {
        json(res, 200, ser(await ctx.supervisor.refresh(instanceId)));
        return;
      }
      if (method === 'GET' && action === 'status') {
        const inst = ctx.registry.require(instanceId);
        json(res, 200, {
          instanceId: inst.instanceId, status: inst.status,
          version: inst.version, protocolVersion: inst.protocolVersion,
          lastHeartbeatAt: inst.lastHeartbeatAt, lastError: inst.lastError,
        });
        return;
      }
      if (method === 'GET' && action === 'health') {
        const inst = ctx.registry.require(instanceId);
        json(res, 200, {
          instanceId: inst.instanceId, status: inst.status,
          lastHeartbeatAt: inst.lastHeartbeatAt, lastError: inst.lastError,
        });
        return;
      }
      if (method === 'GET' && action === 'extensions') {
        const inst = ctx.registry.require(instanceId);
        json(res, 200, {instanceId: inst.instanceId, extensions: inst.extensionsSummary});
        return;
      }
      if (method === 'POST' && action === 'switch') {
        const inst = ctx.registry.require(instanceId);
        if (inst.status !== 'healthy') {
          error(res, 409, `Cannot switch to instance '${instanceId}': status is '${inst.status}', must be 'healthy'.`);
          return;
        }
        ctx.setDefaultInstanceId(instanceId);
        json(res, 200, ser(inst));
        return;
      }
      // Unknown action — fall through to 404 in dispatcher
    },
  };
}

/**
 * 所有 Admin 实例路由，按注册顺序返回。
 * 顺序敏感：reclaim-managed 必须在 :id/:action? 之前，否则会被吹走。
 */
export function adminInstanceRoutes(): Route[] {
  return [
    listInstances(),
    createInstance(),
    reclaimManaged(),
    instanceActions(),
  ];
}
