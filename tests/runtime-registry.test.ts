import {describe, expect, test} from 'vitest';

import {RuntimeRegistry} from '../src/server/runtime-registry.js';
import {createMockLogger} from './helpers/mock-logger.js';

describe('RuntimeRegistry logger integration', () => {
  test('logs on create', () => {
    const logger = createMockLogger();
    const registry = new RuntimeRegistry(logger);
    registry.create({
      instanceId: 'alpha',
      mode: 'attached',
      source: 'api-runtime',
      chromeLaunchArgs: [],
    });
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      level: 'info',
      msg: 'instance created',
      ctx: {instanceId: 'alpha', mode: 'attached'},
    });
  });

  test('logs on delete', () => {
    const logger = createMockLogger();
    const registry = new RuntimeRegistry(logger);
    registry.create({
      instanceId: 'beta',
      mode: 'managed',
      source: 'api-runtime',
      chromeLaunchArgs: [],
    });
    logger.calls.length = 0;
    registry.delete('beta');
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      level: 'info',
      msg: 'instance deleted',
      ctx: {instanceId: 'beta'},
    });
  });

  test('works without logger', () => {
    const registry = new RuntimeRegistry();
    const instance = registry.create({
      instanceId: 'gamma',
      mode: 'attached',
      source: 'api-runtime',
      chromeLaunchArgs: [],
    });
    expect(instance.instanceId).toBe('gamma');
    registry.delete('gamma');
    expect(registry.get('gamma')).toBeUndefined();
  });
});
