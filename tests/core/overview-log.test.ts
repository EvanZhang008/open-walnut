import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, GLOBAL_SKILLS_DIR } from '../../src/constants.js';
import {
  appendOverviewLog,
  hasOverview,
  overviewHistoryDir,
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
