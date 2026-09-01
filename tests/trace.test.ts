import {afterEach, describe, expect, test} from 'vitest';

import {createSilentLogger} from './helpers/mock-logger.js';
import {createAutorouterServer} from '../src/server/index.js';
import {newTraceId, runWithTraceId, sanitizeIncomingTraceId} from '../src/server/trace.js';

describe('trace id', () => {
  describe('newTraceId / sanitizeIncomingTraceId', () => {
    test('生成的 id 符合白名单格式且唯一', () => {
      const a = newTraceId();
      const b = newTraceId();
      expect(a).toMatch(/^t-[a-z0-9]+-[0-9a-f]{4}$/);
      expect(a).not.toBe(b);
      // 自生成 id 必须能过入站校验（否则 CLI → server 串联会断）
      expect(sanitizeIncomingTraceId(a)).toBe(a);
    });

    test('入站校验：合法透传，非法丢弃（防日志注入）', () => {
      expect(sanitizeIncomingTraceId('t-abc-1234')).toBe('t-abc-1234');
      expect(sanitizeIncomingTraceId('req_1.2:3-4')).toBe('req_1.2:3-4');
      expect(sanitizeIncomingTraceId(undefined)).toBeUndefined();
      expect(sanitizeIncomingTraceId('')).toBeUndefined();
      // 换行符伪造日志行
      expect(sanitizeIncomingTraceId('abc\n{"forged":true}')).toBeUndefined();
      // 超长
      expect(sanitizeIncomingTraceId('x'.repeat(65))).toBeUndefined();
      // 非法字符
      expect(sanitizeIncomingTraceId('bad id!')).toBeUndefined();
    });
  });

  describe('runWithTraceId / ALS 上下文', () => {
    test('上下文内可读，上下文外为 undefined', async () => {
      const {currentTraceId} = await import('../src/server/trace.js');
      expect(currentTraceId()).toBeUndefined();
      await runWithTraceId('t-test-0001', async () => {
        expect(currentTraceId()).toBe('t-test-0001');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(currentTraceId()).toBe('t-test-0001'); // 跨异步边界保持
      });
      expect(currentTraceId()).toBeUndefined();
    });

    test('并发上下文互不串扰', async () => {
      const {currentTraceId} = await import('../src/server/trace.js');
      const seen = await Promise.all(
        ['t-a-0001', 't-b-0002', 't-c-0003'].map(id =>
          runWithTraceId(id, async () => {
            await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
            return currentTraceId();
          }),
        ),
      );
      expect(seen).toEqual(['t-a-0001', 't-b-0002', 't-c-0003']);
    });
  });

  describe('server 端 x-trace-id 契约', () => {
    let autorouter: {close(): Promise<void>; origin: string} | undefined;

    afterEach(async () => {
      await autorouter?.close();
      autorouter = undefined;
    });

    async function boot() {
      autorouter = await createAutorouterServer({
        env: {
          SERVER_HOST: '127.0.0.1',
          SERVER_PORT: '0',
          COMPAT_MODE_ENABLED: 'false',
        },
        logger: createSilentLogger(),
      });
      return autorouter.origin;
    }

    test('无入站 id 时自生成并回显响应头', async () => {
      const origin = await boot();
      const res = await fetch(`${origin}/api/capabilities`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-trace-id')).toMatch(/^t-[a-z0-9]+-[0-9a-f]{4}$/);
    });

    test('合法入站 id 被采纳并原样回显', async () => {
      const origin = await boot();
      const res = await fetch(`${origin}/api/capabilities`, {
        headers: {'x-trace-id': 't-client-9abc'},
      });
      expect(res.headers.get('x-trace-id')).toBe('t-client-9abc');
    });

    test('非法入站 id 被丢弃，server 自生成', async () => {
      // 注：换行符级注入在 HTTP 客户端层就会被拒（undici/Node 均校验 header 字符），
      // 这里用「HTTP 合法但不满足白名单」的值验证 server 侧白名单生效；
      // 换行注入的防护由 sanitizeIncomingTraceId 单测覆盖。
      const origin = await boot();
      const res = await fetch(`${origin}/api/capabilities`, {
        headers: {'x-trace-id': 'bad id!'},
      });
      const echoed = res.headers.get('x-trace-id');
      expect(echoed).toMatch(/^t-[a-z0-9]+-[0-9a-f]{4}$/);
      expect(echoed).not.toContain('bad');
    });

    test('并发请求各自持有独立 traceId（ALS 不串）', async () => {
      const origin = await boot();
      const ids = ['t-conc-000a', 't-conc-000b', 't-conc-000c'];
      const echoed = await Promise.all(
        ids.map(async id => {
          const res = await fetch(`${origin}/api/capabilities`, {headers: {'x-trace-id': id}});
          return res.headers.get('x-trace-id');
        }),
      );
      expect(echoed).toEqual(ids);
    });
  });
});
