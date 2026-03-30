import {config as loadEnvFile} from 'dotenv';

import type {EnvPolicy, InstanceMode} from './types.js';

/**
 * Parses a boolean-like environment variable while keeping a deterministic
 * default for missing or empty values.
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Parses a numeric environment variable with a default fallback.
 */
function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Splits a command-line style argument string into individual tokens.
 *
 * v1 keeps this intentionally simple; if quoted argument support becomes
 * necessary later, this helper is the place to improve parsing behavior.
 */
function parseArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/\s+/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

/**
 * Loads autorouter startup policy from `.env`, then overlays explicit runtime
 * overrides such as tests or launch-time injections.
 *
 * The merge order is important:
 * 1. `.env` establishes local defaults for real runs
 * 2. explicit overrides win in tests and embedded scenarios
 */
export function loadEnvPolicy(
  overrides: NodeJS.ProcessEnv = {},
): EnvPolicy {
  loadEnvFile();
  const env = {
    ...process.env,
    ...overrides,
  };

  const defaultInstanceId = env.DEFAULT_INSTANCE_ID?.trim();
  const defaultMode = (env.DEFAULT_INSTANCE_MODE?.trim() ||
    'attached') as InstanceMode;

  const defaultInstanceTemplate = defaultInstanceId
    ? {
        // The default instance is the one exposed through root compat routes.
        instanceId: defaultInstanceId,
        mode: defaultMode,
        browserUrl: env.DEFAULT_INSTANCE_BROWSER_URL?.trim() || undefined,
        wsEndpoint: env.DEFAULT_INSTANCE_WS_ENDPOINT?.trim() || undefined,
        userDataDir: env.DEFAULT_INSTANCE_USER_DATA_DIR?.trim() || undefined,
        chromeLaunchArgs: parseArgs(env.DEFAULT_INSTANCE_CHROME_ARGS),
        headless: parseBoolean(env.DEFAULT_INSTANCE_HEADLESS, false),
        remoteDebuggingPort: env.DEFAULT_INSTANCE_REMOTE_DEBUGGING_PORT
          ? parseNumber(env.DEFAULT_INSTANCE_REMOTE_DEBUGGING_PORT, 9222)
          : undefined,
        executablePath: env.DEFAULT_INSTANCE_EXECUTABLE_PATH?.trim() || undefined,
      }
    : undefined;

  return {
    // These flags control whether root compat routes are available at all and
    // whether they are allowed to bootstrap the default instance on first use.
    compatModeEnabled: parseBoolean(env.COMPAT_MODE_ENABLED, true),
    compatLazyLoadEnabled: parseBoolean(env.COMPAT_LAZY_LOAD_ENABLED, true),
    serverHost: env.SERVER_HOST?.trim() || '127.0.0.1',
    serverPort: parseNumber(env.SERVER_PORT, 3100),
    defaultInstanceTemplate,
  };
}
