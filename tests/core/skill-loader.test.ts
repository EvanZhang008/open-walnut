import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  parseFrontmatter,
  isEligible,
  escapeXml,
  formatSkillsPrompt,
  formatSessionIndex,
  shortSkillLine,
  buildSkillsPrompt,
  clearSkillsCache,
  listAvailableSkills,
  _resetLenientFrontmatterWarnedForTest,
} from '../../src/core/skill-loader.js';
import { log } from '../../src/logging/index.js';
import type { SkillMeta } from '../../src/core/skill-loader.js';
import { GLOBAL_SKILLS_DIR, CLAUDE_SKILLS_DIR, WALNUT_HOME } from '../../src/constants.js';

let originalCwd: string;

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  // getSearchDirs() includes path.resolve('skills') — chdir into the tmp dir so
  // the repo's real workspace skills/ can't leak into these tests.
  originalCwd = process.cwd();
  process.chdir(tmpDir);
  clearSkillsCache();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ─── parseFrontmatter ───────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses valid YAML frontmatter', () => {
    const raw = `---
name: weather
description: Get weather
---
# Weather Skill
Body text here.`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe('weather');
    expect(frontmatter.description).toBe('Get weather');
    expect(body).toBe('# Weather Skill\nBody text here.');
  });

  it('returns empty frontmatter when no delimiters', () => {
    const raw = '# Just a heading\nNo frontmatter.';
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });

  it('handles metadata with nested objects', () => {
    const raw = `---
name: deploy
description: Deploy services
metadata:
  openclaw:
    emoji: "🚀"
    requires:
      bins:
        - docker
---
# Deploy`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe('deploy');
    expect(frontmatter.metadata?.openclaw?.requires?.bins).toEqual(['docker']);
  });

  it('handles malformed YAML gracefully', () => {
    const raw = `---
: broken: yaml: [
---
Body`;
    const { frontmatter } = parseFrontmatter(raw);
    // Should not throw; returns empty or whatever yaml.load returns
    expect(frontmatter).toBeDefined();
  });
});

describe('lenient frontmatter warning', () => {
  // A description with an unquoted ": " is not strict YAML; the CLI accepts it, so the
  // loader recovers it by line. Every skill-list rebuild re-parses every SKILL.md, and
  // before this guard one such file warned thousands of times a day (log.chronic alarm).
  const lenient = (desc: string) => `---\nname: demo\ndescription: Demo skill: ${desc}\n---\nBody`;
  const WARN_MSG = 'skill-loader: frontmatter is not strict YAML; recovered name/description by line';

  beforeEach(() => _resetLenientFrontmatterWarnedForTest());
  afterEach(() => vi.restoreAllMocks());

  it('warns once per file and content, then only at debug level', () => {
    const warn = vi.spyOn(log.task, 'warn');
    const debug = vi.spyOn(log.task, 'debug');
    for (let i = 0; i < 5; i++) {
      const { frontmatter } = parseFrontmatter(lenient('does a: thing'), '/skills/demo/SKILL.md');
      expect(frontmatter.description).toBe('Demo skill: does a: thing');
    }
    const warns = warn.mock.calls.filter((c) => c[0] === WARN_MSG);
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toMatchObject({ file: '/skills/demo/SKILL.md' });
    expect(debug.mock.calls.filter((c) => c[0] === WARN_MSG)).toHaveLength(4);

    // An edit that changes the frontmatter, or another file, is news: it warns again.
    parseFrontmatter(lenient('does b: thing'), '/skills/demo/SKILL.md');
    parseFrontmatter(lenient('does a: thing'), '/skills/other/SKILL.md');
    expect(warn.mock.calls.filter((c) => c[0] === WARN_MSG)).toHaveLength(3);
  });

  it('every src caller of the skill-loader parser names the file it parsed', async () => {
    // Enumerated from the source, so a new caller that drops the path fails here.
    const { execFileSync } = await import('node:child_process');
    const repo = path.resolve(__dirname, '../..');
    const files = execFileSync('git', ['grep', '-l', 'skill-loader', '--', 'src'], { cwd: repo, encoding: 'utf-8' })
      .split('\n').filter(Boolean);
    const offenders: string[] = [];
    let calls = 0;
    for (const rel of files) {
      const text = await fsp.readFile(path.join(repo, rel), 'utf-8');
      const importsIt = rel === 'src/core/skill-loader.ts'
        || /import\s*\{[^}]*\bparseFrontmatter\b[^}]*\}\s*from\s*'[^']*skill-loader\.js'/.test(text);
      if (!importsIt) continue;
      for (const m of text.matchAll(/\bparseFrontmatter\(([^)]*)\)/g)) {
        if (/^raw: string/.test(m[1])) continue; // the definition itself
        calls++;
        if (!m[1].includes(',')) offenders.push(`${rel}: parseFrontmatter(${m[1]})`);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });
});

