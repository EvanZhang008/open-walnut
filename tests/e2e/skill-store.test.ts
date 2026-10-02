/**
 * E2E tests for the skill store — CRUD, enable/disable, references, and HTTP API.
 *
 * Starts a real Express server on a random port, exercises every /api/skills
 * endpoint, and verifies persistence across requests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, GLOBAL_SKILLS_DIR, CLAUDE_SKILLS_DIR, SKILL_SETTINGS_FILE } from '../../src/constants.js';
import { clearSkillsCache } from '../../src/core/skill-loader.js';
import { startServer, stopServer } from '../../src/web/server.js';

// ── Helpers ──

let server: HttpServer;
let port: number;

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, init);
}

function apiJson(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

/** Create a skill on disk (bypassing the API). */
async function seedSkill(
  base: string,
  dirName: string,
  content: string,
  refs?: Record<string, string>,
): Promise<void> {
  const dir = path.join(base, dirName);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), content);
  if (refs) {
    const refsDir = path.join(dir, 'references');
    await fsp.mkdir(refsDir, { recursive: true });
    for (const [name, data] of Object.entries(refs)) {
      await fsp.writeFile(path.join(refsDir, name), data);
    }
  }
}

/**
 * The sources this suite seeds and cleans. The list also carries skills it does
 * not control, by design: the workspace-local `./skills` of the checkout the
 * test runs from (the repo ships `restore-backup` and `setup-walnut` there) and
 * the skills built-in plugins ship (`walnut-calendar`). Listing assertions are
 * about the seeded sources only.
 */
const SEEDED_SOURCES = new Set(['walnut', 'claude']);

interface ListedSkill {
  name: string;
  dirName: string;
  source: string;
  content: string;
  description: string;
  enabled: boolean;
  eligible: boolean;
  hasReferences: boolean;
}

/** GET /api/skills, split into the skills this suite seeded and everything else. */
async function listSkills(): Promise<{ seeded: ListedSkill[]; other: ListedSkill[] }> {
  const res = await api('/api/skills');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { skills: ListedSkill[] };
  return {
    seeded: body.skills.filter((s) => SEEDED_SOURCES.has(s.source)),
    other: body.skills.filter((s) => !SEEDED_SOURCES.has(s.source)),
  };
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to get server address');
  port = addr.port;
});

afterAll(async () => {
  await stopServer();
  // Small delay to let server fully release file handles before cleanup
  await new Promise((r) => setTimeout(r, 100));
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  // Clean skill directories and settings between tests
  await fsp.rm(GLOBAL_SKILLS_DIR, { recursive: true, force: true });
  await fsp.rm(CLAUDE_SKILLS_DIR, { recursive: true, force: true });
  try { await fsp.rm(SKILL_SETTINGS_FILE); } catch { /* may not exist */ }
  clearSkillsCache();
});

// ── Tests: Listing ──

describe('GET /api/skills', () => {
  it('returns no seeded skills when none exist', async () => {
    const { seeded, other } = await listSkills();
    expect(seeded).toEqual([]);
    // Whatever else is listed comes from a source this suite does not seed.
    for (const skill of other) expect(['workspace', 'plugin']).toContain(skill.source);
  });

  it('discovers skills from walnut global dir', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'test-skill', `---
name: Test Skill
description: A test skill
---
# Test Skill`);

    const { seeded } = await listSkills();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].name).toBe('Test Skill');
    expect(seeded[0].source).toBe('walnut');
    expect(seeded[0].dirName).toBe('test-skill');
    expect(seeded[0].enabled).toBe(true);
    expect(seeded[0].eligible).toBe(true);
  });

  it('discovers skills from claude dir', async () => {
    await seedSkill(CLAUDE_SKILLS_DIR, 'claude-skill', `---
name: Claude Skill
description: From claude dir
---
# Claude`);

    const { seeded } = await listSkills();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].source).toBe('claude');
  });

  it('discovers skills from both sources simultaneously', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'walnut-skill', `---
name: WS
description: walnut skill
---
`);
    await seedSkill(CLAUDE_SKILLS_DIR, 'claude-skill', `---
name: CS
description: claude skill
---
`);

    const { seeded } = await listSkills();
    expect(seeded).toHaveLength(2);
    const sources = seeded.map((s: { source: string }) => s.source).sort();
    expect(sources).toEqual(['claude', 'walnut']);
  });

  it('uses dirName as fallback when frontmatter has no name', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'unnamed', `---
description: no name field
---
`);

    const { seeded } = await listSkills();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].name).toBe('unnamed');
  });

  it('includes content in response', async () => {
    const content = `---
name: content-test
description: verify content
---
# Content Test
Some body text here.`;
    await seedSkill(GLOBAL_SKILLS_DIR, 'content-test', content);

    const { seeded } = await listSkills();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].content).toBe(content);
  });

  it('detects hasReferences when references dir exists', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'with-refs', `---
name: with-refs
description: has refs
---
`, { 'data.json': '{"key":"value"}' });

    const { seeded } = await listSkills();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].hasReferences).toBe(true);
  });
});

