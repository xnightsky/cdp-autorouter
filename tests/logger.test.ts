import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

import {createLogger, createOperationLogger} from '../src/server/logger.js';
import type {LogLevel} from '../src/server/types.js';

let tmpDir = '';
let stderrSpy: any;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy?.mockRestore();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function getStderrLines(): string[] {
  return stderrSpy!
    .mock.calls.map((call: unknown[]) => (call[0] as Buffer | string).toString())
    .filter(Boolean);
}

describe('level filtering', () => {
  test.each<[LogLevel, LogLevel, boolean]>([
    ['debug', 'debug', true],
    ['debug', 'info', true],
    ['debug', 'warn', true],
    ['debug', 'error', true],
    ['info', 'debug', false],
    ['info', 'info', true],
    ['info', 'warn', true],
    ['info', 'error', true],
    ['warn', 'debug', false],
    ['warn', 'info', false],
    ['warn', 'warn', true],
    ['warn', 'error', true],
    ['error', 'debug', false],
    ['error', 'info', false],
    ['error', 'warn', false],
    ['error', 'error', true],
    ['silent', 'error', false],
    ['silent', 'debug', false],
  ])('level=%s logs %s => %s', (loggerLevel, msgLevel, expected) => {
    const logger = createLogger({level: loggerLevel, format: 'pretty'});
    (logger as any)[msgLevel]('hello');
    const lines = getStderrLines();
    expect(lines.length > 0).toBe(expected);
  });
});

describe('pretty format', () => {
  test('includes ISO timestamp and level label', () => {
    const logger = createLogger({level: 'info', format: 'pretty'});
    logger.info('test message');
    const lines = getStderrLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[.*INFO.*\] test message\n$/);
  });

  test('includes ANSI color codes', () => {
    const logger = createLogger({level: 'info', format: 'pretty'});
    logger.info('colored');
    const lines = getStderrLines();
    expect(lines[0]).toContain('\x1b[');
  });

  test('appends context as inline JSON', () => {
    const logger = createLogger({level: 'info', format: 'pretty'});
    logger.info('ctx', {a: 1});
    const lines = getStderrLines();
    expect(lines[0]).toContain('{"a":1}');
  });
});

describe('json format', () => {
  test('outputs valid JSON per line', () => {
    const logger = createLogger({level: 'info', format: 'json'});
    logger.info('json msg', {key: 'value'});
    const lines = getStderrLines();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({level: 'info', msg: 'json msg', key: 'value'});
    expect(typeof parsed.timestamp).toBe('string');
  });
});

describe('silent level', () => {
  test('produces zero stderr output', () => {
    const logger = createLogger({level: 'silent', format: 'pretty'});
    logger.error('err');
    logger.warn('warn');
    logger.info('info');
    logger.debug('debug');
    expect(getStderrLines()).toHaveLength(0);
  });

  test('does not create log file', () => {
    const filePath = path.join(tmpDir, 'silent.log');
    const logger = createLogger({level: 'silent', format: 'pretty', file: filePath});
    logger.info('should not appear');
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('file output', () => {
  test('writes to file', () => {
    const filePath = path.join(tmpDir, 'out.log');
    const logger = createLogger({level: 'info', format: 'pretty', file: filePath});
    logger.info('file line');
    expect(fs.existsSync(filePath)).toBe(false); // 仍缓冲在内存中
    logger.destroy();
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('file line');
  });

  test('flush via destroy preserves all logs', async () => {
    const filePath = path.join(tmpDir, 'flush.log');
    const logger = createLogger({level: 'debug', format: 'json', file: filePath});
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    await logger.destroy();
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0]).msg).toBe('a');
    expect(JSON.parse(lines[3]).msg).toBe('d');
  });
});

describe('file rotation', () => {
  test('rotates when max size exceeded', () => {
    const filePath = path.join(tmpDir, 'rotate.log');
    const logger = createLogger({
      level: 'info',
      format: 'pretty',
      file: filePath,
      fileMaxSize: 20,
      fileMaxFiles: 2,
    });
    logger.info('first');
    logger.destroy();
    expect(fs.existsSync(filePath)).toBe(true);

    const logger2 = createLogger({
      level: 'info',
      format: 'pretty',
      file: filePath,
      fileMaxSize: 20,
      fileMaxFiles: 2,
    });
    logger2.info('second rotation trigger');
    logger2.destroy();

    // 原文件应已被轮转
    expect(fs.existsSync(path.join(tmpDir, 'rotate.1.log'))).toBe(true);
  });
});

describe('options immutability', () => {
  test('returns frozen options copy', () => {
    const opts = {level: 'warn' as LogLevel, format: 'json' as const};
    const logger = createLogger(opts);
    expect(Object.isFrozen(logger.options)).toBe(true);
    expect(logger.options.level).toBe('warn');
  });
});

describe('operation logger', () => {
  test('writes JSON lines when enabled', () => {
    const logDir = path.join(tmpDir, 'ops');
    const opLogger = createOperationLogger({enabled: true, logDir, component: 'server'});
    opLogger.log('instance:start', {instanceId: 'dev'});
    opLogger.destroy();

    const filePath = path.join(logDir, 'server-operations.log');
    expect(fs.existsSync(filePath)).toBe(true);
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({component: 'server', operation: 'instance:start', instanceId: 'dev'});
    expect(typeof parsed.timestamp).toBe('string');
  });

  test('creates log directory if missing', () => {
    const logDir = path.join(tmpDir, 'nested', 'ops');
    const opLogger = createOperationLogger({enabled: true, logDir, component: 'cli'});
    opLogger.log('cli:command', {command: 'list'});
    opLogger.destroy();

    expect(fs.existsSync(path.join(logDir, 'cli-operations.log'))).toBe(true);
  });

  test('is no-op when disabled', () => {
    const logDir = path.join(tmpDir, 'disabled');
    const opLogger = createOperationLogger({enabled: false, logDir, component: 'server'});
    opLogger.log('ignored');
    opLogger.destroy();

    expect(fs.existsSync(logDir)).toBe(false);
  });

  test('separates server and cli log files', () => {
    const logDir = path.join(tmpDir, 'both');
    const serverLogger = createOperationLogger({enabled: true, logDir, component: 'server'});
    const cliLogger = createOperationLogger({enabled: true, logDir, component: 'cli'});
    serverLogger.log('server:start');
    cliLogger.log('cli:command');
    serverLogger.destroy();
    cliLogger.destroy();

    const serverContent = fs.readFileSync(path.join(logDir, 'server-operations.log'), 'utf8');
    const cliContent = fs.readFileSync(path.join(logDir, 'cli-operations.log'), 'utf8');
    expect(serverContent).toContain('server:start');
    expect(cliContent).toContain('cli:command');
    expect(serverContent).not.toContain('cli:command');
    expect(cliContent).not.toContain('server:start');
  });
});
