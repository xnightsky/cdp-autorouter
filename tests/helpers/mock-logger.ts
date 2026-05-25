import type {Logger, LogLevel, LoggerOptions} from '../../src/server/types.js';

/**
 * 返回一个什么都不做的 logger，零输出。
 *
 * 在集成测试中使用，保持 stderr 干净，避免日志副作用导致断言不稳定。
 */
export function createSilentLogger(): Logger {
  return {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    destroy: async () => {},
    options: Object.freeze({level: 'silent' as LogLevel, format: 'pretty' as const}),
  };
}

/**
 * {@link createMockLogger} 捕获的单条日志记录。
 */
interface LogCall {
  level: string;
  msg: string;
  ctx?: Record<string, unknown>;
}

/**
 * 返回一个会记录每次调用的 logger，方便测试中断言日志行为。
 *
 * 返回对象额外暴露 `calls` 数组，按调用时序排列。
 */
export function createMockLogger(options: Partial<LoggerOptions> = {}): Logger & {calls: LogCall[]} {
  const calls: LogCall[] = [];
  const resolved = {
    level: options.level ?? 'debug' as LogLevel,
    format: options.format ?? 'pretty' as const,
    file: options.file,
  };
  return {
    error(msg, ctx) { calls.push({level: 'error', msg, ctx}); },
    warn(msg, ctx) { calls.push({level: 'warn', msg, ctx}); },
    info(msg, ctx) { calls.push({level: 'info', msg, ctx}); },
    debug(msg, ctx) { calls.push({level: 'debug', msg, ctx}); },
    destroy: async () => {},
    options: Object.freeze(resolved),
    calls,
  };
}
