import type http from 'node:http';
import type {Duplex} from 'node:stream';

import type {Route, RouteContext} from './route.js';

/**
 * WebSocket upgrade 分派器。
 *
 * 顺序遍历路由表中 kind=ws 的条目，首个命中即执行。
 * 未命中：写 404 + destroy。handler 报错：写 500 + destroy。
 */
export async function dispatchWs(
  ctx: RouteContext,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  routes: Route[],
): Promise<void> {
  const host = ctx.resolvePublicHost(req);
  const url = new URL(req.url ?? '/', `http://${host}`);
  const path = url.pathname;

  try {
    for (const route of routes) {
      if (route.kind !== 'ws') continue;
      const params = route.pattern.match(path);
      if (params === null) continue;
      await route.handle(ctx, req, socket, head, params);
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error('ws upgrade error', {error: message});
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
}
