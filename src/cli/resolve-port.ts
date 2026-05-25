/**
 * CLI 端口解析模块。
 *
 * Priority: --port flag > AUTOROUTER_URL env > .autorouter file (upward search) > default 3100
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

/** Read port from .autorouter JSON file. */
export function readConfigFile(filePath: string): number | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as { port?: number };
    if (typeof parsed.port === 'number' && parsed.port > 0) {
      return parsed.port;
    }
  } catch {
    // Corrupted or unreadable file, ignore
  }
  return null;
}

/** Write .autorouter config file. */
export function writeConfigFile(dir: string, port: number): string {
  const filePath = path.join(dir, CONFIG_FILENAME);
  fs.writeFileSync(filePath, JSON.stringify({ port }, null, 2) + '\n', 'utf8');
  return filePath;
}

/** Remove .autorouter config file. */
export function removeConfigFile(startDir: string): boolean {
  const found = findConfigFile(startDir);
  if (found) {
    fs.unlinkSync(found);
    return true;
  }
  return false;
}

/** Parse port from AUTOROUTER_URL env var. */
function parseEnvUrl(envUrl: string | undefined): number | null {
  if (!envUrl) return null;
  try {
    const url = new URL(envUrl);
    const port = parseInt(url.port, 10);
    return port > 0 ? port : null;
  } catch {
    // Try plain number
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
