/**
 * chrome-devtools-mcp 启动参数通过 autorouter 自动升级的工具函数。
 *
 * 当 `--browserUrl` 指向 autorouter 实例路径（如 `/instances/myid`）时，
 * 自动请求 `/json/version` 获取 tokenized wsEndpoint，将参数升级为 `--wsEndpoint`。
 */

interface ParsedOption {
  index: number;
  name: string;
  value: string;
  inlineValue: boolean;
}

/** 在 CLI 参数列表中查找指定名称的选项，支持 `--name value` 和 `--name=value` 两种格式。 */
function findOption(args: string[], names: string[]): ParsedOption | null {
  for (let index = 0; index < args.length; index += 1) {
    const current = String(args[index] || '');
    for (const name of names) {
      if (current === name) {
        const value = args[index + 1];
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(`Missing value for option ${name}`);
        }
        return {index, name, value, inlineValue: false};
      }
      if (current.startsWith(`${name}=`)) {
        return {
          index,
          name,
          value: current.slice(name.length + 1),
          inlineValue: true,
        };
      }
    }
  }
  return null;
}

/** 从参数列表中移除指定选项（含其值）。 */
function removeOption(args: string[], option: ParsedOption): string[] {
  const copied = [...args];
  copied.splice(option.index, option.inlineValue ? 1 : 2);
  return copied;
}

/**
 * 检测 browserUrl 是否指向 autorouter 实例。
 *
 * 同时识别当前格式 `/instances/{id}` 和旧格式 `/instance(\d+)`。
 * 返回用于获取 wsEndpoint 的 version URL。
 */
export function resolveAutorouterInstanceVersionUrl(browserUrl: string): {
  instancePath: string;
  versionUrl: string;
} | null {
  const parsed = new URL(String(browserUrl));
  const pathname = (parsed.pathname || '').replace(/\/+$/g, '');

  // 当前格式：/instances/{id_or_name}
  const currentMatch = pathname.match(/^\/instances\/([^/]+)$/);
  if (currentMatch) {
    return {
      instancePath: pathname,
      versionUrl: `${parsed.protocol}//${parsed.host}${pathname}/json/version`,
    };
  }

  // 旧格式：/instance(\d+)
  if (/^\/instance[^/]+$/i.test(pathname)) {
    return {
      instancePath: pathname,
      versionUrl: `${parsed.protocol}//${parsed.host}${pathname}/json/version`,
    };
  }

  return null;
}

/**
 * 将指向 autorouter 实例的 browserUrl 解析为 wsEndpoint。
 *
 * 请求实例路径下的 `/json/version`，提取 `webSocketDebuggerUrl`。
 * 若 URL 不匹配实例路径格式则返回 null。
 *
 * @param browserUrl - chrome-devtools-mcp 的 browserUrl 参数。
 * @param options.fetchImpl - 可注入的 fetch 实现，用于测试。
 * @param options.timeoutMs - 请求超时毫秒数（默认 5000）。
 */
export async function resolveAutorouterWsEndpoint(
  browserUrl: string,
  {fetchImpl = fetch, timeoutMs = 5000}: {fetchImpl?: typeof fetch; timeoutMs?: number} = {},
): Promise<{instancePath: string; versionUrl: string; wsEndpoint: string} | null> {
  const versionTarget = resolveAutorouterInstanceVersionUrl(browserUrl);
  if (!versionTarget) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(versionTarget.versionUrl, {
      method: 'GET',
      headers: {Accept: 'application/json'},
      signal: controller.signal,
    });

    if (!response?.ok) {
      throw new Error(
        `AutoRouter 实例端点解析失败: ${response?.status ?? 'unknown'}`,
      );
    }

    const payload = (await response.json()) as {webSocketDebuggerUrl?: string};
    const wsEndpoint = payload?.webSocketDebuggerUrl;
    if (typeof wsEndpoint !== 'string' || wsEndpoint.length === 0) {
      throw new Error(`${versionTarget.versionUrl} 响应中缺少 webSocketDebuggerUrl`);
    }

    return {...versionTarget, wsEndpoint};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 为 chrome-devtools-mcp 计算最终启动参数。
 *
 * - 若已有 `--wsEndpoint`，原样返回。
 * - 若 `--browserUrl` 指向 autorouter 实例路径，自动升级为 `--wsEndpoint`。
 * - 解析失败时 graceful fallback，返回原始参数。
 *
 * @param args - 原始 CLI 参数列表。
 * @param options.fetchImpl - 可注入的 fetch 实现，用于测试。
 */
export async function resolveChromeDevToolsMcpLaunchArgs(
  args: string[],
  {fetchImpl = fetch}: {fetchImpl?: typeof fetch} = {},
): Promise<string[]> {
  const sourceArgs = [...args];
  if (findOption(sourceArgs, ['--wsEndpoint'])) {
    return sourceArgs;
  }

  const browserUrlOption = findOption(sourceArgs, ['--browserUrl', '--browser-url']);
  if (!browserUrlOption) {
    return sourceArgs;
  }

  try {
    const wsTarget = await resolveAutorouterWsEndpoint(browserUrlOption.value, {fetchImpl});
    if (!wsTarget) {
      return sourceArgs;
    }
    const withoutBrowserUrl = removeOption(sourceArgs, browserUrlOption);
    return [...withoutBrowserUrl, `--wsEndpoint=${wsTarget.wsEndpoint}`];
  } catch {
    // 解析失败时不阻塞启动，返回原始参数
    return sourceArgs;
  }
}
