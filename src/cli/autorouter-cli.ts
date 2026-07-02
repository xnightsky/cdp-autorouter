#!/usr/bin/env node
/**
 * cdp-autorouter-cli —— 控制面客户端入口（命令分发层）。
 *
 * 手写 argv 解析、零第三方依赖：CLI 追求「npm -g 装完即跑」，命令面很小
 * （十来个动词 + 两个全局旗标），不值得引 commander/yargs 这类解析库。
 *
 * 命令分三类：
 * - 纯本地：connect / disconnect（读写 .autorouter 档案）、skills（读包内文档）——不碰网络；
 * - 控制面：list / create / start / stop / restart / switch / status / delete —— 打 Admin API；
 * - 消费口：get-ws —— 打 CDP 兼容路由，输出单行 ws:// 供 $() 内联消费。
 */

import os from 'node:os';

import {
  resolveEndpoint,
  writeConfigFile,
  removeConfigFile,
} from './resolve-port.js';
import * as api from './http-client.js';
import { listSkills, getSkillContent, getAllSkillsContent } from './skills.js';

// --- argv 解析工具 ---

/**
 * 从 args 中提取指定命名参数的值，并**就地移除**该参数（splice 原数组）。
 *
 * 支持 `--name value` 与 `--name=value` 两种写法。「提取即移除」是刻意设计：
 * 旗标可以出现在任意位置（命令前后皆可），全部提完后 args 里只剩命令与位置参数，
 * 后续 `args.shift()` / `args[0]` 取位置参数时无需再绕开旗标。
 */
function extractFlag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) {
      const val = args[i + 1]!;
      args.splice(i, 2);
      return val;
    }
    if (args[i]?.startsWith(`${name}=`)) {
      const val = args[i]!.slice(name.length + 1);
      args.splice(i, 1);
      return val;
    }
  }
  return undefined;
}

/** 检查布尔旗标（如 `--json`）是否存在，并就地移除（理由同 extractFlag：让位置参数保持干净）。 */
function hasFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name);
  if (idx >= 0) { args.splice(idx, 1); return true; }
  return false;
}

// --- 输出工具 ---

/** `--json` 模式的机器可读输出（两空格缩进，方便人眼与 jq 兼得）。 */
function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

/** 错误统一写 stderr（stdout 留给数据输出，保证 `$()` / 管道消费不被错误信息污染）。 */
function printError(msg: string): void {
  process.stderr.write(`Error: ${msg}\n`);
}

/**
 * 人类可读的等宽表格输出（`list` 命令默认视图）。
 *
 * 列集取第一行的 keys；每列宽度 = 表头与所有单元格的最大长度，逐列 padEnd 对齐。
 * 只做 ASCII 对齐，不处理东亚全角宽度——当前列值均为 id/状态类 latin 文本，够用。
 */
function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    process.stdout.write('(empty)\n');
    return;
  }
  const keys = Object.keys(rows[0]!);
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length)),
  );
  const header = keys.map((k, i) => k.padEnd(widths[i]!)).join('  ');
  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  process.stdout.write(header + '\n' + sep + '\n');
  for (const row of rows) {
    const line = keys.map((k, i) => String(row[k] ?? '').padEnd(widths[i]!)).join('  ');
    process.stdout.write(line + '\n');
  }
}

