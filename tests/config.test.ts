import fs from 'node:fs/promises';
import path from 'node:path';

import {afterEach, describe, expect, test} from 'vitest';

import {createSilentLogger} from './helpers/mock-logger.js';
import {createAutorouterServer} from '../src/server/index.js';

const envPath = path.resolve('.env');

describe('env policy loading', () => {
  afterEach(async () => {
    await fs.rm(envPath, {force: true});
  });

  // 锁定预期优先级：正常服务启动时无需注入覆盖即可读取本地 `.env` 值。
  test('loads default instance strategy from local .env file', async () => {
    await fs.writeFile(
      envPath,
      [
        'SERVER_HOST=127.0.0.1',
        'SERVER_PORT=0',
        'COMPAT_MODE_ENABLED=true',
        'COMPAT_LAZY_LOAD_ENABLED=true',
        'DEFAULT_INSTANCE_ID=from-dotenv',
        'DEFAULT_INSTANCE_MODE=attached',
        'DEFAULT_INSTANCE_BROWSER_URL=http://127.0.0.1:9222',
      ].join('\n'),
      'utf8',
    );

    const server = await createAutorouterServer({logger: createSilentLogger()});

    try {
      expect(server.policy.defaultInstanceTemplate?.instanceId).toBe('from-dotenv');
      expect(server.policy.serverPort).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe('logger env policy', () => {
  test('defaults to info pretty when env vars absent', async () => {
    const server = await createAutorouterServer({env: {SERVER_PORT: '0'}, logger: createSilentLogger()});
    try {
      expect(server.policy.logLevel).toBe('info');
      expect(server.policy.logFormat).toBe('pretty');
      expect(server.policy.logFile).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  test('parses LOG_LEVEL LOG_FORMAT LOG_FILE', async () => {
    const server = await createAutorouterServer({
      env: {
        SERVER_PORT: '0',
        LOG_LEVEL: 'debug',
        LOG_FORMAT: 'json',
        LOG_FILE: 'autorouter.log',
      },
      logger: createSilentLogger(),
    });
    try {
      expect(server.policy.logLevel).toBe('debug');
      expect(server.policy.logFormat).toBe('json');
      expect(server.policy.logFile).toBe('autorouter.log');
    } finally {
      await server.close();
    }
  });

  test('falls back to info for invalid LOG_LEVEL', async () => {
    const server = await createAutorouterServer({
      env: {
        SERVER_PORT: '0',
        LOG_LEVEL: 'verbose',
      },
      logger: createSilentLogger(),
    });
    try {
      expect(server.policy.logLevel).toBe('info');
    } finally {
      await server.close();
    }
  });
});
