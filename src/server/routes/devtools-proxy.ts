/**
 * /devtools/* 透明 HTTP 反代（inspector.html 等静态资源）。
 *
 * 两条路由：
 * - `/devtools/*`：默认实例
 * - `/instances/:instanceId/devtools/*`：显式实例
 *
 * 流式转发：ReadableStream (web fetch) → Node writable (response)，
 * 带 drain backpressure 处理。hop-by-hop 头不转发（RFC 2616 §13.5.1）。
 */
import {compile} from '../routing/pattern.js';
import type {Route} from '../routing/route.js';

export function devtoolsProxyRoutes(): Route[] {
  return [
    buildProxyRoute('/devtools/*'),
    buildProxyRoute('/instances/:instanceId/devtools/*'),
  ];
}

function buildProxyRoute(template: string): Route {
  return {
    kind: 'http',
    methods: ['GET'],
    pattern: compile(template),
    handle: async (ctx, _req, res, params) => {
      const instanceId = params.instanceId;
      const downstreamPath = '/devtools/' + (params['*'] ?? '');
      const instance = await ctx.resolveInstance(instanceId, 'http');
      if (!instance.browserUrl) {
        throw new Error(`Instance '${instance.instanceId}' does not have browserUrl for proxy.`);
      }

      const downstreamUrl = `${instance.browserUrl}${downstreamPath}`;
      const upstream = await fetch(downstreamUrl);

      // hop-by-hop 头不得转发（RFC 2616 §13.5.1）
      const hopByHop = new Set([
        'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
        'te', 'trailer', 'transfer-encoding', 'upgrade',
      ]);

      res.statusCode = upstream.status;
      for (const [key, value] of upstream.headers.entries()) {
        if (!hopByHop.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      if (upstream.body) {
        // 流式转发：ReadableStream (web) → Node writable，带 drain backpressure
        const reader = upstream.body.getReader();
        const pump = async (): Promise<void> => {
          const {done, value: chunk} = await reader.read();
          if (done) { res.end(); return; }
          const canContinue = res.write(chunk);
          if (canContinue) return pump();
          return new Promise(resolve => {
            res.once('drain', () => resolve(pump()));
          });
        };
        await pump();
      } else {
        res.end();
      }
    },
  };
}
