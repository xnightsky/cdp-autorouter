import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes} from 'node:crypto';

/**
 * TraceId：贯穿「CLI 命令 → HTTP 请求 → server 路由 → supervisor 生命周期」的关联标识。
 *
 * 设计动机（2026-09-01 排查实例）：default 实例懒加载弹浏览器、双 spawn 等问题，
 * 因 server/CLI 两侧日志互不关联而无法回溯。一个 traceId 串联两侧日志文件，
 * 用 `grep <traceId> data/logs/*.log` 即可还原完整链路。
 *
 * 传输协议：HTTP header `x-trace-id`（自定义单 header，不引入 W3C traceparent——
 * v1 无跨系统采样/层级需求，KISS）。server 响应恒回显该头，调用方可直接拿到 id 查日志。
 *
 * 内部传递用 AsyncLocalStorage：dispatch 入口 als.run 后，
 * handler → resolveInstance → supervisor.start → waitUntilAvailable 轮询
 * 整条异步链上的日志自动附带 traceId，现有 log 调用点零改动。
 * 已知边界：WS message pump 等事件驱动回调不在 ALS 异步链内，
 * 关键审计点（ws:connect/ws:close）须显式携带 traceId 字段兜底。
 */

/** 自定义 trace header 名（小写，HTTP/1.1 header 大小写不敏感，Node 一律按小写解析）。 */
export const TRACE_ID_HEADER = 'x-trace-id';

/**
 * 入站 traceId 白名单：字母数字 + `. _ : -`，最长 64。
 *
 * 安全动机：traceId 会原样写入日志文件，若不校验，外部客户端可注入换行符
 * 伪造日志行（log injection）。不合法的入站 id 一律丢弃，由 server 自生成。
 * 自生成格式 `t-<base36>-<hex>` 天然落在白名单内。
 */
const TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** 校验外部传入的 traceId；合法则原样返回，否则返回 undefined（调用方自生成）。 */
export function sanitizeIncomingTraceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return TRACE_ID_PATTERN.test(value) ? value : undefined;
}

const als = new AsyncLocalStorage<{traceId: string}>();

/**
 * 生成短 traceId：`t-<base36时间戳>-<4位hex随机>`，如 `t-mb4k9x-3f8a`。
 * 可排序、人眼可辨、零依赖（项目不引 uuid）。
 */
export function newTraceId(): string {
  return `t-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
}

/** 在指定 traceId 的上下文内执行 fn；fn 内部的同步/异步日志均可被 currentTraceId 读到。 */
export function runWithTraceId<T>(traceId: string, fn: () => T): T {
  return als.run({traceId}, fn);
}

/** 读取当前异步上下文的 traceId；不在任何 runWithTraceId 内时返回 undefined。 */
export function currentTraceId(): string | undefined {
  return als.getStore()?.traceId;
}
