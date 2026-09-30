/**
 * GET /api/skills (listAllSkills) answers with every SKILL.md body and runs on every
 * page load and socket reconnect. The built list is cached, keyed by discovery's
 * SKILL.md mtimes and sizes plus the skills cache generation, with a 60s age cap.
 * These tests pin: an unchanged tree is not re-read, any edit is seen on the next
 * call, concurrent callers share one build, and `enabled` is always current.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-skill-list-cache'));

import { GLOBAL_SKILLS_DIR, SKILL_SETTINGS_FILE, WALNUT_HOME } from '../../src/constants.js';
import { clearSkillsCache } from '../../src/core/skill-loader.js';
import { listAllSkills, setSkillEnabled, _resetSkillListCacheForTest } from '../../src/core/skill-store.js';

let originalCwd: string;
let skillReads: string[];

function skillFile(name: string): string {
  return path.join(GLOBAL_SKILLS_DIR, name, 'SKILL.md');
}

async function seed(name: string, body: string): Promise<void> {
  await fsp.mkdir(path.dirname(skillFile(name)), { recursive: true });
  await fsp.writeFile(skillFile(name), `---\nname: ${name}\ndescription: ${body}\n---\n# ${name}\n`);
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  // path.resolve('skills') is a search dir: keep the repo's own skills/ out.
  originalCwd = process.cwd();
  process.chdir(WALNUT_HOME);
  clearSkillsCache();
  _resetSkillListCacheForTest();
  skillReads = [];
  const realReadFile = fsp.readFile.bind(fsp);
  vi.spyOn(fsp, 'readFile').mockImplementation(((...args: Parameters<typeof fsp.readFile>) => {
    if (String(args[0]).endsWith('SKILL.md')) skillReads.push(String(args[0]));
    return realReadFile(...args);
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.chdir(originalCwd);
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('listAllSkills cache', () => {
  it('reads each SKILL.md once for repeated calls on an unchanged tree', async () => {
    await seed('alpha', 'first');
    await seed('beta', 'second');

    const first = await listAllSkills();
    expect(first.map((s) => s.dirName).sort()).toEqual(['alpha', 'beta']);
    expect(skillReads).toHaveLength(2);

    for (let i = 0; i < 5; i++) {
      const again = await listAllSkills();
      expect(again).toEqual(first);
    }
    expect(skillReads).toHaveLength(2);
  });

  it('keeps the response shape, bodies included', async () => {
    await seed('alpha', 'first');
    await listAllSkills();
    const [cached] = await listAllSkills();
    expect(Object.keys(cached)).toEqual([
      'dirName', 'name', 'description', 'source', 'location', 'content', 'category',
      'type', 'metadata', 'eligible', 'enabled', 'hasReferences',
    ]);
    expect(cached.content).toContain('# alpha');
    expect(cached.source).toBe('walnut');
  });

  it('sees an in-place edit on the next call', async () => {
    await seed('alpha', 'first');
    expect((await listAllSkills())[0].description).toBe('first');

    // A longer body changes the size, so the key moves even within one mtime tick.
    await seed('alpha', 'edited in place');
    expect((await listAllSkills())[0].description).toBe('edited in place');
  });

  it('serves the cached body while mtime and size are unchanged (proves no re-read)', async () => {
    // Whole seconds: utimes takes a Date (ms), and a fresh file's mtime has a
    // sub-millisecond part it could never be set back to.
    const mtime = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await seed('alpha', 'aaaa');
    await fsp.utimes(skillFile('alpha'), mtime, mtime);
    await listAllSkills();

    await seed('alpha', 'bbbb'); // same length
    await fsp.utimes(skillFile('alpha'), mtime, mtime);
    expect((await listAllSkills())[0].description).toBe('aaaa');

    const later = new Date(mtime.getTime() + 5_000);
    await fsp.utimes(skillFile('alpha'), later, later);
    expect((await listAllSkills())[0].description).toBe('bbbb');
  });

  it('sees an added and a removed skill', async () => {
    await seed('alpha', 'first');
    expect((await listAllSkills()).map((s) => s.dirName)).toEqual(['alpha']);

    await seed('beta', 'second');
    expect((await listAllSkills()).map((s) => s.dirName).sort()).toEqual(['alpha', 'beta']);

    await fsp.rm(path.dirname(skillFile('alpha')), { recursive: true });
    expect((await listAllSkills()).map((s) => s.dirName)).toEqual(['beta']);
  });

  it('rebuilds after clearSkillsCache even when nothing on disk moved', async () => {
    await seed('alpha', 'first');
    await listAllSkills();
    expect(skillReads).toHaveLength(1);
    clearSkillsCache();
    await listAllSkills();
    expect(skillReads).toHaveLength(2);
  });

  it('rebuilds once the 60s age cap passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await seed('alpha', 'first');
    await listAllSkills();
    vi.setSystemTime(Date.now() + 59_000);
    await listAllSkills();
    expect(skillReads).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2_000);
    await listAllSkills();
    expect(skillReads).toHaveLength(2);
  });

  it('shares one build between concurrent callers', async () => {
    await seed('alpha', 'first');
    await seed('beta', 'second');
    const results = await Promise.all(Array.from({ length: 10 }, () => listAllSkills()));
    expect(skillReads).toHaveLength(2);
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('applies the current settings file to `enabled` on a cache hit', async () => {
    await seed('alpha', 'first');
    expect((await listAllSkills())[0].enabled).toBe(true);

    // Written behind the store's back: no clearSkillsCache, and not in the key.
    await fsp.writeFile(SKILL_SETTINGS_FILE, JSON.stringify({ disabled: ['alpha'] }));
    expect((await listAllSkills())[0].enabled).toBe(false);
    expect(skillReads).toHaveLength(1);

    await setSkillEnabled('alpha', true);
    expect((await listAllSkills())[0].enabled).toBe(true);
  });

  it('a caller editing its result cannot change the next answer', async () => {
    await seed('alpha', 'first');
    const mine = await listAllSkills();
    mine[0].name = 'tampered';
    mine.pop();
    const next = await listAllSkills();
    expect(next).toHaveLength(1);
    expect(next[0].name).toBe('alpha');
  });

  it('hasReferences reflects a references/ directory', async () => {
    await seed('alpha', 'first');
    await fsp.mkdir(path.join(path.dirname(skillFile('alpha')), 'references'));
    expect((await listAllSkills())[0].hasReferences).toBe(true);
  });
});
