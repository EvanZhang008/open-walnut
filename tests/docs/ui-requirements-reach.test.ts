/**
 * The UI requirements skill (.claude/skills/walnut-ui-requirements/SKILL.md) holds the rules every
 * change the user can see must meet; each one came from a real incident (2026-11-20: a card's reply
 * vanished in a redesign, a state shipped that the user never saw, the expanded card filled the
 * window). The rules only help if every agent doing UI work reads them, so this guard makes sure
 * each way in points at the skill near its top:
 *   - the root AGENTS.md (every session), web/src/AGENTS.md (other engines in web/src) and
 *     web/src/CLAUDE.md (Claude Code loads it on reading any file under web/src);
 *   - every repo skill about the web UI, browsers or Playwright, found from each skill's own name
 *     and description, so a NEW UI skill fails here until it points at the requirements too.
 * It also keeps the skill's own shape: one bold sentence per rule, each with a dated example, and
 * every link resolving.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SKILLS = path.join(ROOT, '.claude/skills');
const NAME = 'walnut-ui-requirements';
const SKILL_FILE = path.join(SKILLS, NAME, 'SKILL.md');
/** A pointer counts only near the top, where a reader sees it before the details. */
const TOP_LINES = 20;

const FIXED_GUIDES = ['AGENTS.md', 'web/src/AGENTS.md', 'web/src/CLAUDE.md'];

function frontmatter(text: string): { name: string; description: string; bodyStart: number } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { name: '', description: '', bodyStart: 0 };
  const field = (k: string) => (m[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1] ?? '').replace(/^"|"$/g, '');
  return { name: field('name'), description: field('description'), bodyStart: m[0].split('\n').length - 1 };
}

/** A skill is about the UI when its name or description says so. */
function isUiSkill(name: string, description: string): boolean {
  return /web\/src|\bUI\b|frontend|playwright|browser|web console|web-console/i.test(`${name} ${description}`);
}

function topOf(text: string, skipFrontmatter: boolean): string {
  const lines = text.split('\n');
  const start = skipFrontmatter ? frontmatter(text).bodyStart : 0;
  return lines.slice(start, start + TOP_LINES).join('\n');
}

function uiSkills(): string[] {
  return fs.readdirSync(SKILLS)
    .filter((d) => d !== NAME && fs.existsSync(path.join(SKILLS, d, 'SKILL.md')))
    .filter((d) => {
      const fm = frontmatter(fs.readFileSync(path.join(SKILLS, d, 'SKILL.md'), 'utf8'));
      return isUiSkill(fm.name || d, fm.description);
    })
    .sort();
}

describe('UI requirements reach every UI agent', () => {
  it('every fixed guide file points at the skill near its top', () => {
    const missing = FIXED_GUIDES.filter((f) => {
      const p = path.join(ROOT, f);
      return !fs.existsSync(p) || !topOf(fs.readFileSync(p, 'utf8'), false).includes(NAME);
    });
    expect(missing, `These files must name ${NAME} in their first ${TOP_LINES} lines:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every UI skill in the repo points at the skill near its top', () => {
    const skills = uiSkills();
    // The classifier must keep finding the known UI skills; a rename shows up here.
    expect(skills).toEqual(expect.arrayContaining(['test-and-verify-walnut', 'walnut-console-ops', 'walnut-testing', 'walnut-web-frontend']));
    const missing = skills.filter((d) => !topOf(fs.readFileSync(path.join(SKILLS, d, 'SKILL.md'), 'utf8'), true).includes(NAME));
    expect(missing, `UI skills must name ${NAME} in the first ${TOP_LINES} lines after their frontmatter:\n${missing.join('\n')}`).toEqual([]);
  });

  it('the classifier reads names and descriptions', () => {
    expect(isUiSkill('x', 'Implementation details for web/src/ (React SPA)')).toBe(true);
    expect(isUiSkill('x', 'Playwright UI tests')).toBe(true);
    expect(isUiSkill('walnut-core-internals', 'Deep implementation details for src/core/')).toBe(false);
  });
});

describe('the UI requirements skill', () => {
  const text = fs.readFileSync(SKILL_FILE, 'utf8');

  it('names itself and says when to read it', () => {
    const fm = frontmatter(text);
    expect(fm.name).toBe(NAME);
    expect(fm.description).toMatch(/MUST read before/);
  });

  it('gives every rule one bold sentence and a dated real example', () => {
    const rules = [...text.matchAll(/^\s*(\d+)\. \*\*(.+?)\*\*\s*\n\s+Example \((\d{4}-\d{2}(?:-\d{2})?)\): .+$/gm)];
    const numbered = [...text.matchAll(/^\s*\d+\. /gm)];
    expect(numbered.length).toBeGreaterThanOrEqual(14);
    expect(rules.length, 'a numbered rule lacks its bold sentence or its "Example (<date>):" line').toBe(numbered.length);
    expect(rules.map((r) => Number(r[1]))).toEqual(rules.map((_, i) => i + 1));
  });

  it('links only to files that exist and uses no long dashes', () => {
    const missing: string[] = [];
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].replace(/#.*$/, '');
      if (/^https?:/.test(target) || !target) continue;
      if (!fs.existsSync(path.resolve(path.dirname(SKILL_FILE), target))) missing.push(m[1]);
    }
    expect(missing).toEqual([]);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});
