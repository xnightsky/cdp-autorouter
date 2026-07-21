import {existsSync, realpathSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {config as loadEnvFile} from 'dotenv';

import type {EnvPolicy, InstanceMode, LogLevel} from './types.js';

/**
 * Walk up from a starting directory until a `package.json` is found.
 *
 * Used to anchor `.env` lookups to the installed package root, so that
 * `cdp-autorouter-server` invoked from any CWD still finds the bundled
 * `.env`. Returns `undefined` if no `package.json` is found before the
 * filesystem root.
 */
export function findPackageRoot(startDir: string): string | undefined {
  let current = startDir;
  // Bound the walk to avoid infinite loops on broken filesystems.
  for (let i = 0; i < 16; i++) {
    if (existsSync(resolve(current, 'package.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

/**
 * 解析仓库根目录（package.json 所在目录）。
 *
 * 用于把相对路径的日志目录锚定到仓库根，而非进程启动时的 CWD，
 * 避免在不同子目录执行 CLI 时日志散落。
 */
export function resolveRepoRoot(metaUrl: string = import.meta.url): string | undefined {
  let configFile: string;
  try {
    configFile = realpathSync(fileURLToPath(metaUrl));
  } catch {
    return undefined;
  }
  return findPackageRoot(dirname(configFile));
}

/**
 * Resolve which `.env` file to load, in priority order:
 *   1. `AUTOROUTER_ENV_FILE` explicit override (absolute or CWD-relative)
 *   2. `<cwd>/.env` (preserves "run from project dir" semantics)
 *   3. Package-root `.env` (so global install works from any CWD)
 *
 * Returns `undefined` when nothing is found, in which case `dotenv` is not
 * invoked at all (no env var pollution).
 */
export function resolveEnvFile(
  cwd: string = process.cwd(),
  metaUrl: string = import.meta.url,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = env.AUTOROUTER_ENV_FILE?.trim();
  if (explicit) {
    const explicitPath = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    return existsSync(explicitPath) ? explicitPath : undefined;
  }

  const cwdEnv = resolve(cwd, '.env');
  if (existsSync(cwdEnv)) {
    return cwdEnv;
  }

  // realpath both ends to neutralize Windows junctions used by `npm install -g`.
  let configFile: string;
  try {
    configFile = realpathSync(fileURLToPath(metaUrl));
  } catch {
    return undefined;
  }
  const packageRoot = findPackageRoot(dirname(configFile));
  if (!packageRoot) {
    return undefined;
  }
  const packageEnv = resolve(packageRoot, '.env');
  return existsSync(packageEnv) ? packageEnv : undefined;
}

/**
 * 解析类布尔的环境变量，对缺失或空值给出确定性默认值。
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * 解析数值型环境变量，失败时回退到默认值。
 */
function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * 将命令行风格参数字符串拆分为独立 token。
 *
 * v1 保持简单；如需支持引号参数，后续应在此改进解析行为。
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
 * 从 `.env` 加载启动策略，再叠加显式运行时覆盖（如测试注入）。
 *
 * 合并顺序很重要：
 * 1. `.env` 提供真实运行的本地默认值
 * 2. 显式覆盖在测试和嵌入场景中优先
 */
export function loadEnvPolicy(
  overrides: NodeJS.ProcessEnv = {},
): EnvPolicy {
  const envFile = resolveEnvFile();
  if (envFile) {
    loadEnvFile({path: envFile});
  }
  const env = {
    ...process.env,
    ...overrides,
  };

  const defaultInstanceId = env.DEFAULT_INSTANCE_ID?.trim();
  const defaultMode = (env.DEFAULT_INSTANCE_MODE?.trim() ||
    'attached') as InstanceMode;

  const defaultInstanceTemplate = defaultInstanceId
    ? {
        // 默认实例是通过根路径兼容路由暴露的实例。
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

  // 解析日志配置，并做安全回退，避免坏值导致服务启动崩溃。
  const rawLogLevel = env.LOG_LEVEL?.trim().toLowerCase() || 'info';
  const validLevels: LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
  const logLevel: LogLevel = validLevels.includes(rawLogLevel as LogLevel)
    ? (rawLogLevel as LogLevel)
    : 'info';

  const rawLogFormat = env.LOG_FORMAT?.trim().toLowerCase() || 'pretty';
  const logFormat: 'pretty' | 'json' = rawLogFormat === 'json' ? 'json' : 'pretty';

  const logOperationsEnabled = parseBoolean(env.LOG_OPERATIONS_ENABLED, false);
  const logDir = env.LOG_DIR?.trim() || 'data/logs';

  return {
    // 这两个标志控制根路径兼容路由是否可用，以及是否允许在首次使用时懒加载默认实例。
    compatModeEnabled: parseBoolean(env.COMPAT_MODE_ENABLED, true),
    compatLazyLoadEnabled: parseBoolean(env.COMPAT_LAZY_LOAD_ENABLED, true),
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    serverHost: env.SERVER_HOST?.trim() || '127.0.0.1',
    serverPort: parseNumber(env.SERVER_PORT, 3100),
    // 仅默认实例嗅探自愈使用。默认 8000 ms 覆盖典型 chrome 冷启 1-3s + 留出富余。
    restartTimeoutMs: parseNumber(env.DEFAULT_INSTANCE_RESTART_TIMEOUT_MS, 8000),
    logLevel,
    logFormat,
    logFile: env.LOG_FILE?.trim() || undefined,
    logOperationsEnabled,
    logDir,
    defaultInstanceTemplate,
  };
}