// --- 主逻辑 ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 全局旗标先于命令解析提取：它们允许出现在命令词前面（如 `cli --port 9223 list`），
  // 若不先摘掉，args.shift() 会把 `--port` 误当成命令词。
  const portStr = extractFlag(args, '--port');
  const portFlag = portStr ? parseInt(portStr, 10) : undefined;
  const jsonMode = hasFlag(args, '--json');

  const command = args.shift();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  // connect/disconnect 是纯本地档案操作（写/删 .autorouter），不发任何网络请求——
  // 所以放在 resolveEndpoint 之前处理，server 没起也能用。
  if (command === 'connect') {
    // --global：档案写到 ~/.autorouter（全局），供任意目录树下的 CLI 兜底发现；
    // 缺省写 cwd（目录级，就近优先，可按项目各连各的 server）
    const globalMode = hasFlag(args, '--global') || hasFlag(args, '-g');
    // connect 的位置参数 = 要持久化的端口号；缺省时退回 --port 值，再缺省用 3100
    const port = parseInt(args[0] ?? String(portFlag ?? 3100), 10);
    if (!port || port <= 0) {
      printError('Invalid port number');
      process.exitCode = 1;
      return;
    }
    const targetDir = globalMode ? os.homedir() : process.cwd();
    const filePath = writeConfigFile(targetDir, port);
    process.stdout.write(`Connected to port ${port} (saved to ${filePath})\n`);
    return;
  }

  if (command === 'disconnect') {
    const removed = removeConfigFile(process.cwd());
    if (removed) {
      process.stdout.write('Disconnected (removed .autorouter)\n');
    } else {
      process.stdout.write('No .autorouter file found\n');
    }
    return;
  }

  // skills 子命令读的是随 npm 包发布的本地文档，同样不需要 server 在线
  if (command === 'skills') {
    handleSkills(args, jsonMode);
    return;
  }

  // 以下全部命令都要打 autorouter 服务：此刻才解析端点（本地命令不受端口配置影响）
  const endpoint = resolveEndpoint({ portFlag });
  const baseUrl = endpoint.baseUrl;

  switch (command) {
    case 'list': {
      const res = await api.listInstances(baseUrl);
      if (!res.ok) { printError(res.error!); process.exitCode = 1; return; }
      if (jsonMode) { printJson(res.data); return; }
      const items = Array.isArray(res.data) ? res.data : [];
      if (items.length === 0) { process.stdout.write('No instances\n'); return; }
      printTable(items.map((i: Record<string, unknown>) => ({
        id: i.instanceId, mode: i.mode, status: i.status, default: i.isDefault ? '✓' : '',
      })));
      return;
    }

    case 'create': {
      const id = extractFlag(args, '--id');
      const mode = extractFlag(args, '--mode');
      const browserUrl = extractFlag(args, '--browser-url');
      const wsEndpoint = extractFlag(args, '--ws-endpoint');
      if (!id || !mode) {
        printError('Usage: create --id <id> --mode <managed|attached> [--browser-url <url>]');
        process.exitCode = 1;
        return;
      }
      const body: Record<string, string> = { instanceId: id, mode };
      if (browserUrl) body.browserUrl = browserUrl;
      if (wsEndpoint) body.wsEndpoint = wsEndpoint;
      const res = await api.createInstance(baseUrl, body as Parameters<typeof api.createInstance>[1]);
      if (!res.ok) { printError(res.error!); process.exitCode = 1; return; }
      if (jsonMode) { printJson(res.data); return; }
      process.stdout.write(`Created instance "${id}" (mode=${mode})\n`);
      return;
    }

    case 'start': {
      const id = args[0];
      if (!id) { printError('Usage: start <id>'); process.exitCode = 1; return; }
      const res = await api.startInstance(baseUrl, id);
      if (!res.ok) { printError(res.error!); process.exitCode = 1; return; }
      if (jsonMode) { printJson(res.data); return; }
      process.stdout.write(`Started instance "${id}"\n`);
      return;
    }

    case 'stop': {
      const id = args[0];
      if (!id) { printError('Usage: stop <id>'); process.exitCode = 1; return; }
      const res = await api.stopInstance(baseUrl, id);
      if (!res.ok) { printError(res.error!); process.exitCode = 1; return; }
      if (jsonMode) { printJson(res.data); return; }
      process.stdout.write(`Stopped instance "${id}"\n`);
      return;
    }

    case 'restart': {
      const id = args[0];
      if (!id) { printError('Usage: restart <id>'); process.exitCode = 1; return; }
      const res = await api.restartInstance(baseUrl, id);
      if (!res.ok) { printError(res.error!); process.exitCode = 1; return; }
      if (jsonMode) { printJson(res.data); return; }
      process.stdout.write(`Restarted instance "${id}"\n`);
      return;
    }

    case 'switch': {
      const id = args[0];
      if (!id) { printError('Usage: switch <id>'); process.exitCode = 1; return; }
      const res = await api.switchInstance(baseUrl, id);
      if (!res.ok) { printError(res.error!); process.exitCode = 1; return; }
      if (jsonMode) { printJson(res.data); return; }
      process.stdout.write(`Switched default to "${id}"\n`);
      return;
    }

    case 'status': {
      const id = args[0];
      if (!id) { printError('Usage: status <id>'); process.exitCode = 1; return; }
      const res = await api.getInstanceStatus(baseUrl, id);
      if (!res.ok) { printError(res.error!); process.exitCode = 1; return; }
      if (jsonMode) { printJson(res.data); return; }
      const d = res.data as Record<string, unknown>;
      for (const [k, v] of Object.entries(d)) {
        process.stdout.write(`${k}: ${v}\n`);
      }
      return;
    }

    case 'delete': {
      const id = args[0];
      if (!id) { printError('Usage: delete <id>'); process.exitCode = 1; return; }
      const res = await api.deleteInstance(baseUrl, id);
      if (!res.ok) { printError(res.error!); process.exitCode = 1; return; }
      if (jsonMode) { printJson(res.data); return; }
      process.stdout.write(`Deleted instance "${id}"\n`);
      return;
    }

    case 'get-ws': {
      const id = args[0]; // 位置参数可选：省略 = 取默认实例（server 侧 switch 决定谁是默认）
      const res = await api.getWsEndpoint(baseUrl, id);
      if (!res.ok) { printError(res.error!); process.exitCode = 1; return; }
      // 输出契约：stdout 恒为单行 ws:// 地址、无任何装饰——这是给
      // `agent-browser --cdp $(cdp-autorouter-cli get-ws <id>)` 之类 $() 内联消费设计的，
      // 加任何前缀/颜色都会破坏下游。错误一律走 stderr（见 printError）。
      process.stdout.write(res.data + '\n');
      return;
    }

    default:
      printError(`Unknown command: ${command}`);
      printUsage();
      process.exitCode = 1;
  }
}