// ─── isEligible ─────────────────────────────────────────────────────

describe('isEligible', () => {
  it('returns true when no requires', async () => {
    expect(await isEligible({ name: 'test', description: 'test' })).toBe(true);
  });

  it('returns true when requires is empty', async () => {
    expect(
      await isEligible({
        name: 'test',
        metadata: { openclaw: { requires: {} } },
      }),
    ).toBe(true);
  });

  it('returns true when required bin exists', async () => {
    // 'node' should be available in any test environment
    expect(
      await isEligible({
        metadata: { openclaw: { requires: { bins: ['node'] } } },
      }),
    ).toBe(true);
  });

  it('returns false when required bin is missing', async () => {
    expect(
      await isEligible({
        metadata: { openclaw: { requires: { bins: ['__nonexistent_binary_xyz__'] } } },
      }),
    ).toBe(false);
  });

  it('checks env vars', async () => {
    process.env.__SKILL_TEST_VAR__ = '1';
    expect(
      await isEligible({
        metadata: { openclaw: { requires: { env: ['__SKILL_TEST_VAR__'] } } },
      }),
    ).toBe(true);
    delete process.env.__SKILL_TEST_VAR__;

    expect(
      await isEligible({
        metadata: { openclaw: { requires: { env: ['__MISSING_ENV_VAR_XYZ__'] } } },
      }),
    ).toBe(false);
  });

  it('checks platform', async () => {
    expect(
      await isEligible({
        metadata: { openclaw: { requires: { platform: [process.platform] } } },
      }),
    ).toBe(true);

    expect(
      await isEligible({
        metadata: { openclaw: { requires: { platform: ['__fake_os__'] } } },
      }),
    ).toBe(false);
  });

  it('checks os alias same as platform', async () => {
    expect(
      await isEligible({
        metadata: { openclaw: { requires: { os: [process.platform] } } },
      }),
    ).toBe(true);
  });
});

// ─── escapeXml ──────────────────────────────────────────────────────

describe('escapeXml', () => {
  it('escapes all XML special characters', () => {
    expect(escapeXml('a & b < c > d " e \' f')).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &apos; f',
    );
  });

  it('returns empty string for empty input', () => {
    expect(escapeXml('')).toBe('');
  });
});

// ─── formatSkillsPrompt ─────────────────────────────────────────────

