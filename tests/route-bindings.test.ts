import {describe, expect, test} from 'vitest';

import {RouteBindingStore} from '../src/server/route-bindings.js';
import {createMockLogger} from './helpers/mock-logger.js';

describe('RouteBindingStore logger integration', () => {
  test('logs on register', () => {
    const logger = createMockLogger();
    const store = new RouteBindingStore(logger);
    store.register('alpha', 'ws://localhost:9222/devtools/browser/1', 'browser');
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      level: 'debug',
      msg: 'binding registered',
      ctx: {instanceId: 'alpha', kind: 'browser'},
    });
    expect(typeof logger.calls[0].ctx?.token).toBe('string');
  });

  test('logs on delete', () => {
    const logger = createMockLogger();
    const store = new RouteBindingStore(logger);
    const binding = store.register('alpha', 'ws://localhost:9222/devtools/page/1', 'page');
    logger.calls.length = 0;
    store.delete(binding.token);
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]).toMatchObject({
      level: 'debug',
      msg: 'binding deleted',
      ctx: {token: binding.token},
    });
  });

  test('works without logger', () => {
    const store = new RouteBindingStore();
    const binding = store.register('beta', 'ws://localhost:9222/devtools/browser/2', 'browser');
    expect(store.get(binding.token)).toBeDefined();
    store.delete(binding.token);
    expect(store.get(binding.token)).toBeUndefined();
  });
});
