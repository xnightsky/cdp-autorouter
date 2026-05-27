import {afterEach, describe, expect, test} from 'vitest';
import {WebSocket} from 'ws';

import {startMockChromeServer, type MockChromeServer} from './helpers/mockChromeServer.js';
import {createSilentLogger} from './helpers/mock-logger.js';
import {createAutorouterServer} from '../src/server/index.js';

describe('HTTP compat proxy', () => {
  let chrome: MockChromeServer | undefined;
  let autorouter:
    | {
        close(): Promise<void>;
        origin: string;
      }
    | undefined;

  afterEach(async () => {
    await autorouter?.close();
    await chrome?.close();
    autorouter = undefined;
    chrome = undefined;
  });

  // 根路径兼容路由对上游客户端应表现得像单实例 Chrome 端点，即使中间有 autorouter。
  test('lazy bootstraps default instance and rewrites webSocketDebuggerUrl on /json/version', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'default',
        DEFAULT_INSTANCE_MODE: 'attached',
        DEFAULT_INSTANCE_BROWSER_URL: chrome.origin,
      },
      logger: createSilentLogger(),
    });

    const response = await fetch(`${autorouter.origin}/json/version`);

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      webSocketDebuggerUrl: string;
      Browser: string;
    };

    expect(payload.Browser).toBe('Chrome/123.0.0.0');
    expect(payload.webSocketDebuggerUrl).toMatch(
      /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/.+$/,
    );
    expect(payload.webSocketDebuggerUrl).not.toContain('9222');

    // P1-4: autorouter metadata injection
    const meta = (payload as Record<string, unknown>).autorouter as {
      name: string;
      version: string;
      multiInstance: boolean;
      defaultInstanceId: string | null;
      capabilitiesEndpoint: string;
    };
    expect(meta).toBeDefined();
    expect(meta.name).toBe('cdp-autorouter');
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta.multiInstance).toBe(true);
    expect(meta.defaultInstanceId).toBe('default');
    expect(meta.capabilitiesEndpoint).toMatch(/\/api\/capabilities$/);
  });

  // P2-1: GET /api/capabilities returns service metadata and endpoint discovery.
  test('GET /api/capabilities returns service metadata', async () => {
    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'main',
      },
      logger: createSilentLogger(),
    });

    const response = await fetch(`${autorouter.origin}/api/capabilities`);
    expect(response.status).toBe(200);

    const caps = (await response.json()) as Record<string, unknown>;
    expect(caps.name).toBe('cdp-autorouter');
    expect(caps.version).toMatch(/^\d+\.\d+\.\d+/);
    expect((caps.capabilities as Record<string, unknown>).multiInstance).toBe(true);
    expect((caps.capabilities as Record<string, unknown>).wsTokenIsolation).toBe(true);
    expect((caps.capabilities as Record<string, unknown>).supportedModes).toEqual(['managed', 'attached']);
    expect((caps.endpoints as Record<string, unknown>).instances).toMatch(/\/api\/instances$/);
    expect((caps.runtime as Record<string, unknown>).defaultInstanceId).toBe('main');
  });

  // P1-2: reverse proxy headers are respected when TRUST_PROXY is enabled.
  test('uses x-forwarded-host when TRUST_PROXY is enabled', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        TRUST_PROXY: 'true',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'default',
        DEFAULT_INSTANCE_MODE: 'attached',
        DEFAULT_INSTANCE_BROWSER_URL: chrome.origin,
      },
      logger: createSilentLogger(),
    });

    const response = await fetch(`${autorouter.origin}/json/version`, {
      headers: {'x-forwarded-host': 'public.example.com:443'},
    });
    const payload = (await response.json()) as {webSocketDebuggerUrl: string; autorouter: {capabilitiesEndpoint: string}};

    expect(payload.webSocketDebuggerUrl).toContain('public.example.com:443');
    expect(payload.autorouter.capabilitiesEndpoint).toContain('public.example.com:443');
  });

  // 保护设计阶段曾混淆的 API 边界：Admin API 列出的是 autorouter 实例，不是 Chrome 页面。
  test('GET /api/instances returns autorouter instances instead of chrome pages', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'default',
        DEFAULT_INSTANCE_MODE: 'attached',
        DEFAULT_INSTANCE_BROWSER_URL: chrome.origin,
      },
      logger: createSilentLogger(),
    });

    await fetch(`${autorouter.origin}/json/version`);
    const response = await fetch(`${autorouter.origin}/api/instances`);

    expect(response.status).toBe(200);

    const payload = (await response.json()) as Array<{
      instanceId: string;
      source: string;
      status: string;
    }>;

    expect(payload).toHaveLength(1);
    expect(payload[0]?.instanceId).toBe('default');
    expect(payload[0]?.source).toBe('env-bootstrap');
    expect(payload[0]?.status).toBe('healthy');
  });

  // 一次成功的 echo 往返证明 autorouter（而非调用方）掌控了 CDP websocket 这一跳。
  test('proxies browser websocket traffic through autorouter', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'default',
        DEFAULT_INSTANCE_MODE: 'attached',
        DEFAULT_INSTANCE_BROWSER_URL: chrome.origin,
      },
      logger: createSilentLogger(),
    });

    const versionResponse = await fetch(`${autorouter.origin}/json/version`);
    const versionPayload = (await versionResponse.json()) as {
      webSocketDebuggerUrl: string;
    };

    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(versionPayload.webSocketDebuggerUrl);

      socket.once('open', () => {
        socket.send('ping');
      });
      socket.once('message', payload => {
        resolve(payload.toString());
        socket.close();
      });
      socket.once('error', reject);
    });

    expect(message).toBe('echo:ping');
  });

  // managed 实例必须能被按需回收，防止服务留下自己启动的浏览器子进程。
  test('reclaims managed browser processes through Admin API', async () => {
    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
      },
      logger: createSilentLogger(),
    });

    const createResponse = await fetch(`${autorouter.origin}/api/instances`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        instanceId: 'managed-one',
        mode: 'managed',
        executablePath: process.execPath,
        chromeLaunchArgs: ['tests/fixtures/mock-managed-browser.cjs'],
      }),
    });
    expect(createResponse.status).toBe(201);

    const startResponse = await fetch(
      `${autorouter.origin}/api/instances/managed-one/start`,
      {
        method: 'POST',
      },
    );
    expect(startResponse.status).toBe(200);

    const startedInstance = (await startResponse.json()) as {
      status: string;
      managedProcessPid: number;
    };

    expect(startedInstance.status).toBe('healthy');
    expect(startedInstance.managedProcessPid).toBeTypeOf('number');

    process.kill(startedInstance.managedProcessPid, 0);

    const reclaimResponse = await fetch(
      `${autorouter.origin}/api/instances/reclaim-managed`,
      {
        method: 'POST',
      },
    );
    expect(reclaimResponse.status).toBe(200);

    const instancesResponse = await fetch(`${autorouter.origin}/api/instances`);
    const instances = (await instancesResponse.json()) as Array<{
      instanceId: string;
      status: string;
    }>;
    expect(
      instances.find(instance => instance.instanceId === 'managed-one')?.status,
    ).toBe('stopped');

    let killed = false;
    try {
      process.kill(startedInstance.managedProcessPid, 0);
    } catch {
      killed = true;
    }
    expect(killed).toBe(true);
  });

  // 显式实例路径是多实例逃生舱口，必须独立于默认的根路径兼容路由。
  test('serves explicit-instance compat routes independently from default route', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
      },
      logger: createSilentLogger(),
    });

    const createResponse = await fetch(`${autorouter.origin}/api/instances`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        instanceId: 'alpha',
        mode: 'attached',
        browserUrl: chrome.origin,
      }),
    });
    expect(createResponse.status).toBe(201);

    const response = await fetch(
      `${autorouter.origin}/instances/alpha/json/version`,
    );

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      webSocketDebuggerUrl: string;
    };

    expect(payload.webSocketDebuggerUrl).toMatch(
      /^ws:\/\/127\.0\.0\.1:\d+\/instances\/alpha\/devtools\/browser\/.+$/,
    );
  });

  // P1-3: devtoolsFrontendUrl must be rewritten to point through autorouter.
  test('rewrites devtoolsFrontendUrl in /json/list to use autorouter host and token', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'default',
        DEFAULT_INSTANCE_MODE: 'attached',
        DEFAULT_INSTANCE_BROWSER_URL: chrome.origin,
      },
      logger: createSilentLogger(),
    });

    const response = await fetch(`${autorouter.origin}/json/list`);
    expect(response.status).toBe(200);

    const list = (await response.json()) as Array<{
      webSocketDebuggerUrl: string;
      devtoolsFrontendUrl: string;
    }>;

    expect(list.length).toBeGreaterThan(0);
    const target = list[0];

    // devtoolsFrontendUrl should point to autorouter, not downstream Chrome
    expect(target.devtoolsFrontendUrl).not.toContain('9222');
    expect(target.devtoolsFrontendUrl).toMatch(/127\.0\.0\.1:\d+/);
    // ws query param should contain the tokenized path (URL-encoded)
    expect(target.devtoolsFrontendUrl).toMatch(/ws=127\.0\.0\.1%3A\d+%2Fdevtools%2Fpage%2F/);
    // Should not expose the original mock-page-id
    expect(target.devtoolsFrontendUrl).not.toContain('mock-page-id');
  });

  // P2-3: POST /api/instances/{id}/switch changes the default instance.
  test('switches default instance via Admin API', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'original',
        DEFAULT_INSTANCE_MODE: 'attached',
        DEFAULT_INSTANCE_BROWSER_URL: chrome.origin,
      },
      logger: createSilentLogger(),
    });

    // Create a second instance and start it
    await fetch(`${autorouter.origin}/api/instances`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({instanceId: 'second', mode: 'attached', browserUrl: chrome.origin}),
    });
    await fetch(`${autorouter.origin}/api/instances/second/start`, {method: 'POST'});

    // Switch default to 'second'
    const switchRes = await fetch(`${autorouter.origin}/api/instances/second/switch`, {method: 'POST'});
    expect(switchRes.status).toBe(200);
    const switched = (await switchRes.json()) as {isDefault: boolean};
    expect(switched.isDefault).toBe(true);

    // Verify capabilities now reports 'second' as default
    const capsRes = await fetch(`${autorouter.origin}/api/capabilities`);
    const caps = (await capsRes.json()) as {runtime: {defaultInstanceId: string}};
    expect(caps.runtime.defaultInstanceId).toBe('second');
  });

  // P2-5: instance list includes connection metadata URLs.
  test('GET /api/instances includes instanceVersionUrl and browserWebSocketDebuggerUrl', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'default',
        DEFAULT_INSTANCE_MODE: 'attached',
        DEFAULT_INSTANCE_BROWSER_URL: chrome.origin,
      },
      logger: createSilentLogger(),
    });

    // Trigger lazy bootstrap
    await fetch(`${autorouter.origin}/json/version`);

    const response = await fetch(`${autorouter.origin}/api/instances`);
    const list = (await response.json()) as Array<{
      instanceId: string;
      instanceVersionUrl: string;
      browserWebSocketDebuggerUrl: string;
    }>;

    expect(list[0].instanceVersionUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/instances\/default\/json\/version$/,
    );
    expect(list[0].browserWebSocketDebuggerUrl).toMatch(
      /^ws:\/\/127\.0\.0\.1:\d+\/instances\/default\/devtools\/browser$/,
    );
  });

  // P1-5: non-JSON paths are transparently proxied to downstream Chrome.
  test('proxies /devtools/* static assets transparently', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'default',
        DEFAULT_INSTANCE_MODE: 'attached',
        DEFAULT_INSTANCE_BROWSER_URL: chrome.origin,
      },
      logger: createSilentLogger(),
    });

    const response = await fetch(`${autorouter.origin}/devtools/inspector.html`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body).toContain('devtools-mock');
  });

  // P2-6: attached default 上游 chrome 在请求之间被外部关闭 → 下次根路径请求应返回 503，
  // 伴随明确的诊断信息。autorouter 不擅自启动外部 chrome。
  test('attached default returns 503 when upstream is unreachable on default route', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'default',
        DEFAULT_INSTANCE_MODE: 'attached',
        DEFAULT_INSTANCE_BROWSER_URL: chrome.origin,
      },
      logger: createSilentLogger(),
    });

    // 首次请求走顺 → 200
    const ok = await fetch(`${autorouter.origin}/json/version`);
    expect(ok.status).toBe(200);

    // 外部 chrome 被关
    await chrome.close();
    chrome = undefined;

    // 下次请求应该 503，体现 attached 不自愈、有诊断语义
    const dead = await fetch(`${autorouter.origin}/json/version`);
    expect(dead.status).toBe(503);
    const payload = (await dead.json()) as {error: string};
    expect(payload.error).toMatch(/attached upstream unreachable/);
  });

  // P2-6: 显式实例路径 不享受探死与自愈：attached 外部不可达仍应返 500，
  // 要求开发者允诸手动 restart。锁住路径范围语义不被意外扩展。
  test('explicit instance route does not self-heal: attached unreachable returns 500', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
      },
      logger: createSilentLogger(),
    });

    const create = await fetch(`${autorouter.origin}/api/instances`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({instanceId: 'alpha', mode: 'attached', browserUrl: chrome.origin}),
    });
    expect(create.status).toBe(201);

    // 首次走顺
    const ok = await fetch(`${autorouter.origin}/instances/alpha/json/version`);
    expect(ok.status).toBe(200);

    await chrome.close();
    chrome = undefined;

    const dead = await fetch(`${autorouter.origin}/instances/alpha/json/version`);
    // 显式路径不自愈：fetch 错误不被包为 HttpError(503)，走兑底 catch 返回 500。
    expect(dead.status).toBe(500);
  });

  // P2-6: managed default 子进程被外部 kill 后，下次根路径请求应自愈 → 200，
  // 且 PID 实际发生了变化（证明真的 spawn 了新进程）。
  test('managed default self-heals on root route after child process is killed', async () => {
    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'default',
        DEFAULT_INSTANCE_MODE: 'managed',
        DEFAULT_INSTANCE_EXECUTABLE_PATH: process.execPath,
        DEFAULT_INSTANCE_CHROME_ARGS: 'tests/fixtures/mock-managed-browser.cjs',
      },
      logger: createSilentLogger(),
    });

    // 首次请求 → 懒加载 + start → 200
    const first = await fetch(`${autorouter.origin}/json/version`);
    expect(first.status).toBe(200);

    // 取出实际 PID，后面验证进程身份产生换代
    const before = (await (await fetch(`${autorouter.origin}/api/instances`)).json()) as Array<{
      instanceId: string;
      managedProcessPid: number;
    }>;
    const oldPid = before.find(i => i.instanceId === 'default')!.managedProcessPid;
    expect(typeof oldPid).toBe('number');

    // 外部 kill。SIGKILL 避免 mock-managed 依赖优雅关闭逻辑被跳过。
    process.kill(oldPid, 'SIGKILL');

    // 给 exit handler 一个 tick，让它将 status 打为 error。
    await new Promise(resolve => setTimeout(resolve, 200));

    // 下次根路径请求 → 懒探死 → supervisor.start 重拉 → retry → 200
    const healed = await fetch(`${autorouter.origin}/json/version`);
    expect(healed.status).toBe(200);

    const after = (await (await fetch(`${autorouter.origin}/api/instances`)).json()) as Array<{
      instanceId: string;
      managedProcessPid: number;
      status: string;
    }>;
    const entry = after.find(i => i.instanceId === 'default')!;
    expect(entry.status).toBe('healthy');
    expect(entry.managedProcessPid).not.toBe(oldPid);
    expect(typeof entry.managedProcessPid).toBe('number');
  }, 20_000);

  // P2-6 (并发去重): managed default 被 kill 后并发多路请求，仅 spawn 一个新进程。
  // 验证手段：所有响应以 200 返回，且实例最终 PID 唯一。如果 spawn 了多个，
  // 最后一个存活的 PID 在 race 中随机，不可能稳定达到 healthy；与此同时多余的 spawn
  // 会产生孤儿进程，被 inflight 去重防得住。
  test('concurrent default-route requests deduplicate to a single spawn', async () => {
    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
        DEFAULT_INSTANCE_ID: 'default',
        DEFAULT_INSTANCE_MODE: 'managed',
        DEFAULT_INSTANCE_EXECUTABLE_PATH: process.execPath,
        DEFAULT_INSTANCE_CHROME_ARGS: 'tests/fixtures/mock-managed-browser.cjs',
      },
      logger: createSilentLogger(),
    });

    // 先 lazy bootstrap
    expect((await fetch(`${autorouter.origin}/json/version`)).status).toBe(200);

    const before = (await (await fetch(`${autorouter.origin}/api/instances`)).json()) as Array<{
      instanceId: string;
      managedProcessPid: number;
    }>;
    const oldPid = before.find(i => i.instanceId === 'default')!.managedProcessPid;
    process.kill(oldPid, 'SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 200));

    // 同时发 5 个请求
    const origin = autorouter.origin;
    const responses = await Promise.all(
      Array.from({length: 5}, () => fetch(`${origin}/json/version`)),
    );
    for (const r of responses) {
      expect(r.status).toBe(200);
    }

    const after = (await (await fetch(`${autorouter.origin}/api/instances`)).json()) as Array<{
      instanceId: string;
      managedProcessPid: number;
      status: string;
    }>;
    const entry = after.find(i => i.instanceId === 'default')!;
    expect(entry.status).toBe('healthy');
    expect(entry.managedProcessPid).not.toBe(oldPid);
  }, 20_000);
});
