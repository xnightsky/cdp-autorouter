import {afterEach, describe, expect, test} from 'vitest';
import {WebSocket} from 'ws';

import {startMockChromeServer, type MockChromeServer} from './helpers/mockChromeServer.js';
import {createSilentLogger} from './helpers/mock-logger.js';
import {createAutorouterServer} from '../src/index.js';

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
});
