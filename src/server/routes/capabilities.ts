import {compile} from '../routing/pattern.js';
import type {Route} from '../routing/route.js';

/** GET /api/capabilities — 服务元数据与端点发现。供上游客户端探测 autorouter 能力。 */
export function capabilitiesRoute(): Route {
  return {
    kind: 'http',
    methods: ['GET'],
    pattern: compile('/api/capabilities'),
    handle: (ctx, req, res) => {
      const host = ctx.resolvePublicHost(req);
      const payload = {
        name: 'cdp-autorouter',
        version: ctx.packageVersion,
        capabilities: {
          multiInstance: true,
          instanceRouting: true,
          defaultInstanceSwitch: true,
          managementApi: true,
          compatibilityMode: ctx.policy.compatModeEnabled,
          wsTokenIsolation: true,
          supportedModes: ['managed', 'attached'],
        },
        endpoints: {
          instances: `http://${host}/api/instances`,
          capabilities: `http://${host}/api/capabilities`,
        },
        runtime: {
          totalInstances: ctx.registry.list().length,
          defaultInstanceId: ctx.getDefaultInstanceId() ?? null,
        },
      };
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    },
  };
}
