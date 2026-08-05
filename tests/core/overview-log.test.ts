/**
 * Skill history logs. NOTE on vocabulary: `category` in this module is the SKILL
 * grouping directory (skills/<group>/<name>/) — an independent concept that
 * survived the task-model refactor, where Project is the only grouping layer.
 * Task projects reach their skill by NAME SEARCH across those groups
 * (resolveProjectSkillDir), which is what the last describe block covers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, GLOBAL_SKILLS_DIR } from '../../src/constants.js';
import {
  appendOverviewLog,
  appendSkillHistoryForProject,
  hasOverview,
  overviewHistoryDir,
  resolveProjectSkillDir,
  skillHistoryDir,
  PROJECT_SKILL_CATEGORY,
  OVERVIEW_LOG_ROTATE_LIMIT,
} from '../../src/core/overview-log.js';

const CAT = 'walnut';

async function seedOverview(category = CAT): Promise<void> {
  const dir = path.join(GLOBAL_SKILLS_DIR, category, 'overview');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: overview\ndescription: '${category} project overview'\ntype: knowledge\n---\n\n# Overview\n`,
  );
}

/** A curated project skill under an arbitrary skill grouping directory. */
async function seedProjectSkill(skillCategory: string, name: string): Promise<void> {
  const dir = path.join(GLOBAL_SKILLS_DIR, skillCategory, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: '${name} project skill'\ntype: knowledge\n---\n\n# ${name}\n`,
  );
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('appendOverviewLog', () => {
  it('refuses when the category has no overview skill', () => {
    expect(hasOverview(CAT)).toBe(false);
    expect(() => appendOverviewLog(CAT, 'entry')).toThrow(/no overview skill/);
  });

  it('appends a timestamped entry to history/log.md', async () => {
    await seedOverview();
    const res = appendOverviewLog(CAT, 'Shipped the history.db conversation index.', 'task-hook');
    expect(res.rotated).toBe(false);
    const raw = fs.readFileSync(res.file, 'utf-8');
    expect(raw).toContain('# walnut progress log');
    expect(raw).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2} — task-hook/);
    expect(raw).toContain('Shipped the history.db conversation index.');
  });

  it('appends multiple entries in order', async () => {
    await seedOverview();
    appendOverviewLog(CAT, 'first entry');
    const res = appendOverviewLog(CAT, 'second entry');
    const raw = fs.readFileSync(res.file, 'utf-8');
    expect(raw.indexOf('first entry')).toBeLessThan(raw.indexOf('second entry'));
  });

  it('rotates by size: archives current volume with date-stamped name, links it', async () => {
    await seedOverview();
    const historyDir = overviewHistoryDir(CAT);
    await fsp.mkdir(historyDir, { recursive: true });
    // Pre-fill log.md just under the limit
    await fsp.writeFile(path.join(historyDir, 'log.md'), 'x'.repeat(OVERVIEW_LOG_ROTATE_LIMIT - 10));

    const res = appendOverviewLog(CAT, 'entry that triggers rotation');
    expect(res.rotated).toBe(true);
    expect(res.archivedVolume).toMatch(/^log\.\d{8}-1\.md$/);

    const archived = fs.readFileSync(path.join(historyDir, res.archivedVolume!), 'utf-8');
    expect(archived.startsWith('xxx')).toBe(true);

    const fresh = fs.readFileSync(path.join(historyDir, 'log.md'), 'utf-8');
    expect(fresh).toContain(`Previous volume: [${res.archivedVolume}](./${res.archivedVolume})`);
    expect(fresh).toContain('entry that triggers rotation');
  });

  it('same-day second rotation increments the sequence', async () => {
    await seedOverview();
    const historyDir = overviewHistoryDir(CAT);
    await fsp.mkdir(historyDir, { recursive: true });

    for (const expectSeq of [1, 2]) {
      await fsp.writeFile(path.join(historyDir, 'log.md'), 'y'.repeat(OVERVIEW_LOG_ROTATE_LIMIT));
      const res = appendOverviewLog(CAT, `rotation ${expectSeq}`);
      expect(res.archivedVolume).toMatch(new RegExp(`^log\\.\\d{8}-${expectSeq}\\.md$`));
    }
  });

  it('rejects empty entries and path-traversal categories', async () => {
    await seedOverview();
    expect(() => appendOverviewLog(CAT, '   ')).toThrow(/empty/);
    expect(() => appendOverviewLog('../evil', 'x')).toThrow(/Invalid category/);
    expect(() => appendOverviewLog('a/b', 'x')).toThrow(/Invalid category/);
  });
});

// A task carries only a project name, so the skill grouping directory can no
// longer be derived from it — it has to be searched for by name.
describe('resolveProjectSkillDir', () => {
  it('finds a project skill under any skill grouping directory, case-insensitively', async () => {
    await seedProjectSkill('work', 'Walnut');

    expect(resolveProjectSkillDir('walnut')).toEqual({ skillCategory: 'work', name: 'Walnut' });
    expect(resolveProjectSkillDir('WALNUT')).toEqual({ skillCategory: 'work', name: 'Walnut' });
  });

  it('picks the alphabetically first grouping when the same name exists twice', async () => {
    await seedProjectSkill('work', 'Walnut');
    await seedProjectSkill('archive', 'walnut');

    expect(resolveProjectSkillDir('walnut')?.skillCategory).toBe('archive');
  });

  it('returns null for an unknown project, Inbox, or a path-ish name', async () => {
    await seedProjectSkill('work', 'Walnut');

    expect(resolveProjectSkillDir('ghost')).toBeNull();
    expect(resolveProjectSkillDir('')).toBeNull();
    expect(resolveProjectSkillDir('   ')).toBeNull();
    expect(resolveProjectSkillDir('work/Walnut')).toBeNull();
    expect(resolveProjectSkillDir('../evil')).toBeNull();
  });

  it('exposes the grouping dir new project skills are created under', () => {
    expect(PROJECT_SKILL_CATEGORY).toBe('projects');
  });
});

describe('appendSkillHistoryForProject', () => {
  it('appends into the resolved project skill history', async () => {
    await seedProjectSkill('work', 'Walnut');

    const res = appendSkillHistoryForProject('walnut', 'Shipped the project registry.', 'session');

    expect(res).not.toBeNull();
    expect(path.dirname(res!.file)).toBe(skillHistoryDir('work', 'Walnut'));
    expect(fs.readFileSync(res!.file, 'utf-8')).toContain('Shipped the project registry.');
  });

  it('returns null (never throws) when the project has no skill, or for Inbox', async () => {
    expect(appendSkillHistoryForProject('ghost', 'entry')).toBeNull();
    expect(appendSkillHistoryForProject('', 'entry')).toBeNull();
  });
});
