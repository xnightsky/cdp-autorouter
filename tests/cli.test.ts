import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  resolveEndpoint,
  writeConfigFile,
  removeConfigFile,
  findConfigFile,
  readConfigFile,
} from '../src/cli/resolve-port.js';

describe('resolve-port', () => {
  let tmpDir: string;
  /** 隔离的假 home：避免开发机上真实存在的 ~/.autorouter 污染断言 */
  let fakeHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
    fakeHome = path.join(tmpDir, 'fake-home');
    fs.mkdirSync(fakeHome);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeConfigFile / readConfigFile', () => {
    test('writes and reads port correctly', () => {
      const filePath = writeConfigFile(tmpDir, 9300);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(readConfigFile(filePath)).toBe(9300);
    });

    test('returns null for invalid config', () => {
      const filePath = path.join(tmpDir, '.autorouter');
      fs.writeFileSync(filePath, 'not json', 'utf8');
      expect(readConfigFile(filePath)).toBe(null);
    });
  });

  describe('findConfigFile', () => {
    test('finds config in current directory', () => {
      writeConfigFile(tmpDir, 3100);
      expect(findConfigFile(tmpDir, fakeHome)).toBe(path.join(tmpDir, '.autorouter'));
    });

    test('finds config in parent directory', () => {
      writeConfigFile(tmpDir, 3100);
      const subDir = path.join(tmpDir, 'sub');
      fs.mkdirSync(subDir);
      expect(findConfigFile(subDir, fakeHome)).toBe(path.join(tmpDir, '.autorouter'));
    });

    test('falls back to ~/.autorouter when upward search misses', () => {
      // cwd 树上没有档案、全局有 → 应命中全局（树外兜底语义）
      writeConfigFile(fakeHome, 9223);
      const deep = path.join(tmpDir, 'a', 'b', 'c');
      fs.mkdirSync(deep, { recursive: true });
      expect(findConfigFile(deep, fakeHome)).toBe(path.join(fakeHome, '.autorouter'));
    });

    test('local config wins over ~/.autorouter', () => {
      // 就近优先：目录级与全局同时存在时取目录级
      writeConfigFile(fakeHome, 9223);
      writeConfigFile(tmpDir, 5555);
      expect(findConfigFile(tmpDir, fakeHome)).toBe(path.join(tmpDir, '.autorouter'));
    });

    test('returns null when no config exists', () => {
      // tmpDir has no .autorouter, but parent dirs might
      // Use a deeply nested temp dir to reduce chance of false positive
      const deep = path.join(tmpDir, 'a', 'b', 'c');
      fs.mkdirSync(deep, { recursive: true });
      expect(findConfigFile(deep, fakeHome)).toBe(null);
    });
  });

  describe('removeConfigFile', () => {
    test('removes existing config file', () => {
      writeConfigFile(tmpDir, 3100);
      expect(removeConfigFile(tmpDir, fakeHome)).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.autorouter'))).toBe(false);
    });

    test('removes ~/.autorouter when it is the discovered one', () => {
      // 本地树上没有 → disconnect 删到全局那份（与发现顺序一致）
      writeConfigFile(fakeHome, 9223);
      const deep = path.join(tmpDir, 'x', 'y');
      fs.mkdirSync(deep, { recursive: true });
      expect(removeConfigFile(deep, fakeHome)).toBe(true);
      expect(fs.existsSync(path.join(fakeHome, '.autorouter'))).toBe(false);
    });

    test('returns false when no config exists', () => {
      const deep = path.join(tmpDir, 'x', 'y');
      fs.mkdirSync(deep, { recursive: true });
      expect(removeConfigFile(deep, fakeHome)).toBe(false);
    });
  });

  describe('resolveEndpoint', () => {
    test('--port flag takes highest priority', () => {
      writeConfigFile(tmpDir, 9000);
      const result = resolveEndpoint({
        portFlag: 8888,
        env: { AUTOROUTER_URL: 'http://localhost:7777' },
        cwd: tmpDir,
      });
      expect(result.port).toBe(8888);
      expect(result.baseUrl).toBe('http://127.0.0.1:8888');
    });

    test('AUTOROUTER_URL env is second priority', () => {
      writeConfigFile(tmpDir, 9000);
      const result = resolveEndpoint({
        env: { AUTOROUTER_URL: 'http://localhost:7777' },
        cwd: tmpDir,
      });
      expect(result.port).toBe(7777);
    });

    test('.autorouter file is third priority', () => {
      writeConfigFile(tmpDir, 5555);
      const result = resolveEndpoint({ env: {}, cwd: tmpDir, home: fakeHome });
      expect(result.port).toBe(5555);
    });

    test('~/.autorouter is fourth priority (before default)', () => {
      writeConfigFile(fakeHome, 9223);
      const deep = path.join(tmpDir, 'no', 'config');
      fs.mkdirSync(deep, { recursive: true });
      const result = resolveEndpoint({ env: {}, cwd: deep, home: fakeHome });
      expect(result.port).toBe(9223);
    });

    test('defaults to 3100', () => {
      const deep = path.join(tmpDir, 'no', 'config');
      fs.mkdirSync(deep, { recursive: true });
      const result = resolveEndpoint({ env: {}, cwd: deep, home: fakeHome });
      expect(result.port).toBe(3100);
      expect(result.baseUrl).toBe('http://127.0.0.1:3100');
    });
  });
});
