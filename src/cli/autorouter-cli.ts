#!/usr/bin/env node
/**
 * autorouter-cli — Control plane client entry point.
 *
 * Manual argv parsing, zero extra dependencies.
 */

import {
  resolveEndpoint,
  writeConfigFile,
  removeConfigFile,
} from './resolve-port.js';
import * as api from './http-client.js';
import { listSkills, getSkillContent, getAllSkillsContent } from './skills.js';

// --- argv parsing utilities ---

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

function hasFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name);
  if (idx >= 0) { args.splice(idx, 1); return true; }
  return false;
}

// --- output utilities ---

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function printError(msg: string): void {
  process.stderr.write(`Error: ${msg}\n`);
}

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

// --- main logic ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Global flags
  const portStr = extractFlag(args, '--port');
  const portFlag = portStr ? parseInt(portStr, 10) : undefined;
  const jsonMode = hasFlag(args, '--json');

  const command = args.shift();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  // connect/disconnect are local-only (no network)
  if (command === 'connect') {
    // connect takes a positional port arg (the port to persist)
    const port = parseInt(args[0] ?? String(portFlag ?? 3100), 10);
    if (!port || port <= 0) {
      printError('Invalid port number');
      process.exitCode = 1;
      return;
    }
    const filePath = writeConfigFile(process.cwd(), port);
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

  // skills subcommand is local-only (no network)
  if (command === 'skills') {
    handleSkills(args, jsonMode);
    return;
  }

  // Commands requiring network
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
      const id = args[0]; // optional — omit for default instance
      const res = await api.getWsEndpoint(baseUrl, id);
      if (!res.ok) { printError(res.error!); process.exitCode = 1; return; }
      // get-ws always outputs a single ws:// line to stdout
      process.stdout.write(res.data + '\n');
      return;
    }

    default:
      printError(`Unknown command: ${command}`);
      printUsage();
      process.exitCode = 1;
  }
}

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

function printUsage(): void {
  process.stdout.write(`autorouter-cli - Control plane client for chrome-devtools-mcp-autorouter

Usage: autorouter-cli [--port <port>] [--json] <command> [args]

Commands:
  connect [port]       Save port to .autorouter file (default: 3100)
  disconnect           Remove .autorouter file
  list                 List all instances
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

Port resolution: --port > AUTOROUTER_URL env > .autorouter file > 3100
`);
}

main().catch((err: unknown) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});