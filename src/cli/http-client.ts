/**
 * CLI HTTP 客户端 — 封装对 autorouter Admin API 的调用。
 *
 * 零额外依赖，使用 node 内置 fetch。
 */

/** 单次请求超时时间，防止 autorouter 无响应时 CLI 永久挂起。 */
const REQUEST_TIMEOUT_MS = 10_000;

export interface CliResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/** 统一的 HTTP 请求封装，带超时控制和结构化错误响应。 */
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
    try { data = JSON.parse(text) as T; } catch { /* 非 JSON 响应，忽略解析失败 */ }

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

// --- 公开 API 方法 ---

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

/** 获取实例的 webSocketDebuggerUrl（从 /instances/{id}/json/version 提取）。 */
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
