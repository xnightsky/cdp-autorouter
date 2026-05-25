import {describe, expect, test} from 'vitest';

import {DefaultInstanceResolver} from '../src/default-instance-resolver.js';
import {RuntimeRegistry} from '../src/runtime-registry.js';
import {createMockLogger} from './helpers/mock-logger.js';

describe('DefaultInstanceResolver logger integration', () => {
  test('logs when bootstrapping default instance from env', () => {
    const logger = createMockLogger();
    const registry = new RuntimeRegistry(logger);
    const policy = {
      compatModeEnabled: true,
      compatLazyLoadEnabled: true,
      trustProxy: false,
      serverHost: '127.0.0.1',
      serverPort: 3100,
      logLevel: 'info' as const,
      logFormat: 'pretty' as const,
      defaultInstanceTemplate: {
        instanceId: 'default',
        mode: 'attached' as const,
        browserUrl: 'http://127.0.0.1:9222',
        chromeLaunchArgs: [],
      },
    };
    const resolver = new DefaultInstanceResolver(policy, registry, logger);
    resolver.ensureDefaultInstance();
    expect(logger.calls.some(c => c.msg === 'default instance bootstrapped from env')).toBe(true);
  });

  test('logs warning when lazy load is disabled', () => {
    const logger = createMockLogger();
    const registry = new RuntimeRegistry(logger);
    const policy = {
      compatModeEnabled: true,
      compatLazyLoadEnabled: false,
      trustProxy: false,
      serverHost: '127.0.0.1',
      serverPort: 3100,
      logLevel: 'info' as const,
      logFormat: 'pretty' as const,
      defaultInstanceTemplate: {
        instanceId: 'default',
        mode: 'attached' as const,
        browserUrl: 'http://127.0.0.1:9222',
        chromeLaunchArgs: [],
      },
    };
    const resolver = new DefaultInstanceResolver(policy, registry, logger);
    expect(() => resolver.ensureDefaultInstance()).toThrow('disabled');
    expect(logger.calls.some(c => c.level === 'warn' && c.msg === 'default instance lazy load disabled')).toBe(true);
  });

  test('works without logger', () => {
    const registry = new RuntimeRegistry();
    const policy = {
      compatModeEnabled: true,
      compatLazyLoadEnabled: true,
      trustProxy: false,
      serverHost: '127.0.0.1',
      serverPort: 3100,
      logLevel: 'info' as const,
      logFormat: 'pretty' as const,
      defaultInstanceTemplate: {
        instanceId: 'default',
        mode: 'attached' as const,
        browserUrl: 'http://127.0.0.1:9222',
        chromeLaunchArgs: [],
      },
    };
    const resolver = new DefaultInstanceResolver(policy, registry);
    const instance = resolver.ensureDefaultInstance();
    expect(instance.instanceId).toBe('default');
  });
});
