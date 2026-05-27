import type http from 'node:http';

import {HttpError, type Method, type Route, type RouteContext} from './route.js';

/**
 * HTTP 请求分派器。
 *
 * 顺序遍历路由表，首个命中即终止（first-hit-wins）。
 * catch-all 路由（如 /devtools/*）必须注册在最后，否则会遮蔽具体路由。
 *
 * 错误处理：
 * - HttpError 携带明确状态码（如 503 自愈路径），原样转发
 * - 其余错误一律归为 500，仅输出 message，不泄露堆栈
 */
export async function dispatchHttp(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  routes: Route[],
): Promise<void> {
  const method = (req.method ?? 'GET') as Method;
  const host = ctx.resolvePublicHost(req);
  const url = new URL(req.url ?? '/', `http://${host}`);
  const path = url.pathname;

  try {
    for (const route of routes) {
      if (route.kind !== 'http') continue;  // 跳过 WS 路由
      if (!route.methods.includes(method)) continue;  // 方法不匹配
      const params = route.pattern.match(path);
      if (params === null) continue;  // 路径不匹配
      await route.handle(ctx, req, res, params);  // 命中，执行 handler
      return;
    }
    // No route matched
    ctx.logger.warn('route not found', {method, path});
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({error: `Route not found: ${method} ${path}`}));
  } catch (err: unknown) {
    // HttpError 携带明确状态码，其余归 500——保留 503/500 语义精度
    const status = err instanceof HttpError ? err.statusCode : 500;
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error('internal error', {path, status, error: message});
    if (!res.headersSent) {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({error: message}));
    }
  }
}
