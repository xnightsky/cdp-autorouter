import {afterEach, describe, expect, test} from 'vitest';
import {WebSocket} from 'ws';

import {startMockChromeServer, type MockChromeServer} from './helpers/mockChromeServer.js';
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

  // Root compat routes should feel like a single-instance Chrome endpoint to
  // upstream clients even though autorouter sits in the middle.
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

  // This test protects the API boundary that confused us during design: Admin
  // API lists autorouter instances, not Chrome pages.
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

  // A successful echo round-trip proves that autorouter, not the caller, owns
  // the CDP websocket hop.
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

  // Managed instances must be reclaimable on demand so the service does not
  // leave behind browser children it started itself.
  test('reclaims managed browser processes through Admin API', async () => {
    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
      },
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

  // Explicit-instance paths are the multi-instance escape hatch and must stay
  // independent from the default root compat route.
  test('serves explicit-instance compat routes independently from default route', async () => {
    chrome = await startMockChromeServer();

    autorouter = await createAutorouterServer({
      env: {
        SERVER_HOST: '127.0.0.1',
        SERVER_PORT: '0',
        COMPAT_MODE_ENABLED: 'true',
        COMPAT_LAZY_LOAD_ENABLED: 'true',
      },
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
