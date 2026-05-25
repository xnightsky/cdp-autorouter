/**
 * CLI HTTP client — wraps calls to autorouter Admin API.
 *
 * Zero extra dependencies, uses node built-in fetch.
 */

const REQUEST_TIMEOUT_MS = 10_000;

export interface CliResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/** Generic HTTP request with unified response structure and timeout. */
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
    try { data = JSON.parse(text) as T; } catch { /* non-JSON response */ }

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

// --- Public API methods ---

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

/** Get instance webSocketDebuggerUrl (from /instances/{id}/json/version). */
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
