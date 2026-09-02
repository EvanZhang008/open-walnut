import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

const indexMocks = vi.hoisted(() => ({
  sweepSearchV2Files: vi.fn(async () => ({ changed: 0, removed: 0 })),
}));

// The real sweep opens search.sqlite and walks the vault — stub the whole
// index-refresh path so skill writes stay pure filesystem work here.
vi.mock('../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  sweepSearchV2Files: indexMocks.sweepSearchV2Files,
}));

import { skillManageTool } from '../../src/agent/tools/skill-manage-tool.js';
import { skillViewTool } from '../../src/agent/tools/skill-view-tool.js';
import { loadSkillUsage } from '../../src/core/skill-usage.js';
import { clearSkillsCache } from '../../src/core/skill-loader.js';
import { WALNUT_HOME, GLOBAL_SKILLS_DIR } from '../../src/constants.js';

let originalCwd: string;

/** The index refresh is fire-and-forget (`void import(...).then(sweep)`) — let
 *  the microtask chain plus one macrotask tick land before asserting on it. */
async function settleIndexRefreshes(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(async () => {
  await settleIndexRefreshes();
  vi.clearAllMocks();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  originalCwd = process.cwd();
  process.chdir(WALNUT_HOME); // keep repo workspace skills/ out of discovery
  clearSkillsCache();
});

afterEach(async () => {
  await settleIndexRefreshes();
  process.chdir(originalCwd);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      if (attempt === 2) throw new Error(`Failed to remove test directory: ${WALNUT_HOME}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

const create = (over: Record<string, unknown> = {}) =>
  skillManageTool.execute({
    action: 'create',
    name: 'tax-filing',
    category: 'finance',
    type: 'knowledge',
    description: 'US tax filing facts: deadlines, forms, filing history.',
    content: '# Tax Filing\n\n- Deadline: April 15.\n- Filed 2025 via FreeTaxUSA.',
    ...over,
  });

describe('skill_manage create', () => {
  it('creates a categorized skill with generated frontmatter', async () => {
    const out = (await create()) as string;
    expect(out).toContain("created");
    const file = path.join(GLOBAL_SKILLS_DIR, 'finance', 'tax-filing', 'SKILL.md');
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).toContain('name: tax-filing');
    expect(raw).toContain('type: knowledge');
    expect(raw).toContain('Deadline: April 15');
  });

  it('hard-rejects descriptions over 60 chars with the char count', async () => {
    const longDesc = 'x'.repeat(75);
    const out = (await create({ description: longDesc })) as string;
    expect(out).toContain('75 chars');
    expect(out).toContain('≤60');
    expect(fs.existsSync(path.join(GLOBAL_SKILLS_DIR, 'finance', 'tax-filing'))).toBe(false);
  });

  it('records created_by=agent telemetry', async () => {
    await create();
    const usage = loadSkillUsage();
    expect(usage['tax-filing']?.created_by).toBe('agent');
    expect(usage['tax-filing']?.created_at).toBeDefined();
  });

  it('kicks a search-index refresh after every skill write', async () => {
    // A just-written skill must be findable in the same conversation; the
    // 10-min periodic sweep is only the safety net. Each write path kicks one
    // refresh (mtime-diffed, so an unchanged vault costs a stat walk).
    await create();
    await vi.waitFor(() => {
      expect(indexMocks.sweepSearchV2Files).toHaveBeenCalledTimes(1);
    });

    await skillManageTool.execute({
      action: 'patch',
      name: 'tax-filing',
      old_string: 'Deadline: April 15.',
      new_string: 'Deadline: April 15 (Oct 15 with extension).',
    });
    await vi.waitFor(() => {
      expect(indexMocks.sweepSearchV2Files).toHaveBeenCalledTimes(2);
    });

    await skillManageTool.execute({ action: 'delete', name: 'tax-filing' });
    await vi.waitFor(() => {
      expect(indexMocks.sweepSearchV2Files).toHaveBeenCalledTimes(3);
    });
  });

  it('rejects duplicate names', async () => {
    await create();
    const out = (await create()) as string;
    expect(out).toContain('already exists');
  });

  it('embeds the 5 update triggers in the schema description', () => {
    const d = skillManageTool.description;
    expect(d).toContain('patch it immediately, BEFORE finishing');
    expect(d).toContain('offer to save');
    expect(d).toContain('patch that skill now');
    expect(d).toContain('create one');
    expect(d).toContain('never append a duplicate');
    expect(d).toContain('routing signal');
  });
});

describe('skill_manage patch/edit/delete', () => {
  beforeEach(async () => {
    await create();
  });

  it('patch replaces exact text', async () => {
    const out = (await skillManageTool.execute({
      action: 'patch',
      name: 'tax-filing',
      old_string: 'Deadline: April 15.',
      new_string: 'Deadline: April 15 (Oct 15 with extension).',
    })) as string;
    expect(out).toContain('patched');
    expect(out).toContain('do not repeat');
    const raw = fs.readFileSync(
      path.join(GLOBAL_SKILLS_DIR, 'finance', 'tax-filing', 'SKILL.md'),
      'utf-8',
    );
    expect(raw).toContain('Oct 15 with extension');
    expect(loadSkillUsage()['tax-filing']?.last_patched_at).toBeDefined();
  });

  it('patch errors on missing or ambiguous old_string', async () => {
    const miss = (await skillManageTool.execute({
      action: 'patch', name: 'tax-filing', old_string: 'nope', new_string: 'x',
    })) as string;
    expect(miss).toContain('not found');

    await skillManageTool.execute({
      action: 'patch', name: 'tax-filing',
      old_string: 'Filed 2025', new_string: 'Filed 2025 dup Filed 2025',
    });
    const ambig = (await skillManageTool.execute({
      action: 'patch', name: 'tax-filing', old_string: 'Filed 2025', new_string: 'x',
    })) as string;
    expect(ambig).toContain('2 locations');
  });

  it('edit rewrites body and can flip type, keeping description when omitted', async () => {
    const out = (await skillManageTool.execute({
      action: 'edit',
      name: 'tax-filing',
      type: 'action',
      content: '# New body\n\nStep 1: do the thing.',
    })) as string;
    expect(out).toContain('rewritten');
    const raw = fs.readFileSync(
      path.join(GLOBAL_SKILLS_DIR, 'finance', 'tax-filing', 'SKILL.md'),
      'utf-8',
    );
    expect(raw).toContain('type: action');
    expect(raw).toContain('Step 1: do the thing');
    expect(raw).toContain('US tax filing facts'); // description preserved
    expect(raw).not.toContain('April 15');
  });

  it('delete removes skill dir and telemetry record', async () => {
    const out = (await skillManageTool.execute({ action: 'delete', name: 'tax-filing' })) as string;
    expect(out).toContain('deleted');
    expect(fs.existsSync(path.join(GLOBAL_SKILLS_DIR, 'finance', 'tax-filing'))).toBe(false);
    expect(loadSkillUsage()['tax-filing']).toBeUndefined();
  });
});

describe('skill_view', () => {
  beforeEach(async () => {
    await create();
  });

  it('returns full SKILL.md content and bumps usage', async () => {
    const out = (await skillViewTool.execute({ name: 'tax-filing' })) as string;
    expect(out).toContain('Deadline: April 15');
    // bump is fire-and-forget — allow it to settle
    await new Promise((r) => setTimeout(r, 100));
    const usage = loadSkillUsage();
    expect(usage['tax-filing']?.use_count).toBe(1);
    expect(usage['tax-filing']?.view_count).toBe(1);
    expect(usage['tax-filing']?.last_used_at).toBeDefined();
  });

  it('reads a reference file inside the skill dir', async () => {
    const refDir = path.join(GLOBAL_SKILLS_DIR, 'finance', 'tax-filing', 'references');
    await fsp.mkdir(refDir, { recursive: true });
    await fsp.writeFile(path.join(refDir, 'forms.md'), '1040 details');
    const out = (await skillViewTool.execute({
      name: 'tax-filing',
      file_path: 'references/forms.md',
    })) as string;
    expect(out).toBe('1040 details');
  });

  it('blocks path traversal via file_path', async () => {
    const out = (await skillViewTool.execute({
      name: 'tax-filing',
      file_path: '../../../MEMORY.md',
    })) as string;
    expect(out).toContain('Invalid file_path');
  });

  it('returns a friendly error for unknown skills', async () => {
    const out = (await skillViewTool.execute({ name: 'ghost' })) as string;
    expect(out).toContain('not found');
  });
});