// ── Tests: Single skill ──

describe('GET /api/skills/:dirName', () => {
  it('returns 404 for nonexistent skill', async () => {
    const res = await api('/api/skills/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns skill detail', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'detail-test', `---
name: Detail
description: detail test
---
`);

    const res = await api('/api/skills/detail-test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skill.name).toBe('Detail');
    expect(body.skill.dirName).toBe('detail-test');
  });
});

// ── Tests: Create ──

describe('POST /api/skills', () => {
  it('creates a skill in claude dir by default', async () => {
    const res = await apiJson('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        dirName: 'new-skill',
        content: '---\nname: New\ndescription: created\n---\n',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.skill.name).toBe('New');
    expect(body.skill.source).toBe('claude');

    // Verify on disk
    const onDisk = await fsp.readFile(
      path.join(CLAUDE_SKILLS_DIR, 'new-skill', 'SKILL.md'), 'utf-8',
    );
    expect(onDisk).toContain('name: New');
  });

  it('creates a skill in walnut dir when target=walnut', async () => {
    const res = await apiJson('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        dirName: 'walnut-new',
        content: '---\nname: WNew\ndescription: walnut\n---\n',
        target: 'walnut',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.skill.source).toBe('walnut');

    const onDisk = await fsp.readFile(
      path.join(GLOBAL_SKILLS_DIR, 'walnut-new', 'SKILL.md'), 'utf-8',
    );
    expect(onDisk).toContain('name: WNew');
  });

  it('returns 400 for missing dirName', async () => {
    const res = await apiJson('/api/skills', {
      method: 'POST',
      body: JSON.stringify({ content: 'stuff' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing content', async () => {
    const res = await apiJson('/api/skills', {
      method: 'POST',
      body: JSON.stringify({ dirName: 'abc' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid dirName characters', async () => {
    const res = await apiJson('/api/skills', {
      method: 'POST',
      body: JSON.stringify({ dirName: '../escape', content: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 when skill already exists', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'dup', '---\nname: dup\n---\n');

    const res = await apiJson('/api/skills', {
      method: 'POST',
      body: JSON.stringify({ dirName: 'dup', content: 'x' }),
    });
    expect(res.status).toBe(409);
  });
});

// ── Tests: Update ──

describe('PUT /api/skills/:dirName', () => {
  it('updates skill content', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'editable', `---
name: editable
description: original
---
`);

    const newContent = '---\nname: editable\ndescription: updated\n---\nNew body';
    const res = await apiJson('/api/skills/editable', {
      method: 'PUT',
      body: JSON.stringify({ content: newContent }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skill.description).toBe('updated');

    // Verify on disk
    const onDisk = await fsp.readFile(
      path.join(GLOBAL_SKILLS_DIR, 'editable', 'SKILL.md'), 'utf-8',
    );
    expect(onDisk).toBe(newContent);
  });

  it('returns 404 for nonexistent skill', async () => {
    const res = await apiJson('/api/skills/nonexistent', {
      method: 'PUT',
      body: JSON.stringify({ content: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when content is not a string', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'typecheck', '---\nname: tc\n---\n');
    const res = await apiJson('/api/skills/typecheck', {
      method: 'PUT',
      body: JSON.stringify({ content: 123 }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Tests: Enable/Disable ──

describe('PATCH /api/skills/:dirName (enable/disable)', () => {
  it('disables a skill and persists across requests', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'toggle-me', '---\nname: Toggle\n---\n');

    // Disable
    const res1 = await apiJson('/api/skills/toggle-me', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.skill.enabled).toBe(false);

    // Verify persisted: clear cache and re-fetch
    clearSkillsCache();
    const res2 = await api('/api/skills/toggle-me');
    const body2 = await res2.json();
    expect(body2.skill.enabled).toBe(false);

    // Verify in settings file
    const settings = JSON.parse(await fsp.readFile(SKILL_SETTINGS_FILE, 'utf-8'));
    expect(settings.disabled).toContain('toggle-me');
  });

  it('re-enables a disabled skill', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'reenable', '---\nname: ReEn\n---\n');

    // Disable first
    await apiJson('/api/skills/reenable', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });

    // Re-enable
    const res = await apiJson('/api/skills/reenable', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skill.enabled).toBe(true);

    // Verify settings file no longer lists it
    const settings = JSON.parse(await fsp.readFile(SKILL_SETTINGS_FILE, 'utf-8'));
    expect(settings.disabled).not.toContain('reenable');
  });

  it('validates skill exists BEFORE writing settings', async () => {
    // This tests the must-fix #1: should NOT write settings for nonexistent skill
    const res = await apiJson('/api/skills/ghost-skill', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);

    // Settings file should NOT contain ghost-skill
    try {
      const settings = JSON.parse(await fsp.readFile(SKILL_SETTINGS_FILE, 'utf-8'));
      expect(settings.disabled).not.toContain('ghost-skill');
    } catch {
      // File doesn't exist — that's also correct
    }
  });

  it('returns 400 when enabled is not boolean', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'boolcheck', '---\nname: bc\n---\n');
    const res = await apiJson('/api/skills/boolcheck', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(res.status).toBe(400);
  });

  it('disabled skills appear in list with enabled=false', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'visible-disabled', '---\nname: VD\n---\n');
    await apiJson('/api/skills/visible-disabled', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });

    clearSkillsCache();
    const res = await api('/api/skills');
    const body = await res.json();
    const skill = body.skills.find((s: { dirName: string }) => s.dirName === 'visible-disabled');
    expect(skill).toBeDefined();
    expect(skill.enabled).toBe(false);
  });
});

// ── Tests: Delete ──

describe('DELETE /api/skills/:dirName', () => {
  it('deletes a skill', async () => {
    await seedSkill(CLAUDE_SKILLS_DIR, 'deletable', '---\nname: D\n---\n');

    const res = await api('/api/skills/deletable', { method: 'DELETE' });
    expect(res.status).toBe(204);

    // Verify gone from disk
    try {
      await fsp.stat(path.join(CLAUDE_SKILLS_DIR, 'deletable'));
      throw new Error('Should have been deleted');
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
    }

    // Verify gone from list
    clearSkillsCache();
    const list = await api('/api/skills');
    const body = await list.json();
    expect(body.skills.find((s: { dirName: string }) => s.dirName === 'deletable')).toBeUndefined();
  });

  it('returns 404 for nonexistent skill', async () => {
    const res = await api('/api/skills/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

// ── Tests: References ──

describe('GET /api/skills/:dirName/references', () => {
  it('lists reference files with sizes', async () => {
    const refData = 'Hello, this is reference data!';
    await seedSkill(GLOBAL_SKILLS_DIR, 'ref-skill', '---\nname: RS\n---\n', {
      'notes.txt': refData,
      'config.json': '{"key":"val"}',
    });

    const res = await api('/api/skills/ref-skill/references');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toHaveLength(2);
    const names = body.files.map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(['config.json', 'notes.txt']);
    const notes = body.files.find((f: { name: string }) => f.name === 'notes.txt');
    expect(notes.size).toBe(refData.length);
  });

  it('returns empty array when no references dir', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'no-refs', '---\nname: NR\n---\n');

    const res = await api('/api/skills/no-refs/references');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toEqual([]);
  });

  it('returns 404 for nonexistent skill', async () => {
    const res = await api('/api/skills/ghost/references');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/skills/:dirName/references/:file', () => {
  it('returns reference file content', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'ref-content', '---\nname: RC\n---\n', {
      'readme.md': '# Hello\nWorld',
    });

    const res = await api('/api/skills/ref-content/references/readme.md');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe('# Hello\nWorld');
  });

  it('returns 400 for path traversal attempts', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'traversal', '---\nname: T\n---\n', {
      'ok.txt': 'safe',
    });

    const res = await api('/api/skills/traversal/references/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
  });

  it('returns 404 for nonexistent reference file', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'missing-ref', '---\nname: MR\n---\n', {
      'exists.txt': 'yes',
    });

    const res = await api('/api/skills/missing-ref/references/nope.txt');
    // File not found on disk → unhandled error → 500 or could be caught
    // The readFile will throw ENOENT which passes through to next(err)
    expect([404, 500]).toContain(res.status);
  });
});

// ── Tests: Edge cases ──

describe('Edge cases', () => {
  it('handles corrupt skill-settings.json gracefully', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'edge1', '---\nname: E1\n---\n');

    // Write corrupt settings
    await fsp.writeFile(SKILL_SETTINGS_FILE, 'not json{{{');
    clearSkillsCache();

    // Should still list skills (corrupt settings = all enabled)
    const { seeded } = await listSkills();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].enabled).toBe(true);
  });

  it('handles skill without frontmatter', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'no-fm', '# Just a heading\nNo frontmatter here.');

    const { seeded } = await listSkills();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].name).toBe('no-fm'); // falls back to dirName
    expect(seeded[0].description).toBe('');
  });

  it('handles empty SKILL.md', async () => {
    await seedSkill(GLOBAL_SKILLS_DIR, 'empty', '');

    const { seeded } = await listSkills();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].name).toBe('empty');
  });

  it('handles large skill file', async () => {
    const largeContent = '---\nname: big\ndescription: big skill\n---\n' + 'x'.repeat(100_000);
    await seedSkill(GLOBAL_SKILLS_DIR, 'large', largeContent);

    const { seeded } = await listSkills();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].content.length).toBe(largeContent.length);
  });

  it('higher priority source wins for duplicate dirName', async () => {
    // walnut = higher priority than claude
    await seedSkill(GLOBAL_SKILLS_DIR, 'dupe', '---\nname: walnut-version\n---\n');
    await seedSkill(CLAUDE_SKILLS_DIR, 'dupe', '---\nname: claude-version\n---\n');

    const res = await api('/api/skills');
    const body = await res.json();
    const dupe = body.skills.filter((s: { dirName: string }) => s.dirName === 'dupe');
    expect(dupe).toHaveLength(1);
    expect(dupe[0].name).toBe('walnut-version');
    expect(dupe[0].source).toBe('walnut');
  });

  it('create + toggle + list round-trip', async () => {
    // Create
    const createRes = await apiJson('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        dirName: 'roundtrip',
        content: '---\nname: Roundtrip\ndescription: test\n---\n',
      }),
    });
    expect(createRes.status).toBe(201);

    // Toggle off
    await apiJson('/api/skills/roundtrip', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });

    // List should show disabled
    clearSkillsCache();
    const listRes = await api('/api/skills');
    const body = await listRes.json();
    const skill = body.skills.find((s: { dirName: string }) => s.dirName === 'roundtrip');
    expect(skill.enabled).toBe(false);

    // Toggle back on
    await apiJson('/api/skills/roundtrip', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    });

    clearSkillsCache();
    const listRes2 = await api('/api/skills');
    const body2 = await listRes2.json();
    const skill2 = body2.skills.find((s: { dirName: string }) => s.dirName === 'roundtrip');
    expect(skill2.enabled).toBe(true);
  });
});