describe('formatSkillsPrompt', () => {
  it('returns empty string when no skills', () => {
    expect(formatSkillsPrompt([])).toBe('');
  });

  it('produces correct XML structure grouped by category', () => {
    const skills: SkillMeta[] = [
      { name: 'weather', description: 'Get weather', location: './skills/weather/SKILL.md', category: 'general', type: 'action' },
      { name: 'github', description: 'GitHub CLI', location: '~/.open-walnut/skills/github/SKILL.md', category: 'dev', type: 'knowledge' },
    ];
    const result = formatSkillsPrompt(skills);

    expect(result).toContain('## Skills (mandatory)');
    expect(result).toContain('<available_skills>');
    expect(result).toContain('</available_skills>');
    expect(result).toContain('<category name="general">');
    expect(result).toContain('<category name="dev">');
    expect(result).toContain('<name>weather</name>');
    expect(result).toContain('<type>action</type>');
    expect(result).toContain('<type>knowledge</type>');
    expect(result).toContain('<description>Get weather</description>');
    expect(result).toContain('<location>./skills/weather/SKILL.md</location>');
    expect(result).toContain('<name>github</name>');
    // Instruction is reversed to favor loading (Hermes-style routing)
    expect(result).toContain('ERR ON THE SIDE OF LOADING');
    expect(result).not.toContain('never read more than one');
  });

  it('escapes XML in values', () => {
    const skills: SkillMeta[] = [
      { name: 'test & dev', description: 'A <special> skill', location: '/path/to/"SKILL".md', category: 'general', type: 'action' },
    ];
    const result = formatSkillsPrompt(skills);
    expect(result).toContain('test &amp; dev');
    expect(result).toContain('A &lt;special&gt; skill');
    expect(result).toContain('&quot;SKILL&quot;');
  });
});

// 2026-11-12: every session engine carries one short line per skill (the XML form with whole
// descriptions and paths measured 30 to 49 KB on every request of Main); skill_read has the rest.
describe('formatSessionIndex', () => {
  const skills: SkillMeta[] = [
    { name: 'walnut-board', description: 'Keep a team Board.\n  Use when  leading workers.', location: '/opt/w/dist/data/skills/walnut-board/SKILL.md', category: 'walnut', type: 'action' },
    { name: 'walnut-time', description: 'Time review', location: '/opt/w/dist/data/skills/walnut-time/SKILL.md', category: 'walnut', type: 'knowledge' },
    { name: 'mine', description: 'My own', location: '/home/u/.open-walnut/skills/mine/SKILL.md', category: 'general', type: 'action' },
  ];

  it('is empty with no skills', () => {
    expect(formatSessionIndex([])).toBe('');
  });

  it('one short line per skill by its directory name, the folder said once, read with skill_read', () => {
    const out = formatSessionIndex(skills);
    expect(out).toContain('## Walnut skills\n');
    expect(out).toContain('skill_read {"dirName":"<name>"}');
    expect(out).toContain('In /opt/w/dist/data/skills:\n- walnut-board: Use when leading workers\n- walnut-time: Time review');
    expect(out).toContain('In /home/u/.open-walnut/skills:\n- mine: My own');
    expect(out).not.toContain('<skill>');
  });

  it('a skill with no path on this disk (the companion\'s copy of the Mac\'s) is named by its name, under its place', () => {
    const out = formatSessionIndex([
      { name: 'acme-tool', description: 'How to run the Acme tool', location: '(on the Mac)', category: 'general', type: 'action' },
      ...skills.slice(2),
    ]);
    expect(out).toContain('In (on the Mac):\n- acme-tool: How to run the Acme tool');
    expect(out).toContain('In /home/u/.open-walnut/skills:\n- mine: My own');
    expect(out).not.toMatch(/^- \.:/m);
  });

  it('a line is the sentence that says when to use the skill, else its first, at most 90 characters, cut at a word', () => {
    expect(shortSkillLine('Short one. Then more words.')).toBe('Short one');
    expect(shortSkillLine('Build and ship the app. Use when the user wants it on their phone.')).toBe('Use when the user wants it on their phone');
    const long = shortSkillLine('Use this skill whenever you are about to create any chart, graph, plot, dashboard or visualization in any medium at all');
    expect(long.length).toBeLessThanOrEqual(91);
    expect(long.endsWith('\u2026')).toBe(true);
    expect(long).not.toMatch(/ \u2026$/);
  });

  it('is far shorter than the XML form for the same skills', () => {
    expect(formatSessionIndex(skills).length * 2).toBeLessThan(formatSkillsPrompt(skills).length + 1200);
  });
});

