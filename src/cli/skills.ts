/**
 * skills 子命令实现 —— 列出/输出随 npm 包发布的 skill 文档。
 *
 * 动机：让 agent 在任何装了本 CLI 的机器上，通过 `skills get <name>` 一条命令
 * 拿到工具的使用说明（SKILL.md 全文），无需依赖联网或外部文档库。
 * skills/ 目录结构约定：`skills/<name>/SKILL.md`，目录名即 skill 名。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 定位 skills 目录。
 *
 * 难点：本文件的 __dirname 随运行形态漂移——
 *   源码直跑（tsx/vitest）：`src/cli/`   → 向上 2 层到项目根；
 *   编译产物运行：        `dist/src/cli/` → 向上 3 层到项目根。
 * 与其对形态分支，不如统一「向上逐层探测 skills/ 子目录」（上限 5 层防呆），
 * 两种形态自然都命中，将来目录结构小调也不易碎。
 */
function getSkillsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'skills');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  // 5 层内都没命中的兜底：按「编译产物」形态硬拼路径（即使不存在，
  // 上层 listSkills/getSkillContent 也会以 existsSync 优雅处理成空结果）
  return path.resolve(__dirname, '..', '..', '..', 'skills');
}

export interface SkillInfo {
  name: string;
  path: string;
}

/** 列出所有可用 skills（只认「目录 + 内含 SKILL.md」的条目，散文件/缺主文档的目录不算）。 */
export function listSkills(): SkillInfo[] {
  const dir = getSkillsDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .filter(e => fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map(e => ({ name: e.name, path: path.join(dir, e.name, 'SKILL.md') }));
}

/** 读取单个 skill 的 SKILL.md 全文；skill 不存在返回 null（由命令层报「not found」）。 */
export function getSkillContent(name: string): string | null {
  const dir = getSkillsDir();
  const skillPath = path.join(dir, name, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return null;
  return fs.readFileSync(skillPath, 'utf8');
}

/** 拼接输出全部 skills（`--- <name> ---` 分隔符便于 agent 按篇切分），供一次性整体加载。 */
export function getAllSkillsContent(): string {
  const skills = listSkills();
  if (skills.length === 0) return 'No skills available.';
  return skills
    .map(s => {
      const content = fs.readFileSync(s.path, 'utf8');
      return `--- ${s.name} ---\n${content}`;
    })
    .join('\n\n');
}
