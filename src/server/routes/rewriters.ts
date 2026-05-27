/**
 * Chrome DevTools Protocol 端点的 URL 改写函数。
 *
 * 核心职责：确保真实 Chrome WebSocket 地址永远不对外暴露，
 * 所有连接都通过 autorouter 的 token 化 WS 代理路由。
 */
import {URL} from 'node:url';

import type {RouteBindingStore} from '../route-bindings.js';
import type {DefaultInstanceResolver} from '../default-instance-resolver.js';
import type {RuntimeRegistry} from '../runtime-registry.js';

/** 下游 `/json/version` 返回的最小字段集。 */
export interface VersionResponse {
  Browser?: string;
  'Protocol-Version'?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

/** 下游 `/json/list` 和 `/json` 返回的最小字段集。 */
export interface ListTarget {
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
  [key: string]: unknown;
}

/** 改写函数所需的上下文依赖（从 RouteContext 中提取的子集）。 */
export interface RewriteContext {
  bindings: RouteBindingStore;
  defaultResolver: DefaultInstanceResolver;
  registry: RuntimeRegistry;
  packageVersion: string;
  getDefaultInstanceId(): string | undefined;
}

/**
 * 改写 /json/version 负载：
 * 1. 将 webSocketDebuggerUrl 替换为 autorouter 的 token 化 WS 路径
 * 2. 注入 autorouter 元数据（版本、多实例能力、默认实例 ID）
 */
export function rewriteVersion(
  rctx: RewriteContext,
  payload: VersionResponse,
  requestHost: string,
  routeInstanceId?: string,
  bindingInstanceId?: string,
): VersionResponse & {autorouter: unknown} {
  const defaultInstanceId = rctx.getDefaultInstanceId() ?? null;
  const autorouterMeta = {
    name: 'cdp-autorouter',
    version: rctx.packageVersion,
    multiInstance: true,
    defaultInstanceId,
    capabilitiesEndpoint: `http://${requestHost}/api/capabilities`,
  };

  if (!payload.webSocketDebuggerUrl) {
    return {...payload, autorouter: autorouterMeta};
  }
  const binding = rctx.bindings.register(
    bindingInstanceId ?? rctx.defaultResolver.ensureDefaultInstance().instanceId,
    payload.webSocketDebuggerUrl,
    'browser',
  );
  const prefix = routeInstanceId ? `/instances/${routeInstanceId}` : '';
  return {
    ...payload,
    webSocketDebuggerUrl: `ws://${requestHost}${prefix}/devtools/browser/${binding.token}`,
    autorouter: autorouterMeta,
  };
}

/**
 * 改写 devtoolsFrontendUrl：将 ws/wss 查询参数指向 autorouter。
 * 同时处理绝对路径（http://host/devtools/...）和相对路径（/devtools/...）。
 */
export function rewriteDevtoolsFrontendUrl(
  originalUrl: string,
  requestHost: string,
  rewrittenWsUrl: string,
  instancePrefix: string,
): string {
  const isAbsolute = /^https?:\/\//i.test(originalUrl);
  const parsed = new URL(originalUrl, 'http://placeholder');

  if (parsed.pathname.startsWith('/devtools/')) {
    parsed.pathname = `${instancePrefix}${parsed.pathname}`;
  }

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
}

/**
 * 改写 /json/list（或 /json）返回的每个 target：
 * - webSocketDebuggerUrl → token 化 autorouter WS 路径
 * - devtoolsFrontendUrl → 指向 autorouter 的 host + token
 */
export function rewriteList(
  rctx: RewriteContext,
  payload: ListTarget[],
  requestHost: string,
  routeInstanceId?: string,
  bindingInstanceId?: string,
): ListTarget[] {
  const prefix = routeInstanceId ? `/instances/${routeInstanceId}` : '';
  return payload.map(entry => {
    if (!entry.webSocketDebuggerUrl) {
      return entry;
    }
    const binding = rctx.bindings.register(
      bindingInstanceId ?? rctx.defaultResolver.ensureDefaultInstance().instanceId,
      entry.webSocketDebuggerUrl,
      'page',
    );
    const rewrittenWsUrl = `ws://${requestHost}${prefix}/devtools/page/${binding.token}`;
    const result: ListTarget = {
      ...entry,
      webSocketDebuggerUrl: rewrittenWsUrl,
    };
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
}