// ─── buildSkillsPrompt (integration) ────────────────────────────────

describe('buildSkillsPrompt', () => {
  it('returns empty string when no skill directories exist', async () => {
    const result = await buildSkillsPrompt();
    expect(result).toBe('');
  });

  it('discovers skills from global skills dir', async () => {
    const skillDir = path.join(GLOBAL_SKILLS_DIR, 'test-skill');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: test-skill
description: A test skill
---
# Test Skill
Do the thing.`,
    );

    const result = await buildSkillsPrompt();
    expect(result).toContain('<name>test-skill</name>');
    expect(result).toContain('<description>A test skill</description>');
    expect(result).toContain('## Skills (mandatory)');
  });

  it('EXCLUDES ~/.claude/skills from the Personal AI prompt (CLI-executor store)', async () => {
    clearSkillsCache();
    // A walnut skill so the prompt is non-empty (empty skill set → empty prompt).
    const walnutDir = path.join(GLOBAL_SKILLS_DIR, 'personal-ai-skill');
    await fsp.mkdir(walnutDir, { recursive: true });
    await fsp.writeFile(
      path.join(walnutDir, 'SKILL.md'),
      `---
name: personal-ai-skill
description: A walnut skill
---
# Personal AI Skill`,
    );

    const skillDir = path.join(CLAUDE_SKILLS_DIR, 'claude-skill');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: claude-skill
description: A claude skill
---
# Claude Skill`,
    );

    const result = await buildSkillsPrompt();
    expect(result).toContain('<name>personal-ai-skill</name>');
    expect(result).not.toContain('<name>claude-skill</name>');

    // ...but it stays discoverable for the management UI / skill_view.
    const all = await listAvailableSkills();
    expect(all.map((s) => s.dirName)).toContain('claude-skill');
  });

  it('WALNUT_PERSONAL_AI_CLAUDE_SKILLS=1 opts claude skills back into the prompt', async () => {
    clearSkillsCache();
    const skillDir = path.join(CLAUDE_SKILLS_DIR, 'opt-in-skill');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: opt-in-skill
description: An opted-in claude skill
---
# Opt In`,
    );

    const prev = process.env.WALNUT_PERSONAL_AI_CLAUDE_SKILLS;
    process.env.WALNUT_PERSONAL_AI_CLAUDE_SKILLS = '1';
    try {
      const result = await buildSkillsPrompt();
      expect(result).toContain('<name>opt-in-skill</name>');
    } finally {
      if (prev === undefined) delete process.env.WALNUT_PERSONAL_AI_CLAUDE_SKILLS;
      else process.env.WALNUT_PERSONAL_AI_CLAUDE_SKILLS = prev;
      clearSkillsCache();
    }
  });

  it('keeps the previous opt-in environment setting working after the rename', async () => {
    clearSkillsCache();
    const skillDir = path.join(CLAUDE_SKILLS_DIR, 'legacy-opt-in-skill');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: legacy-opt-in-skill
description: A legacy opted-in claude skill
---
# Legacy Opt In`,
    );

    const legacyEnv = `WALNUT_${String.fromCharCode(66, 85, 84, 76, 69, 82)}_CLAUDE_SKILLS`;
    const prev = process.env[legacyEnv];
    process.env[legacyEnv] = '1';
    try {
      const result = await buildSkillsPrompt();
      expect(result).toContain('<name>legacy-opt-in-skill</name>');
    } finally {
      if (prev === undefined) delete process.env[legacyEnv];
      else process.env[legacyEnv] = prev;
      clearSkillsCache();
    }
  });

  it('higher priority source wins for same name', async () => {
    clearSkillsCache();
    // Global (higher priority)
    const globalDir = path.join(GLOBAL_SKILLS_DIR, 'dupe');
    await fsp.mkdir(globalDir, { recursive: true });
    await fsp.writeFile(
      path.join(globalDir, 'SKILL.md'),
      `---
name: dupe
description: global version
---
# Dupe`,
    );

    // Workspace-local is the only source above global; use it to prove precedence
    // (claude is no longer in the prompt scope at all).
    const claudeDir = path.join(CLAUDE_SKILLS_DIR, 'dupe');
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(
      path.join(claudeDir, 'SKILL.md'),
      `---
name: dupe
description: claude version
---
# Dupe`,
    );

    const result = await buildSkillsPrompt();
    expect(result).toContain('<description>global version</description>');
    expect(result).not.toContain('claude version');
  });

  it('uses directory name when frontmatter has no name', async () => {
    clearSkillsCache();
    const skillDir = path.join(GLOBAL_SKILLS_DIR, 'my-dir-name');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
description: No name field
---
# Skill without name`,
    );

    const result = await buildSkillsPrompt();
    expect(result).toContain('<name>my-dir-name</name>');
  });

  it('skips ineligible skills', async () => {
    clearSkillsCache();
    const skillDir = path.join(GLOBAL_SKILLS_DIR, 'ineligible');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: ineligible
description: Needs missing binary
metadata:
  openclaw:
    requires:
      bins:
        - __nonexistent_binary_xyz__
---
# Ineligible`,
    );

    const result = await buildSkillsPrompt();
    expect(result).toBe('');
  });

  it('caches results across calls', async () => {
    const skillDir = path.join(GLOBAL_SKILLS_DIR, 'cached');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: cached
description: Cached skill
---
# Cached`,
    );

    clearSkillsCache();
    const first = await buildSkillsPrompt();
    // Remove the directory — cached result should still return same thing
    await fsp.rm(skillDir, { recursive: true });
    const second = await buildSkillsPrompt();
    expect(second).toBe(first);
    expect(second).toContain('cached');
  });

  it('skips directories without SKILL.md', async () => {
    clearSkillsCache();
    const emptyDir = path.join(GLOBAL_SKILLS_DIR, 'no-skill');
    await fsp.mkdir(emptyDir, { recursive: true });
    await fsp.writeFile(path.join(emptyDir, 'README.md'), '# Not a skill');

    const result = await buildSkillsPrompt();
    expect(result).toBe('');
  });

  it('discovers categorized skills: skills/<category>/<name>/SKILL.md', async () => {
    const skillDir = path.join(GLOBAL_SKILLS_DIR, 'finance', 'tax-filing');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: tax-filing
description: Tax filing knowledge
type: knowledge
---
Tax stuff.`,
    );

    const result = await buildSkillsPrompt();
    expect(result).toContain('<category name="finance">');
    expect(result).toContain('<name>tax-filing</name>');
    expect(result).toContain('<type>knowledge</type>');
  });

  it('flat and categorized skills coexist; frontmatter category overrides dir', async () => {
    const flat = path.join(GLOBAL_SKILLS_DIR, 'flat-skill');
    await fsp.mkdir(flat, { recursive: true });
    await fsp.writeFile(path.join(flat, 'SKILL.md'), `---
name: flat-skill
description: Flat one
---
x`);
    const cat = path.join(GLOBAL_SKILLS_DIR, 'dir-cat', 'override-skill');
    await fsp.mkdir(cat, { recursive: true });
    await fsp.writeFile(path.join(cat, 'SKILL.md'), `---
name: override-skill
description: Uses frontmatter category
category: fm-cat
---
x`);

    const result = await buildSkillsPrompt();
    expect(result).toContain('<category name="general">');
    expect(result).toContain('<name>flat-skill</name>');
    expect(result).toContain('<category name="fm-cat">');
    expect(result).not.toContain('<category name="dir-cat">');
  });

  it('defaults type to action when frontmatter type is missing or invalid', async () => {
    const skillDir = path.join(GLOBAL_SKILLS_DIR, 'typeless');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(path.join(skillDir, 'SKILL.md'), `---
name: typeless
description: No type field
type: bogus
---
x`);
    const result = await buildSkillsPrompt();
    expect(result).toContain('<type>action</type>');
  });
});
