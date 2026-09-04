import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  parseSkillMeta,
  listPluginSkills,
  clearPluginSkillsCache,
} from '../../src/core/plugin-skill-loader.js';
import { CLAUDE_HOME, CLAUDE_PLUGINS_DIR, CLAUDE_SETTINGS_FILE } from '../../src/constants.js';

let home: string;

beforeEach(async () => {
  home = CLAUDE_HOME;
  await fsp.rm(home, { recursive: true, force: true });
  await fsp.mkdir(home, { recursive: true });
  clearPluginSkillsCache();
});

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true });
});

// ─── parseSkillMeta ─────────────────────────────────────────────────

describe('parseSkillMeta', () => {
  it('extracts name and description', () => {
    const raw = `---
name: my-skill
description: Does a thing
license: MIT
---
# Body`;
    expect(parseSkillMeta(raw)).toEqual({ name: 'my-skill', description: 'Does a thing' });
  });

  it('strips surrounding quotes', () => {
    const raw = `---
name: "quoted"
description: 'single quoted'
---`;
    expect(parseSkillMeta(raw)).toEqual({ name: 'quoted', description: 'single quoted' });
  });

  it('returns empty when no frontmatter', () => {
    expect(parseSkillMeta('# Just markdown')).toEqual({});
  });
});

// ─── helpers ────────────────────────────────────────────────────────

async function writeSkill(pluginDir: string, dirName: string, name: string, desc: string) {
  const skillDir = path.join(pluginDir, 'skills', dirName);
  await fsp.mkdir(skillDir, { recursive: true });
  await fsp.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}`,
  );
}

async function writeSettings(enabled: Record<string, boolean>) {
  await fsp.writeFile(
    CLAUDE_SETTINGS_FILE,
    JSON.stringify({ enabledPlugins: enabled }),
  );
}

async function writeKnownMarketplaces(obj: Record<string, unknown>) {
  await fsp.mkdir(CLAUDE_PLUGINS_DIR, { recursive: true });
  await fsp.writeFile(
    path.join(CLAUDE_PLUGINS_DIR, 'known_marketplaces.json'),
    JSON.stringify(obj),
  );
}

// ─── listPluginSkills ───────────────────────────────────────────────

describe('listPluginSkills', () => {
  it('returns empty when no settings file', async () => {
    expect(await listPluginSkills()).toEqual([]);
  });

  it('discovers skills from a github-style marketplace via manifest', async () => {
    // marketplace root: ~/.claude/plugins/marketplaces/mp/
    const mpRoot = path.join(CLAUDE_PLUGINS_DIR, 'marketplaces', 'mp');
    const pluginDir = path.join(mpRoot, 'plugins', 'cool-plugin');
    await fsp.mkdir(path.join(mpRoot, '.claude-plugin'), { recursive: true });
    await fsp.writeFile(
      path.join(mpRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'cool-plugin', source: './plugins/cool-plugin' }] }),
    );
    await writeSkill(pluginDir, 'do-stuff', 'do-stuff', 'Does stuff');

    await writeKnownMarketplaces({
      mp: { source: { source: 'github', repo: 'x/y' } },
    });
    await writeSettings({ 'cool-plugin@mp': true });

    const skills = await listPluginSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      dirName: 'do-stuff',
      description: 'Does stuff',
      plugin: 'cool-plugin@mp',
    });
  });

  it('discovers skills from a directory marketplace using source.path', async () => {
    const dirMpRoot = path.join(home, 'my-cc-plugins');
    const pluginDir = path.join(dirMpRoot, 'plugin-a');
    await fsp.mkdir(path.join(dirMpRoot, '.claude-plugin'), { recursive: true });
    await fsp.writeFile(
      path.join(dirMpRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'plugin-a', source: './plugin-a' }] }),
    );
    await writeSkill(pluginDir, 'skill-x', 'skill-x', 'X');

    await writeKnownMarketplaces({
      local: { source: { source: 'directory', path: dirMpRoot } },
    });
    await writeSettings({ 'plugin-a@local': true });

    const skills = await listPluginSkills();
    expect(skills.map((s) => s.dirName)).toEqual(['skill-x']);
  });

  it('ignores disabled plugins', async () => {
    const mpRoot = path.join(CLAUDE_PLUGINS_DIR, 'marketplaces', 'mp');
    await writeSkill(path.join(mpRoot, 'plugins', 'p'), 'sk', 'sk', 'd');
    await writeKnownMarketplaces({ mp: { source: { source: 'github', repo: 'x/y' } } });
    await writeSettings({ 'p@mp': false });

    expect(await listPluginSkills()).toEqual([]);
  });

  it('falls back to convention dir when no manifest', async () => {
    const mpRoot = path.join(CLAUDE_PLUGINS_DIR, 'marketplaces', 'mp');
    await writeSkill(path.join(mpRoot, 'plugins', 'p'), 'sk', 'sk', 'd');
    await writeKnownMarketplaces({ mp: { source: { source: 'github', repo: 'x/y' } } });
    await writeSettings({ 'p@mp': true });

    const skills = await listPluginSkills();
    expect(skills.map((s) => s.dirName)).toEqual(['sk']);
  });

  it('keeps a same-named skill from two plugins — the CLI treats them as two commands', async () => {
    const mpRoot = path.join(CLAUDE_PLUGINS_DIR, 'marketplaces', 'mp');
    await writeSkill(path.join(mpRoot, 'plugins', 'p1'), 'dup', 'dup', 'from-p1');
    await writeSkill(path.join(mpRoot, 'plugins', 'p2'), 'dup', 'dup', 'from-p2');
    await writeKnownMarketplaces({ mp: { source: { source: 'github', repo: 'x/y' } } });
    await writeSettings({ 'p1@mp': true, 'p2@mp': true });

    const skills = await listPluginSkills();
    expect(skills.map((s) => [s.plugin, s.description])).toEqual([['p1@mp', 'from-p1'], ['p2@mp', 'from-p2']]);
  });

  it('caches results across calls', async () => {
    const mpRoot = path.join(CLAUDE_PLUGINS_DIR, 'marketplaces', 'mp');
    await writeSkill(path.join(mpRoot, 'plugins', 'p'), 'sk', 'sk', 'd');
    await writeKnownMarketplaces({ mp: { source: { source: 'github', repo: 'x/y' } } });
    await writeSettings({ 'p@mp': true });

    const first = await listPluginSkills();
    // remove on disk — cache should still serve
    await fsp.rm(mpRoot, { recursive: true, force: true });
    const second = await listPluginSkills();
    expect(second).toEqual(first);
  });
});
