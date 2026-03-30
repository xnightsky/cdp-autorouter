import fs from 'node:fs/promises';
import path from 'node:path';

import {afterEach, describe, expect, test} from 'vitest';

import {createAutorouterServer} from '../src/index.js';

const envPath = path.resolve('.env');

describe('env policy loading', () => {
  afterEach(async () => {
    await fs.rm(envPath, {force: true});
  });

  // This locks in the intended precedence: local `.env` values should be
  // visible to normal service boots without having to inject overrides.
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

    const server = await createAutorouterServer();

    try {
      expect(server.policy.defaultInstanceTemplate?.instanceId).toBe('from-dotenv');
      expect(server.policy.serverPort).toBe(0);
    } finally {
      await server.close();
    }
  });
});
