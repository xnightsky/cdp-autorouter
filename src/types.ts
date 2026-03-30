import type {ChildProcess} from 'node:child_process';

/**
 * Describes how an instance reaches a real browser.
 *
 * - `managed`: autorouter launches and owns the browser process lifecycle.
 * - `attached`: autorouter only connects to an already running browser.
 */
export type InstanceMode = 'managed' | 'attached';

/**
 * Tracks who created the in-memory instance record.
 *
 * The source matters because the default instance can be recreated from `.env`
 * even after a runtime delete, while API-created instances disappear on restart.
 */
export type InstanceSource = 'env-bootstrap' | 'api-runtime';

/**
 * Models the coarse-grained runtime lifecycle for a browser instance.
 *
 * The state machine is intentionally simple for v1 so that the HTTP compat
 * layer, Admin API, and cleanup logic all share the same vocabulary.
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
 * Static instance definition as stored in the in-memory registry.
 *
 * This is the "configuration" half of an instance. Dynamic health and process
 * information live in {@link InstanceRuntimeState}.
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
 * Dynamic runtime state that changes while autorouter is running.
 *
 * In particular, managed process handles and heartbeat metadata should never be
 * treated as persistent configuration.
 */
export interface InstanceRuntimeState {
  status: InstanceStatus;
  version?: string;
  protocolVersion?: string;
  extensionsSummary: string[];
  lastHeartbeatAt?: string;
  lastError?: string;
  managedProcess?: ChildProcess;
  managedProcessPid?: number;
  autoCreatedUserDataDir?: boolean;
}

/**
 * Full in-memory instance model used by the HTTP compat layer, Admin API, and
 * supervisor logic.
 */
export interface RuntimeInstance extends InstanceDefinition, InstanceRuntimeState {}

/**
 * Parsed `.env` strategy used to bootstrap the service.
 *
 * `.env` intentionally stores only global compat policy plus the default
 * instance template. Runtime-created instances stay in memory only.
 */
export interface EnvPolicy {
  compatModeEnabled: boolean;
  compatLazyLoadEnabled: boolean;
  serverHost: string;
  serverPort: number;
  defaultInstanceTemplate?: Omit<InstanceDefinition, 'source'>;
}

/**
 * One temporary token that maps an external autorouter WS URL to a concrete
 * downstream Chrome WS endpoint.
 */
export interface RouteBinding {
  token: string;
  instanceId: string;
  downstreamWsUrl: string;
  kind: 'browser' | 'page';
  createdAt: number;
}
