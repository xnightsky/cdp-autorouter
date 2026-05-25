import fs from 'node:fs';
import path from 'node:path';

import type {LogLevel, Logger, LoggerOptions} from './types.js';

/** 日志级别的数值优先级（越大越详细）。 */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/** pretty 模式下控制台输出的 ANSI 颜色码。 */
const LEVEL_COLOR: Record<Exclude<LogLevel, 'silent'>, string> = {
  error: '\x1b[31m', // 红色
  warn: '\x1b[33m',  // 黄色
  info: '\x1b[32m',  // 绿色
  debug: '\x1b[36m', // 青色
};

const RESET = '\x1b[0m';

/**
 * 判断当前 logger 级别是否足够输出目标级别。
 */
function shouldLog(current: LogLevel, target: LogLevel): boolean {
  return LEVEL_PRIORITY[current] >= LEVEL_PRIORITY[target];
}

/** 将日期格式化为 ISO-8601 时间戳。 */
function formatTimestamp(date = new Date()): string {
  return date.toISOString();
}

/**
 * 构建带 ANSI 颜色的可读日志行。
 *
 * 输出到 stderr，保留 stdout 给结构化 API 响应。
 */
function formatPretty(
  level: Exclude<LogLevel, 'silent'>,
  msg: string,
  ctx?: Record<string, unknown>,
): string {
  const color = LEVEL_COLOR[level];
  const levelLabel = level.toUpperCase().padStart(5, ' ');
  let line = `[${formatTimestamp()}] [${color}${levelLabel}${RESET}] ${msg}`;
  if (ctx && Object.keys(ctx).length > 0) {
    line += ` ${JSON.stringify(ctx)}`;
  }
  return line + '\n';
}

/**
 * 构建单行 JSON 日志负载。
 *
 * ctx 对象被平铺到 JSON 顶层，方便标准日志处理器查询。
 */
function formatJson(
  level: Exclude<LogLevel, 'silent'>,
  msg: string,
  ctx?: Record<string, unknown>,
): string {
  const payload: Record<string, unknown> = {
    timestamp: formatTimestamp(),
    level,
    msg,
  };
  if (ctx) {
    Object.assign(payload, ctx);
  }
  return JSON.stringify(payload) + '\n';
}

/**
 * 在写入新批次前轮转日志文件，防止超出大小限制。
 *
 * 命名规则：`autorouter.log` -> `autorouter.1.log` -> `autorouter.2.log`
 */
function rotateLogFile(filePath: string, maxFiles: number): void {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);

  // 删除最旧的备份文件。
  const oldest = path.join(dir, `${base}.${maxFiles}${ext}`);
  if (fs.existsSync(oldest)) {
    fs.unlinkSync(oldest);
  }

  // 将已有备份依次后移：.2 -> .3，.1 -> .2，以此类推。
  for (let i = maxFiles - 1; i >= 1; i--) {
    const current = path.join(dir, `${base}.${i}${ext}`);
    const next = path.join(dir, `${base}.${i + 1}${ext}`);
    if (fs.existsSync(current)) {
      fs.renameSync(current, next);
    }
  }

  // 将当前日志移到 .1。
  const first = path.join(dir, `${base}.1${ext}`);
  if (fs.existsSync(filePath)) {
    fs.renameSync(filePath, first);
  }
}

/**
 * 带内置轮转功能的缓冲文件写入器。
 *
 * 日志行先缓存在内存中，仅在 `destroy()` 时刷盘，
 * 避免同步 `log()` 调用阻塞事件循环。
 */
class FileWriter {
  readonly #path: string;
  readonly #maxSize: number;
  readonly #maxFiles: number;
  readonly #queue: string[] = [];
  #flushing = false;
  #destroyed = false;

  constructor(filePath: string, maxSize: number, maxFiles: number) {
    this.#path = filePath;
    this.#maxSize = maxSize;
    this.#maxFiles = maxFiles;
  }

  /** 将一行加入队列等待后续刷盘；此处不执行 I/O。 */
  write(line: string): void {
    if (this.#destroyed) return;
    this.#queue.push(line);
  }

  /**
   * 标记写入器为已销毁并强制最终刷盘。
   *
   * 必须在进程退出前 await，否则可能丢失缓冲中的日志。
   */
  async destroy(): Promise<void> {
    this.#destroyed = true;
    await this.#flush(true);
  }

  /** 将内部队列刷入磁盘，必要时触发轮转。 */
  async #flush(force = false): Promise<void> {
    if (this.#flushing) return;
    if (!force && this.#queue.length === 0) return;

    this.#flushing = true;
    try {
      while (this.#queue.length > 0) {
        // 一次性取出整个队列作为批次，减少 fs 调用次数。
        const batch = this.#queue.splice(0, this.#queue.length);
        const data = batch.join('');

        // 如果写入后超出限制，先轮转。
        if (fs.existsSync(this.#path)) {
          const stats = fs.statSync(this.#path);
          if (stats.size + Buffer.byteLength(data, 'utf8') > this.#maxSize) {
            rotateLogFile(this.#path, this.#maxFiles);
          }
        }

        fs.appendFileSync(this.#path, data, 'utf8');
      }
    } finally {
      this.#flushing = false;
    }
  }
}

/**
 * 创建 logger，输出到 stderr，可选同时写入轮转日志文件。
 *
 * @param options - logger 行为与输出目标配置。
 * @returns 一个 {@link Logger} 实例。
 */
export function createLogger(options: LoggerOptions): Logger {
  const level = options.level;
  const format = options.format;
  const filePath = options.file;
  const fileMaxSize = options.fileMaxSize ?? 10 * 1024 * 1024; // 默认 10MB
  const fileMaxFiles = options.fileMaxFiles ?? 3;

  // silent 时完全跳过文件创建，避免测试中的副作用。
  const fileWriter = filePath && level !== 'silent'
    ? new FileWriter(filePath, fileMaxSize, fileMaxFiles)
    : undefined;

  /** 统一输出逻辑：按级别过滤、格式化、双通道写入。 */
  function log(
    targetLevel: Exclude<LogLevel, 'silent'>,
    msg: string,
    ctx?: Record<string, unknown>,
  ): void {
    if (!shouldLog(level, targetLevel)) return;

    const line = format === 'pretty'
      ? formatPretty(targetLevel, msg, ctx)
      : formatJson(targetLevel, msg, ctx);

    // stderr 无缓冲、即时写入；文件走批量缓冲。
    process.stderr.write(line);
    fileWriter?.write(line);
  }

  return {
    options: Object.freeze({...options}),
    error(msg, ctx) { log('error', msg, ctx); },
    warn(msg, ctx) { log('warn', msg, ctx); },
    info(msg, ctx) { log('info', msg, ctx); },
    debug(msg, ctx) { log('debug', msg, ctx); },
    async destroy() {
      await fileWriter?.destroy();
    },
  };
}
