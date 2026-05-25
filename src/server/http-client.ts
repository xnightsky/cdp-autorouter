/**
 * 下游 Chrome HTTP 端点的最小 JSON 请求封装。
 *
 * 兼容层只使用少量已知 JSON 路由，因此一个小封装就足够，
 * 同时保持错误报告的统一性。
 */
export async function fetchJson<T>(
  input: string | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);

  if (!response.ok) {
    throw new Error(`Downstream request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}
