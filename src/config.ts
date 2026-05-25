import {config as loadEnvFile} from 'dotenv';

import type {EnvPolicy, InstanceMode, LogLevel} from './types.js';

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

  return {
    // 这两个标志控制根路径兼容路由是否可用，以及是否允许在首次使用时懒加载默认实例。
    compatModeEnabled: parseBoolean(env.COMPAT_MODE_ENABLED, true),
    compatLazyLoadEnabled: parseBoolean(env.COMPAT_LAZY_LOAD_ENABLED, true),
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    serverHost: env.SERVER_HOST?.trim() || '127.0.0.1',
    serverPort: parseNumber(env.SERVER_PORT, 3100),
    logLevel,
    logFormat,
    logFile: env.LOG_FILE?.trim() || undefined,
    defaultInstanceTemplate,
  };
}
