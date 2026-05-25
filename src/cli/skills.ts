/**
 * skills 子命令 — 列出和输出打包在 CLI 中的 skill 内容。
 *
 * skills/ 目录随 npm 包发布，CLI 从中读取完整 skill 内容。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 定位 skills 目录。
 * 源码运行（tsx/vitest）：__dirname = src/cli/ → 向上 2 层到项目根
 * 编译后运行：__dirname = dist/src/cli/ → 向上 3 层到项目根
 */
function getSkillsDir(): string {
  // 从当前位置向上查找 skills 目录
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'skills');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  // fallback
  return path.resolve(__dirname, '..', '..', '..', 'skills');
}

export interface SkillInfo {
  name: string;
  path: string;
}

/** 列出所有可用 skills。 */
export function listSkills(): SkillInfo[] {
  const dir = getSkillsDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .filter(e => fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map(e => ({ name: e.name, path: path.join(dir, e.name, 'SKILL.md') }));
}

/** 获取单个 skill 的完整内容。 */
export function getSkillContent(name: string): string | null {
  const dir = getSkillsDir();
  const skillPath = path.join(dir, name, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return null;
  return fs.readFileSync(skillPath, 'utf8');
}

/** 获取所有 skills 的内容，以分隔符连接。 */
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
