import { describe, expect, test } from 'vitest';

import { listSkills, getSkillContent, getAllSkillsContent } from '../src/cli/skills.js';

describe('skills', () => {
  test('listSkills returns available skills', () => {
    const skills = listSkills();
    expect(skills.length).toBeGreaterThanOrEqual(2);
    const names = skills.map(s => s.name);
    expect(names).toContain('cdp-autorouter-cli');
    expect(names).toContain('autorouter-mcp');
  });

  test('getSkillContent returns content for existing skill', () => {
    const content = getSkillContent('cdp-autorouter-cli');
    expect(content).not.toBeNull();
    expect(content).toContain('cdp-autorouter-cli');
    expect(content).toContain('get-ws');
  });

  test('getSkillContent returns null for non-existent skill', () => {
    expect(getSkillContent('nonexistent-skill')).toBeNull();
  });

  test('getAllSkillsContent includes all skills', () => {
    const content = getAllSkillsContent();
    expect(content).toContain('cdp-autorouter-cli');
    expect(content).toContain('autorouter-mcp');
  });
});
