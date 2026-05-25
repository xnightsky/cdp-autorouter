import {describe, test, expect} from 'vitest';
import {
  resolveAutorouterInstanceVersionUrl,
  resolveAutorouterWsEndpoint,
  resolveChromeDevToolsMcpLaunchArgs,
} from '../src/mcp-launch-options.js';

describe('mcp-launch-options', () => {
  describe('resolveAutorouterInstanceVersionUrl', () => {
    test('recognizes /instances/{id} pattern', () => {
      const result = resolveAutorouterInstanceVersionUrl('http://localhost:9300/instances/my-browser');
      expect(result).toEqual({
        instancePath: '/instances/my-browser',
        versionUrl: 'http://localhost:9300/instances/my-browser/json/version',
      });
    });

    test('recognizes legacy /instance1 pattern', () => {
      const result = resolveAutorouterInstanceVersionUrl('http://localhost:9223/instance2');
      expect(result).toEqual({
        instancePath: '/instance2',
        versionUrl: 'http://localhost:9223/instance2/json/version',
      });
    });

    test('returns null for root URL without instance path', () => {
      expect(resolveAutorouterInstanceVersionUrl('http://localhost:9300')).toBeNull();
      expect(resolveAutorouterInstanceVersionUrl('http://localhost:9300/')).toBeNull();
    });
  });

  describe('resolveAutorouterWsEndpoint', () => {
    test('fetches /json/version and returns wsEndpoint', async () => {
      const mockFetch = async () =>
        new Response(JSON.stringify({webSocketDebuggerUrl: 'ws://localhost:9300/devtools/browser/abc123'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        });

      const result = await resolveAutorouterWsEndpoint(
        'http://localhost:9300/instances/test',
        {fetchImpl: mockFetch as unknown as typeof fetch},
      );

      expect(result).toEqual({
        instancePath: '/instances/test',
        versionUrl: 'http://localhost:9300/instances/test/json/version',
        wsEndpoint: 'ws://localhost:9300/devtools/browser/abc123',
      });
    });

    test('returns null for non-instance URL', async () => {
      const result = await resolveAutorouterWsEndpoint('http://localhost:9300/');
      expect(result).toBeNull();
    });
  });

  describe('resolveChromeDevToolsMcpLaunchArgs', () => {
    test('upgrades --browserUrl with instance path to --wsEndpoint', async () => {
      const mockFetch = async () =>
        new Response(JSON.stringify({webSocketDebuggerUrl: 'ws://host:9300/devtools/browser/token'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        });

      const result = await resolveChromeDevToolsMcpLaunchArgs(
        ['--browserUrl=http://host:9300/instances/dev', '--headless'],
        {fetchImpl: mockFetch as unknown as typeof fetch},
      );

      expect(result).toEqual(['--headless', '--wsEndpoint=ws://host:9300/devtools/browser/token']);
    });

    test('preserves args when --wsEndpoint already present', async () => {
      const args = ['--wsEndpoint=ws://already:1234', '--headless'];
      const result = await resolveChromeDevToolsMcpLaunchArgs(args);
      expect(result).toEqual(args);
    });

    test('preserves args when browserUrl has no instance path', async () => {
      const args = ['--browserUrl=http://localhost:9222', '--headless'];
      const result = await resolveChromeDevToolsMcpLaunchArgs(args);
      expect(result).toEqual(args);
    });

    test('falls back to original args on fetch failure', async () => {
      const mockFetch = async () => {
        throw new Error('network error');
      };

      const args = ['--browserUrl=http://host:9300/instances/broken'];
      const result = await resolveChromeDevToolsMcpLaunchArgs(args, {
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
      expect(result).toEqual(args);
    });
  });
});