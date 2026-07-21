import type http from 'node:http';
import type {Duplex} from 'node:stream';

import type {WebSocket, WebSocketServer} from 'ws';

import type {ChildBrowserSupervisor} from '../child-browser-supervisor.js';
import type {DefaultInstanceResolver} from '../default-instance-resolver.js';
import type {RouteBindingStore} from '../route-bindings.js';
import type {RuntimeRegistry} from '../runtime-registry.js';
import type {EnvPolicy, Logger, OperationLogger, RuntimeInstance} from '../types.js';
import type {CompiledPattern} from './pattern.js';

/**
 * 携带 HTTP 状态码的内部错误，让 dispatch catch 块能区分 503（上游不可达 / 重启超时）与 500（autorouter 自身 bug）。
 * 仅在默认路径懒探死路径上使用。
 */
export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** HTTP 方法枚举，仅包含 autorouter 实际使用的方法。 */
export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * 路由上下文：所有 handler 共享的依赖注入容器。
 *
 * 关键设计：`currentDefaultInstanceId` 通过 getter/setter 暴露，
 * 保证所有 handler 共享同一份状态（switch 写入后 capabilities 立即可见）。
 */
export interface RouteContext {
  readonly policy: EnvPolicy;
  readonly logger: Logger;
  readonly operationLogger: OperationLogger;
  readonly registry: RuntimeRegistry;
  readonly bindings: RouteBindingStore;
  readonly supervisor: ChildBrowserSupervisor;
  readonly defaultResolver: DefaultInstanceResolver;
  readonly packageVersion: string;
  readonly activeSockets: Set<WebSocket>;
  readonly wsServer: WebSocketServer;
  getDefaultInstanceId(): string | undefined;
  setDefaultInstanceId(id: string): void;
  /** 解析实例并确保其可用（含懒加载和 self-heal 逻辑）。 */
  resolveInstance(id: string | undefined, method: 'http' | 'ws'): Promise<RuntimeInstance>;
  /** 解析请求的公开 host（支持 x-forwarded-host），用于 URL 生成。 */
  resolvePublicHost(req: http.IncomingMessage): string;
}

/** HTTP 路由处理器类型。 */
export type HttpHandler = (
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;

/** WebSocket upgrade 处理器类型。 */
export type WsHandler = (
  ctx: RouteContext,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  params: Record<string, string>,
) => Promise<void> | void;

/**
 * 路由定义：HTTP 或 WS，共用同一张 Route[] 表，由各自的 dispatcher 按 kind 过滤。
 */
export type Route =
  | { kind: 'http'; methods: Method[]; pattern: CompiledPattern; handle: HttpHandler }
  | { kind: 'ws'; pattern: CompiledPattern; handle: WsHandler };
