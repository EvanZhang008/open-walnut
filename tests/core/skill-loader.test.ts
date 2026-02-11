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
  buildSkillsPrompt,
  clearSkillsCache,
} from '../../src/core/skill-loader.js';
import type { SkillMeta } from '../../src/core/skill-loader.js';
import { GLOBAL_SKILLS_DIR, CLAUDE_SKILLS_DIR, WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  clearSkillsCache();
});

afterEach(async () => {
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

// ─── isEligible ─────────────────────────────────────────────────────

describe('isEligible', () => {
  it('returns true when no requires', () => {
    expect(isEligible({ name: 'test', description: 'test' })).toBe(true);
  });

  it('returns true when requires is empty', () => {
    expect(
      isEligible({
        name: 'test',
        metadata: { openclaw: { requires: {} } },
      }),
    ).toBe(true);
  });

  it('returns true when required bin exists', () => {
    // 'node' should be available in any test environment
    expect(
      isEligible({
        metadata: { openclaw: { requires: { bins: ['node'] } } },
      }),
    ).toBe(true);
  });

  it('returns false when required bin is missing', () => {
    expect(
      isEligible({
        metadata: { openclaw: { requires: { bins: ['__nonexistent_binary_xyz__'] } } },
      }),
    ).toBe(false);
  });

  it('checks env vars', () => {
    process.env.__SKILL_TEST_VAR__ = '1';
    expect(
      isEligible({
        metadata: { openclaw: { requires: { env: ['__SKILL_TEST_VAR__'] } } },
      }),
    ).toBe(true);
    delete process.env.__SKILL_TEST_VAR__;

    expect(
      isEligible({
        metadata: { openclaw: { requires: { env: ['__MISSING_ENV_VAR_XYZ__'] } } },
      }),
    ).toBe(false);
  });

  it('checks platform', () => {
    expect(
      isEligible({
        metadata: { openclaw: { requires: { platform: [process.platform] } } },
      }),
    ).toBe(true);

    expect(
      isEligible({
        metadata: { openclaw: { requires: { platform: ['__fake_os__'] } } },
      }),
    ).toBe(false);
  });

  it('checks os alias same as platform', () => {
    expect(
      isEligible({
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

  it('produces correct XML structure', () => {
    const skills: SkillMeta[] = [
      { name: 'weather', description: 'Get weather', location: './skills/weather/SKILL.md' },
      { name: 'github', description: 'GitHub CLI', location: '~/.walnut/skills/github/SKILL.md' },
    ];
    const result = formatSkillsPrompt(skills);

    expect(result).toContain('## Skills (mandatory)');
    expect(result).toContain('<available_skills>');
    expect(result).toContain('</available_skills>');
    expect(result).toContain('<name>weather</name>');
    expect(result).toContain('<description>Get weather</description>');
    expect(result).toContain('<location>./skills/weather/SKILL.md</location>');
    expect(result).toContain('<name>github</name>');
  });

  it('escapes XML in values', () => {
    const skills: SkillMeta[] = [
      { name: 'test & dev', description: 'A <special> skill', location: '/path/to/"SKILL".md' },
    ];
    const result = formatSkillsPrompt(skills);
    expect(result).toContain('test &amp; dev');
    expect(result).toContain('A &lt;special&gt; skill');
    expect(result).toContain('&quot;SKILL&quot;');
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

  it('discovers skills from claude skills dir', async () => {
    clearSkillsCache();
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
    expect(result).toContain('<name>claude-skill</name>');
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

    // Claude (lower priority)
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
});
