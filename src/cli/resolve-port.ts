/**
 * CLI 端口解析模块。
 *
 * 优先级：--port flag > AUTOROUTER_URL 环境变量 > .autorouter 文件（向上查找） > 默认 3100
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

/** 向上查找 .autorouter 文件，返回找到的路径或 null。 */
export function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/** 从 .autorouter JSON 文件读取端口。 */
export function readConfigFile(filePath: string): number | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as { port?: number };
    if (typeof parsed.port === 'number' && parsed.port > 0) {
      return parsed.port;
    }
  } catch {
    // 文件损坏或不可读，忽略
  }
  return null;
}

/** 写入 .autorouter 配置文件。 */
export function writeConfigFile(dir: string, port: number): string {
  const filePath = path.join(dir, CONFIG_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify({ port }, null, 2) + '\n', 'utf8');
  return filePath;
}

/** 删除 .autorouter 配置文件。 */
export function removeConfigFile(startDir: string): boolean {
  const found = findConfigFile(startDir);
  if (found) {
    fs.unlinkSync(found);
    return true;
  }
  return false;
}

/** 从 AUTOROUTER_URL 环境变量解析端口。 */
function parseEnvUrl(envUrl: string | undefined): number | null {
  if (!envUrl) return null;
  try {
    const url = new URL(envUrl);
    const port = parseInt(url.port, 10);
    return port > 0 ? port : null;
  } catch {
    // 尝试纯数字
    const num = parseInt(envUrl, 10);
    return num > 0 ? num : null;
  }
}

/**
 * 按优先级解析 autorouter 端点。
 * --port flag > AUTOROUTER_URL env > .autorouter file > default 3100
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
