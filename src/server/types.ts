import type {ChildProcess} from 'node:child_process';

/**
 * autorouter logger 的级别顺序。
 *
 * `silent` 完全静默；`debug` 最详细。
 */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/**
 * {@link createLogger} 使用的配置。
 */
export interface LoggerOptions {
  /** 最低输出级别。 */
  level: LogLevel;
  /** 输出风格：`pretty`（带 ANSI 颜色）或 `json`（单行 JSON）。 */
  format: 'pretty' | 'json';
  /** 可选日志文件的绝对或相对路径。 */
  file?: string;
  /** 触发轮转的文件大小上限，单位字节（默认 10 MB）。 */
  fileMaxSize?: number;
  /** 保留的轮转备份数量（默认 3）。 */
  fileMaxFiles?: number;
}

/**
 * autorouter 全局使用的最小 logger 接口。
 *
 * 所有实现都必须支持 `destroy()`，以便干净退出。
 */
export interface Logger {
  /** 输出 error 级别日志。 */
  error(msg: string, ctx?: Record<string, unknown>): void;
  /** 输出 warn 级别日志。 */
  warn(msg: string, ctx?: Record<string, unknown>): void;
  /** 输出 info 级别日志。 */
  info(msg: string, ctx?: Record<string, unknown>): void;
  /** 输出 debug 级别日志。 */
  debug(msg: string, ctx?: Record<string, unknown>): void;
  /** 关闭并刷盘所有待写入日志。进程退出前必须调用。 */
  destroy(): Promise<void>;
  /** 当前 logger 配置，供测试断言使用。 */
  options: Readonly<LoggerOptions>;
}

/**
 * 描述实例如何连接到真实浏览器。
 *
 * - `managed`：autorouter 自己启动并管理浏览器进程生命周期。
 * - `attached`：autorouter 只连接到已运行的浏览器。
 */
export type InstanceMode = 'managed' | 'attached';

/**
 * 追踪内存中实例记录的创建来源。
 *
 * 来源很重要，因为默认实例可以在运行时被删除后从 `.env` 重新创建，
 * 而 API 创建的实例在重启后会消失。
 */
export type InstanceSource = 'env-bootstrap' | 'api-runtime';

/**
 * 浏览器实例的粗粒度运行时生命周期。
 *
 * 状态机故意保持简单，让 HTTP 兼容层、Admin API 和清理逻辑共用同一套术语。
 */
export type InstanceStatus =
  | 'created'
  | 'starting'
  | 'healthy'
  | 'unhealthy'
  | 'stopping'
  | 'reclaiming'
  | 'stopped'
  | 'error';

/**
 * 内存注册表中存储的静态实例定义。
 *
 * 这是实例的"配置"半部分；动态健康和进程信息存放在 {@link InstanceRuntimeState} 中。
 */
export interface InstanceDefinition {
  instanceId: string;
  source: InstanceSource;
  mode: InstanceMode;
  browserUrl?: string;
  wsEndpoint?: string;
  userDataDir?: string;
  chromeLaunchArgs: string[];
  headless?: boolean;
  remoteDebuggingPort?: number;
  executablePath?: string;
}

/**
 * autorouter 运行期间会变化的动态运行时状态。
 *
 * 特别注意：managed 进程句柄和心跳元数据不应被视为持久配置。
 */
export interface InstanceRuntimeState {
  status: InstanceStatus;
  version?: string;
  protocolVersion?: string;
  extensionsSummary: string[];
  lastHeartbeatAt?: string;
  lastError?: string;
  pageCount?: number;
  managedProcess?: ChildProcess;
  managedProcessPid?: number;
  autoCreatedUserDataDir?: boolean;
}

/**
 * HTTP 兼容层、Admin API 和 supervisor 逻辑使用的完整内存实例模型。
 */
export interface RuntimeInstance extends InstanceDefinition, InstanceRuntimeState {}

/**
 * 从 `.env` 解析出的启动策略。
 *
 * `.env` 有意只存全局兼容策略和默认实例模板；运行时创建的实例仅存于内存。
 */
export interface EnvPolicy {
  compatModeEnabled: boolean;
  compatLazyLoadEnabled: boolean;
  trustProxy: boolean;
  serverHost: string;
  serverPort: number;
  /**
   * 默认实例嗅探自愈的单次重拉超时（毫秒）。
   *
   * 仅影响默认实例在根路径路由上的自愈路径；显式实例手动 restart 不受影响。
   * 超时后 HTTP 返回 503，默认 8000 ms。
   */
  restartTimeoutMs: number;
  logLevel: LogLevel;
  logFormat: 'pretty' | 'json';
  logFile?: string;
  defaultInstanceTemplate?: Omit<InstanceDefinition, 'source'>;
}

/**
 * 一个临时 token，将外部 autorouter WS URL 映射到具体的下游 Chrome WS 端点。
 */
export interface RouteBinding {
  token: string;
  instanceId: string;
  downstreamWsUrl: string;
  kind: 'browser' | 'page';
  createdAt: number;
}
