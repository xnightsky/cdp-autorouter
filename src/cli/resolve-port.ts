/**
 * CLI 端口解析模块 —— 决定「这次命令打到哪个 autorouter 服务」。
 *
 * 解析优先级（高到低）：
 *   1. `--port` 命令行旗标        —— 单次覆盖，最高优先级；
 *   2. `AUTOROUTER_URL` 环境变量  —— 会话级覆盖（适合 CI / 脚本导出一次全程生效）；
 *   3. `.autorouter` 档案文件     —— 目录级持久化（`connect` 命令写入；从 cwd 向上逐级查找，
 *      因此可以在仓库根放一份、任意子目录内执行 CLI 都能命中）；
 *   4. 默认 3100                  —— 以上全落空时的兜底。
 *
 * ⚠️ 常见坑：server 实际监听端口以 server 自己的 config 为准，可能不是 3100
 * （本机约定 9223）。连不上时先核对 `.autorouter` / `--port` 指向是否正确。
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PORT = 3100;
const CONFIG_FILENAME = '.autorouter';

export interface ResolvedEndpoint {
  host: string;
  port: number;
  baseUrl: string;
}

/**
 * 从 startDir 起**逐级向上**查找 `.autorouter` 档案，返回首个命中的绝对路径；到文件系统根仍未命中返回 null。
 *
 * 向上查找的动机：档案通常放在仓库根，而 CLI 可能在任意子目录被调用（类比 .git/.editorconfig 的查找语义）。
 */
export function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // dirname 不再变化 = 已到文件系统根（如 `/` 或 `C:\`），终止上探
    dir = parent;
  }
  return null;
}

/**
 * 从 `.autorouter` JSON 档案读取端口。
 *
 * 容错语义：文件损坏 / 不可读 / 字段非法一律返回 null（视同「没有档案」，
 * 让上层继续走下一级兜底），而不是抛错中断整条命令——档案只是便利层，不应成为阻断点。
 */
export function readConfigFile(filePath: string): number | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as { port?: number };
    if (typeof parsed.port === 'number' && parsed.port > 0) {
      return parsed.port;
    }
  } catch {
    // 文件损坏或不可读：按「无档案」处理，交回上层继续兜底
  }
  return null;
}

/** 在指定目录写入 `.autorouter` 档案（`connect` 命令的落盘动作），返回写入的文件路径。 */
export function writeConfigFile(dir: string, port: number): string {
  const filePath = path.join(dir, CONFIG_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify({ port }, null, 2) + '\n', 'utf8');
  return filePath;
}

/**
 * 删除 `.autorouter` 档案（`disconnect` 命令）。
 *
 * 注意删除的是**向上查找命中的那一份**（可能在父目录），返回是否真的删了。
 */
export function removeConfigFile(startDir: string): boolean {
  const found = findConfigFile(startDir);
  if (found) {
    fs.unlinkSync(found);
    return true;
  }
  return false;
}

/**
 * 从 `AUTOROUTER_URL` 环境变量解析端口。
 *
 * 兼容两种写法：完整 URL（如 `http://127.0.0.1:9223`，取其 port 部分）
 * 或纯端口数字（如 `9223`）。两种都解析失败返回 null，交回上层继续兜底。
 */
function parseEnvUrl(envUrl: string | undefined): number | null {
  if (!envUrl) return null;
  try {
    const url = new URL(envUrl);
    const port = parseInt(url.port, 10);
    return port > 0 ? port : null;
  } catch {
    // 不是合法 URL → 按纯端口数字再试一次
    const num = parseInt(envUrl, 10);
    return num > 0 ? num : null;
  }
}

/**
 * 按优先级解析 autorouter 端点（见文件头注释的四级优先级说明）。
 *
 * `env`/`cwd` 参数可注入，便于单测隔离（默认取真实 process.env / process.cwd()）。
 * host 固定 127.0.0.1：控制面只应本机回环访问，跨机使用请走 ssh 端口转发而非直连暴露。
 */
export function resolveEndpoint(options: {
  portFlag?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
}): ResolvedEndpoint {
  const { portFlag, env = process.env, cwd = process.cwd() } = options;

  let port: number | null = null;

  // 1. --port flag
  if (portFlag && portFlag > 0) {
    port = portFlag;
  }

  // 2. AUTOROUTER_URL env
  if (port === null) {
    port = parseEnvUrl(env.AUTOROUTER_URL);
  }

  // 3. .autorouter file
  if (port === null) {
    const configPath = findConfigFile(cwd);
    if (configPath) {
      port = readConfigFile(configPath);
    }
  }

  // 4. default
  if (port === null) {
    port = DEFAULT_PORT;
  }

  return {
    host: '127.0.0.1',
    port,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}
