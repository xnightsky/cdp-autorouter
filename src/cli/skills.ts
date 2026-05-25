/**
 * skills subcommand — list and output skill content bundled with the CLI.
 *
 * skills/ directory ships with the npm package; CLI reads full skill content from it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate skills directory.
 * Source run (tsx/vitest): __dirname = src/cli/ → 2 levels up to project root
 * Compiled run: __dirname = dist/src/cli/ → 3 levels up to project root
 */
function getSkillsDir(): string {
  // Walk up from current location to find skills directory
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

/** List all available skills. */
export function listSkills(): SkillInfo[] {
  const dir = getSkillsDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .filter(e => fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map(e => ({ name: e.name, path: path.join(dir, e.name, 'SKILL.md') }));
}

/** Get full content of a single skill. */
export function getSkillContent(name: string): string | null {
  const dir = getSkillsDir();
  const skillPath = path.join(dir, name, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return null;
  return fs.readFileSync(skillPath, 'utf8');
}

/** Get all skills content, joined with separators. */
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
