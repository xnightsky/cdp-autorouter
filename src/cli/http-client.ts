/**
 * CLI HTTP 客户端 —— 封装对 autorouter 控制面（Admin API）的全部调用。
 *
 * 设计取向：
 * - 零第三方依赖，直接用 Node ≥18 内置 fetch —— CLI 要能被 npm 全局装完即用，不背依赖树；
 * - 所有方法**永不 reject**，统一返回结构化 `CliResponse`（ok/status/data/error），
 *   把「HTTP 错误 / 连接失败 / 超时」都收敛成同一形状，让命令层只写一种错误处理。
 */

/** 单次请求超时（毫秒）。server 假死/端口被别的进程占用时，避免 CLI 永久挂起。 */
const REQUEST_TIMEOUT_MS = 10_000;

export interface CliResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/**
 * 统一的 HTTP 请求封装。
 *
 * - 超时用 AbortController 实现（fetch 本身没有超时参数），命中后归类为
 *   `Request timed out`，与「连接失败」区分开——前者多半是 server 假死，后者多半是端口不对/没起；
 * - 响应体先按文本读取再尝试 JSON.parse：控制面偶发返回纯文本错误页时不至于抛解析异常；
 * - 非 2xx 时依次从 `error`/`message`/原始文本里捞人类可读的错误信息。
 */
async function request<T = unknown>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<CliResponse<T>> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const init: RequestInit = { method, headers, signal: controller.signal };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(url, init);
    clearTimeout(timer);
    const text = await res.text();
    let data: T | undefined;
    try { data = JSON.parse(text) as T; } catch { /* 非 JSON 响应（如纯文本错误页）：data 留空，错误信息走下方 text 兜底 */ }

    if (!res.ok) {
      const errMsg = (data as Record<string, unknown>)?.error
        ?? (data as Record<string, unknown>)?.message
        ?? text
        ?? `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: String(errMsg) };
    }
    return { ok: true, status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      return { ok: false, status: 0, error: `Request timed out after ${REQUEST_TIMEOUT_MS}ms` };
    }
    return { ok: false, status: 0, error: `Connection failed: ${msg}` };
  }
}

// --- 公开 API 方法：与 server 的 /api/instances 系列路由一一对应 ---

export function listInstances(baseUrl: string): Promise<CliResponse> {
  return request(baseUrl, 'GET', '/api/instances');
}

export function createInstance(
  baseUrl: string,
  body: { instanceId: string; mode: string; browserUrl?: string; wsEndpoint?: string },
): Promise<CliResponse> {
  return request(baseUrl, 'POST', '/api/instances', body);
}

export function startInstance(baseUrl: string, id: string): Promise<CliResponse> {
  return request(baseUrl, 'POST', `/api/instances/${encodeURIComponent(id)}/start`);
}

export function stopInstance(baseUrl: string, id: string): Promise<CliResponse> {
  return request(baseUrl, 'POST', `/api/instances/${encodeURIComponent(id)}/stop`);
}

export function restartInstance(baseUrl: string, id: string): Promise<CliResponse> {
  return request(baseUrl, 'POST', `/api/instances/${encodeURIComponent(id)}/restart`);
}

export function switchInstance(baseUrl: string, id: string): Promise<CliResponse> {
  return request(baseUrl, 'POST', `/api/instances/${encodeURIComponent(id)}/switch`);
}

export function getInstanceStatus(baseUrl: string, id: string): Promise<CliResponse> {
  return request(baseUrl, 'GET', `/api/instances/${encodeURIComponent(id)}/status`);
}

export function deleteInstance(baseUrl: string, id: string): Promise<CliResponse> {
  return request(baseUrl, 'DELETE', `/api/instances/${encodeURIComponent(id)}`);
}

/**
 * 获取实例的 CDP wsEndpoint（`webSocketDebuggerUrl`）。
 *
 * 走的是 server 的 **CDP 兼容路由**（`/instances/{id}/json/version`，模拟 Chrome 自身的
 * `/json/version` 端点），不是 Admin API；省略 id 时打根路径 = 默认实例。
 * 返回的 ws:// 地址指向 **server 的路由端口**（由 server 转发到实例），
 * 所以只要 server 端口可达（含 ssh 转发场景），任何 CDP 客户端都能直接消费。
 */
export async function getWsEndpoint(baseUrl: string, id?: string): Promise<CliResponse<string>> {
  const path = id
    ? `/instances/${encodeURIComponent(id)}/json/version`
    : '/json/version';
  const res = await request<{ webSocketDebuggerUrl?: string }>(baseUrl, 'GET', path);
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  const wsUrl = res.data?.webSocketDebuggerUrl;
  if (!wsUrl) {
    return { ok: false, status: res.status, error: 'webSocketDebuggerUrl not found in response' };
  }
  return { ok: true, status: res.status, data: wsUrl };
}
