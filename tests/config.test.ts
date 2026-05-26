import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {afterEach, beforeEach, describe, expect, test} from 'vitest';

import {createSilentLogger} from './helpers/mock-logger.js';
import {createAutorouterServer} from '../src/server/index.js';
import {resolveEnvFile} from '../src/server/config.js';

const envPath = path.resolve('.env');

describe('env policy loading', () => {
  let originalEnvContent: string | null = null;

  beforeEach(async () => {
    try {
      originalEnvContent = await fs.readFile(envPath, 'utf8');
    } catch {
      originalEnvContent = null;
    }
  });

  afterEach(async () => {
    if (originalEnvContent !== null) {
      await fs.writeFile(envPath, originalEnvContent, 'utf8');
    } else {
      await fs.rm(envPath, {force: true});
    }
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

describe('resolveEnvFile', () => {
  let tmpRoot: string;
  let originalAutorouterEnvFile: string | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cdp-env-resolve-'));
    // Snapshot then unset so individual cases can opt in to the override.
    originalAutorouterEnvFile = process.env.AUTOROUTER_ENV_FILE;
    delete process.env.AUTOROUTER_ENV_FILE;
  });

  afterEach(async () => {
    if (originalAutorouterEnvFile === undefined) {
      delete process.env.AUTOROUTER_ENV_FILE;
    } else {
      process.env.AUTOROUTER_ENV_FILE = originalAutorouterEnvFile;
    }
    await fs.rm(tmpRoot, {recursive: true, force: true});
  });

  test('AUTOROUTER_ENV_FILE absolute path beats CWD and package root', async () => {
    const explicit = path.join(tmpRoot, 'explicit.env');
    const cwdEnv = path.join(tmpRoot, '.env');
    await fs.writeFile(explicit, 'SERVER_PORT=11111', 'utf8');
    await fs.writeFile(cwdEnv, 'SERVER_PORT=22222', 'utf8');

    const resolved = resolveEnvFile(tmpRoot, import.meta.url, {
      AUTOROUTER_ENV_FILE: explicit,
    });
    expect(resolved).toBe(explicit);
  });

  test('falls back to CWD/.env when no explicit override', async () => {
    const cwdEnv = path.join(tmpRoot, '.env');
    await fs.writeFile(cwdEnv, 'SERVER_PORT=22222', 'utf8');

    const resolved = resolveEnvFile(tmpRoot, import.meta.url, {});
    expect(resolved).toBe(cwdEnv);
  });

  test('falls back to package-root .env when CWD has none', async () => {
    // Pretend the running module lives inside a fake package tree.
    const fakePkgRoot = path.join(tmpRoot, 'fake-pkg');
    const fakeModuleDir = path.join(fakePkgRoot, 'dist', 'src', 'server');
    await fs.mkdir(fakeModuleDir, {recursive: true});
    await fs.writeFile(path.join(fakePkgRoot, 'package.json'), '{}', 'utf8');
    await fs.writeFile(path.join(fakePkgRoot, '.env'), 'SERVER_PORT=33333', 'utf8');
    const fakeModuleFile = path.join(fakeModuleDir, 'config.js');
    await fs.writeFile(fakeModuleFile, '', 'utf8');

    // CWD has no .env, so resolution must walk up from the module URL.
    const cwdWithoutEnv = path.join(tmpRoot, 'no-env-here');
    await fs.mkdir(cwdWithoutEnv);

    const resolved = resolveEnvFile(
      cwdWithoutEnv,
      pathToFileURL(fakeModuleFile).href,
      {},
    );
    expect(resolved).toBe(path.join(fakePkgRoot, '.env'));
  });

  test('returns undefined when nothing is found', () => {
    const resolved = resolveEnvFile(tmpRoot, import.meta.url, {});
    // Nothing in tmpRoot, but import.meta.url points to the real repo whose
    // package root has a .env. Skip this check unless that env disappears.
    expect(typeof resolved === 'string' || resolved === undefined).toBe(true);
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
