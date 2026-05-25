import http from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import * as api from '../src/cli/http-client.js';

describe('http-client', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);

      if (url.pathname === '/api/instances' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { instanceId: 'dev', mode: 'attached', status: 'healthy', isDefault: true },
        ]));
        return;
      }

      if (url.pathname === '/json/version' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          webSocketDebuggerUrl: 'ws://127.0.0.1:3100/devtools/browser/abc123',
        }));
        return;
      }

      if (url.pathname === '/instances/dev/json/version' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          webSocketDebuggerUrl: 'ws://127.0.0.1:3100/devtools/browser/def456',
        }));
        return;
      }

      if (url.pathname === '/api/instances/notfound/status') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Instance not found' }));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('listInstances returns array', async () => {
    const res = await api.listInstances(baseUrl);
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
    const items = res.data as Array<{ instanceId: string }>;
    expect(items[0]!.instanceId).toBe('dev');
  });

  test('getWsEndpoint returns ws URL for default instance', async () => {
    const res = await api.getWsEndpoint(baseUrl);
    expect(res.ok).toBe(true);
    expect(res.data).toBe('ws://127.0.0.1:3100/devtools/browser/abc123');
  });

  test('getWsEndpoint returns ws URL for specific instance', async () => {
    const res = await api.getWsEndpoint(baseUrl, 'dev');
    expect(res.ok).toBe(true);
    expect(res.data).toBe('ws://127.0.0.1:3100/devtools/browser/def456');
  });

  test('handles 404 error gracefully', async () => {
    const res = await api.getInstanceStatus(baseUrl, 'notfound');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.error).toContain('Instance not found');
  });

  test('handles connection refused', async () => {
    const res = await api.listInstances('http://127.0.0.1:1');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Connection failed');
  });
});
