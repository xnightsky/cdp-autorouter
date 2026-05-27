/**
 * autorouter 路径模板匹配器。
 *
 * 仅支持三种语法（autorouter 不需要更多）：
 *   :name    必选参数（单个路径段）
 *   :name?   可选参数（单个路径段，可缺席）
 *   *        贪婪匹配（匹配剩余所有内容，含斜杠）
 *
 * 编译为单个锚定正则 + 有序捕获名列表。
 * 注意：`:name?` 只让参数段本身可选，不能让前面的字面量段也可选。
 * 如需“整个前缀可选”，应注册两条 route（有前缀 + 无前缀）。
 */

/** 编译后的路径模板，提供 match 方法用于路由分派。 */
export interface CompiledPattern {
  /** 尝试匹配路径，命中返回参数字典，未命中返回 null。 */
  match(path: string): Record<string, string> | null;
  /** 原始模板字符串，保留用于调试日志。 */
  readonly template: string;
}

/** 检测参数段语法：`:name` 或 `:name?` */
const PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)(\?)?$/;

/**
 * 将路径模板编译为 CompiledPattern。
 *
 * 编译过程：按 `/` 分割模板，逐段生成正则片段，最终拼接为单个锚定正则。
 * 可选参数的处理：弹出前一个 `/` 分隔符，将其与参数一起包在 `(?:/([^/]+))?` 可选组内。
 */

export function compile(template: string): CompiledPattern {
  if (!template.startsWith('/')) {
    throw new Error(`Pattern must start with '/': ${template}`);
  }

  const segments = template.split('/').slice(1);
  const captureNames: string[] = [];
  const reParts: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    // catch-all: 贪婪匹配剩余所有内容，必须是最后一段
    if (seg === '*') {
      if (i !== segments.length - 1) {
        throw new Error(`'*' must be the final segment: ${template}`);
      }
      captureNames.push('*');
      reParts.push('(.*)');
      continue;
    }
    const paramMatch = PARAM_RE.exec(seg);
    if (paramMatch) {
      const [, name, optional] = paramMatch;
      captureNames.push(name!);
      if (optional) {
        // 可选参数：弹出前一个 '/' 分隔符，将 '/' + 参数整体包在可选组内。
        // 这样当参数缺席时，前面的 '/' 也不会出现在路径中。
        if (reParts.length === 0 || reParts[reParts.length - 1] !== '/') {
          throw new Error(`Optional param requires a preceding slash: ${template}`);
        }
        reParts.pop();
        reParts.push('(?:/([^/]+))?');
      } else {
        reParts.push('([^/]+)');
      }
    } else {
      reParts.push(seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    }
    if (i < segments.length - 1) {
      reParts.push('/');
    }
  }

  // 拼接所有片段为单个锚定正则（^/...$）
  const re = new RegExp('^/' + reParts.join('') + '$');

  return {
    template,
    match(path: string) {
      const m = re.exec(path);
      if (!m) return null;
      // 按捕获名顺序提取参数，并对值做 URL 解码
      const params: Record<string, string> = {};
      for (let i = 0; i < captureNames.length; i++) {
        const value = m[i + 1];
        if (value !== undefined) {
          params[captureNames[i]!] = decodeURIComponent(value);
        }
      }
      return params;
    },
  };
}
