/**
 * Minimal JSON fetch helper for downstream Chrome HTTP endpoints.
 *
 * The compat layer uses only a handful of well-known JSON routes, so a small
 * wrapper is enough and keeps error reporting uniform.
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
