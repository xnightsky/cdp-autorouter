/**
 * Chrome Remote Debugging HTTP 兼容路由：/json/version, /json/list, /json, /json/protocol。
 *
 * 两条路由：
 * - 根路径 `/json/:suffix?`：代表默认实例
 * - 显式路径 `/instances/:id/json/:suffix?`：代表指定实例
 *
 * 自愈双触发（2026-09-20 起两条路径均享受，attached 仍只诊断不拉起）：
 * - Trigger A（主动）：resolveInstance 检测 managed 实例非 healthy，交 supervisor.start
 * - Trigger B（被动）：fetch 下游失败时，attached 返 503，managed 重拉一次
 */
import {compile} from '../routing/pattern.js';
import {HttpError, type Route, type RouteContext} from '../routing/route.js';
import type {RuntimeInstance} from '../types.js';
import {fetchJson} from '../http-client.js';
import {
  rewriteVersion,
  rewriteList,
  type RewriteContext,
  type VersionResponse,
  type ListTarget,
} from './rewriters.js';

function json(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

/** 从完整 RouteContext 中提取 rewriters 所需的子集。 */
function toRewriteCtx(ctx: RouteContext): RewriteContext {
  return {
    bindings: ctx.bindings,
    defaultResolver: ctx.defaultResolver,
    registry: ctx.registry,
    packageVersion: ctx.packageVersion,
    getDefaultInstanceId: () => ctx.getDefaultInstanceId(),
  };
}

/**
 * JSON 兼容路由：根路径 + 显式实例路径。
 * 两条路径均享受 managed self-heal（Trigger A/B）；attached 永不自动拉起，只返 503 诊断。
 */
export function jsonCompatRoutes(): Route[] {
  return [
    buildJsonRoute('/json/:suffix?'),
    buildJsonRoute('/instances/:instanceId/json/:suffix?'),
  ];
}

function buildJsonRoute(template: string): Route {
  return {
    kind: 'http',
    methods: ['GET'],
    pattern: compile(template),
    handle: async (ctx, req, res, params) => {
      const host = ctx.resolvePublicHost(req);
      const instanceId = params.instanceId;
      const suffix = params.suffix ? `/json/${params.suffix}` : '/json';

      const fetchAndRespond = async (resolved: RuntimeInstance): Promise<void> => {
        if (!resolved.browserUrl) {
          throw new HttpError(500, `Instance '${resolved.instanceId}' does not have browserUrl for HTTP compat.`);
        }
        const downstreamUrl = `${resolved.browserUrl}${suffix}`;
        const rctx = toRewriteCtx(ctx);
        if (suffix === '/json/version') {
          const version = await fetchJson<VersionResponse>(downstreamUrl);
          json(res, 200, rewriteVersion(rctx, version, host, instanceId, resolved.instanceId));
          return;
        }
        if (suffix === '/json/list' || suffix === '/json') {
          const list = await fetchJson<ListTarget[]>(downstreamUrl);
          ctx.registry.update(resolved.instanceId, {pageCount: list.length});
          json(res, 200, rewriteList(rctx, list, host, instanceId, resolved.instanceId));
          return;
        }
        const protocol = await fetchJson<unknown>(downstreamUrl);
        json(res, 200, protocol);
      };

      const instance = await ctx.resolveInstance(instanceId, 'http');
      try {
        await fetchAndRespond(instance);
        return;
      } catch (downstreamError: unknown) {
        // Trigger B：下游不可达，进入自愈流程（attached 内部走 503 诊断分支，不拉起）
        await handleSelfHeal(ctx, instance, downstreamError, fetchAndRespond);
      }
    },
  };
}

/**
 * Trigger B（被动 fallback）：下游不可达时的自愈逻辑。
 * - attached 模式：不擅自启动外部 chrome，直接返回 503 诊断信息
 * - managed 模式：supervisor.start 幂等清理 + spawn，然后 retry 一次
 */
async function handleSelfHeal(
  ctx: RouteContext,
  instance: RuntimeInstance,
  downstreamError: unknown,
  fetchAndRespond: (resolved: RuntimeInstance) => Promise<void>,
): Promise<void> {
  const reason = downstreamError instanceof Error ? downstreamError.message : String(downstreamError);
  ctx.logger.warn('lazy-probe detected unreachable upstream', {
    instanceId: instance.instanceId, mode: instance.mode, error: reason,
  });
  ctx.operationLogger.log('instance:self-heal', {
    instanceId: instance.instanceId, mode: instance.mode, trigger: 'B', error: reason,
  });

  if (instance.mode === 'attached') {
    // attached 不自愈：标记不健康，返回 503，不擅自启动外部浏览器
    ctx.registry.update(instance.instanceId, {status: 'unhealthy', lastError: reason});
    throw new HttpError(503, `attached upstream unreachable: ${reason}`);
  }

  // managed 自愈：标记 error 状态，然后 supervisor.start 幂等清理 + spawn，最后 retry 一次
  ctx.registry.update(instance.instanceId, {status: 'error', lastError: reason});
  let healed: RuntimeInstance;
  try {
    healed = await ctx.supervisor.start(ctx.registry.require(instance.instanceId));
  } catch (healError: unknown) {
    const msg = healError instanceof Error ? healError.message : String(healError);
    ctx.logger.error('route self-heal failed', {instanceId: instance.instanceId, error: msg});
    throw new HttpError(503, `instance '${instance.instanceId}' self-heal failed: ${msg}`);
  }
  try {
    await fetchAndRespond(healed);
  } catch (retryError: unknown) {
    const msg = retryError instanceof Error ? retryError.message : String(retryError);
    ctx.logger.error('route retry after self-heal failed', {instanceId: instance.instanceId, error: msg});
    throw new HttpError(503, `instance '${instance.instanceId}' unreachable after self-heal: ${msg}`);
  }
}