/**
 * `skills` 子命令分发：`list`（缺省）列名单；`get <name>` 输出单篇全文；
 * `get --all` 输出全部（拼接后供 agent 一次性加载）。全部读本地包内文件，不依赖 server。
 */
function handleSkills(args: string[], jsonMode: boolean): void {
  const sub = args[0];

  if (!sub || sub === 'list') {
    const skills = listSkills();
    if (jsonMode) { printJson(skills.map(s => s.name)); return; }
    if (skills.length === 0) {
      process.stdout.write('No skills available\n');
      return;
    }
    process.stdout.write('Available skills:\n');
    for (const s of skills) {
      process.stdout.write(`  - ${s.name}\n`);
    }
    return;
  }

  if (sub === 'get') {
    const allFlag = hasFlag(args, '--all');
    if (allFlag) {
      process.stdout.write(getAllSkillsContent());
      return;
    }
    const name = args[1];
    if (!name) {
      printError('Usage: skills get <name> | skills get --all');
      process.exitCode = 1;
      return;
    }
    const content = getSkillContent(name);
    if (!content) {
      printError(`Skill "${name}" not found`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(content);
    return;
  }

  printError(`Unknown skills subcommand: ${sub}`);
  process.exitCode = 1;
}

/** 帮助文本（输出保持英文：CLI 面向终端/脚本消费，与命令名、旗标同语言）。 */
function printUsage(): void {
  process.stdout.write(`cdp-autorouter-cli - Control plane client for cdp-autorouter

Usage: cdp-autorouter-cli [--port <port>] [--json] <command> [args]

Commands:
  connect [port]       Save port to ./.autorouter (default: 3100)
  connect [port] --global   Save to ~/.autorouter (machine-wide fallback)
  disconnect           Remove nearest .autorouter (falls back to ~/.autorouter)
  list                 List all instances (with live health check)
  create               Create instance (--id <id> --mode <mode> [--browser-url <url>])
  start <id>           Start instance
  stop <id>            Stop instance
  restart <id>         Restart instance
  switch <id>          Switch default instance
  status <id>          Show instance status
  delete <id>          Delete instance
  get-ws [id]          Output wsEndpoint URL (for \$() consumption)
  skills               List available skills
  skills get <name>    Output skill content
  skills get --all     Output all skills

Port resolution: --port > AUTOROUTER_URL env > .autorouter (cwd upward) > ~/.autorouter > 3100
`);
}

// 顶层兜底：任何未捕获异常都转成一行 stderr 错误 + 非零退出码，
// 保证脚本消费方能靠 exit code 判定失败，而不是看到裸堆栈。
main().catch((err: unknown) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});