/**
 * WebSocket upgrade 处理器：CDP 代理连接。
 *
 * 两条路由：
 * - `/devtools/:kind/:token`：默认实例
 * - `/instances/:instanceId/devtools/:kind/:token`：显式实例
 *
 * 关键流程：
 * 1. 验证 kind 必须是 'browser' 或 'page'
 * 2. token 必须在 bindings 中存在（由 rewriteVersion/rewriteList 签发）
 * 3. instanceId 匹配校验（防止跨实例 token 滥用）
 * 4. resolveInstance 确保实例可用
 * 5. handleUpgrade 后建立双向 message pump
 * 6. dispose 一次性清理（token 回收 + socket 关闭）
 */
import {WebSocket} from 'ws';

import {compile} from '../routing/pattern.js';
import type {Route} from '../routing/route.js';

export function wsUpgradeRoutes(): Route[] {
  return [
    buildWsRoute('/devtools/:kind/:token'),
    buildWsRoute('/instances/:instanceId/devtools/:kind/:token'),
  ];
}

function buildWsRoute(template: string): Route {
  return {
    kind: 'ws',
    pattern: compile(template),
    handle: async (ctx, req, socket, head, params) => {
      const kind = params.kind;
      const token = params.token;
      const rawInstanceId = params.instanceId;  // 根路径时为 undefined

      // kind 必须是 'browser' 或 'page'，其他值拒绝
      if (kind !== 'browser' && kind !== 'page') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // token 查找——每个 token 由 rewriteVersion 或 rewriteList 签发，一次性使用
      const binding = ctx.bindings.get(token);
      if (!binding || binding.kind !== kind) {
        ctx.logger.warn('ws token not found', {token, kind});
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      if (rawInstanceId && rawInstanceId !== binding.instanceId) {
        ctx.logger.warn('ws instance mismatch', {expected: binding.instanceId, received: rawInstanceId});
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      ctx.logger.info('ws connection', {instanceId: binding.instanceId, kind, token});
      await ctx.resolveInstance(binding.instanceId, 'ws');

      ctx.wsServer.handleUpgrade(req, socket as never, head, clientSocket => {
        // 建立下游连接，开始双向 message pump
        const downstreamSocket = new WebSocket(binding.downstreamWsUrl);
        ctx.activeSockets.add(clientSocket);
        ctx.supervisor.trackConnection(binding.instanceId, clientSocket);
        // 下游未 ready 时缓冲客户端消息，等 open 后 flush
        const pendingMessages: {data: Buffer; binary: boolean}[] = [];

        // 一次性清理：回收 token、关闭双端 socket。
        // 4 个 close + 4 个 error 监听都指向同一个 dispose，多次调用幂等。
        const dispose = () => {
          ctx.activeSockets.delete(clientSocket);
          ctx.bindings.delete(token);  // token 一次性回收，不可重用
          if (clientSocket.readyState < WebSocket.CLOSING) clientSocket.close();
          if (downstreamSocket.readyState < WebSocket.CLOSING) downstreamSocket.close();
        };

        // 客户端 → 下游：保持 binary 标志（修复 git 28b60e0 的 frame type 问题）
        clientSocket.on('message', (data, isBinary) => {
          if (downstreamSocket.readyState === WebSocket.OPEN) {
            downstreamSocket.send(data, {binary: isBinary});
          } else {
            pendingMessages.push({
              data: Buffer.isBuffer(data) ? data : Buffer.from(data.toString()),
              binary: isBinary,
            });
          }
        });
        // 下游 open 后 flush 缓冲消息
        downstreamSocket.on('open', () => {
          for (const msg of pendingMessages.splice(0)) {
            downstreamSocket.send(msg.data, {binary: msg.binary});
          }
        });
        // 下游 → 客户端：同样保持 binary 标志
        downstreamSocket.on('message', (data, isBinary) => {
          if (clientSocket.readyState === WebSocket.OPEN) {
            clientSocket.send(data, {binary: isBinary});
          }
        });
        clientSocket.on('close', dispose);
        downstreamSocket.on('close', dispose);
        clientSocket.on('error', dispose);
        downstreamSocket.on('error', dispose);
      });
    },
  };
}
