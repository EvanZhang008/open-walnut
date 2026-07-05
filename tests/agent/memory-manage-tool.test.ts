import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { memoryManageTool } from '../../src/agent/tools/memory-manage-tool.js';
import { getBoundedMemory, MEMORY_CHAR_BUDGET } from '../../src/core/bounded-memory.js';
import { WALNUT_HOME, MEMORY_FILE } from '../../src/constants.js';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  getBoundedMemory().resetConsolidationFailures();
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

const exec = async (params: Record<string, unknown>) =>
  JSON.parse((await memoryManageTool.execute(params)) as string);

describe('memory_manage tool', () => {
  it('schema embeds triage guidance (WHEN / SKIP / batch-preferred)', () => {
    expect(memoryManageTool.name).toBe('memory_manage');
    const desc = memoryManageTool.description;
    expect(desc).toContain('WHEN to save');
    expect(desc).toContain('SKIP');
    expect(desc).toContain('daily log');
    expect(desc).toContain('knowledge skill');
    expect(desc).toContain('action skill');
    expect(desc).toContain('all-or-nothing');
  });

  it('add writes an entry to MEMORY.md', async () => {
    const res = await exec({ action: 'add', content: '## Always reply in Chinese\n\nUser preference.' });
    expect(res.success).toBe(true);
    expect(res.note).toContain('do not repeat');
    expect(fs.readFileSync(MEMORY_FILE, 'utf-8')).toContain('## Always reply in Chinese');
  });

  it('replace and remove work via old_text substring', async () => {
    await exec({ action: 'add', content: '## Rule A\n\nalpha body' });
    await exec({ action: 'add', content: '## Rule B\n\nbeta body' });

    const rep = await exec({ action: 'replace', old_text: 'alpha body', content: '## Rule A v2\n\nnew alpha' });
    expect(rep.success).toBe(true);

    const rem = await exec({ action: 'remove', old_text: 'beta body' });
    expect(rem.success).toBe(true);

    const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(raw).toContain('Rule A v2');
    expect(raw).not.toContain('beta body');
  });

  it('batch maps snake_case old_text into atomic operations', async () => {
    await exec({ action: 'add', content: '## Old\n\nstale content' });
    const res = await exec({
      action: 'batch',
      operations: [
        { action: 'remove', old_text: 'stale content' },
        { action: 'add', content: '## New\n\nfresh content' },
      ],
    });
    expect(res.success).toBe(true);
    const raw = fs.readFileSync(MEMORY_FILE, 'utf-8');
    expect(raw).toContain('## New');
    expect(raw).not.toContain('stale content');
  });

  it('over-budget error includes the skill-routing hint', async () => {
    await exec({ action: 'add', content: `## Big\n\n${'x'.repeat(MEMORY_CHAR_BUDGET - 200)}` });
    const res = await exec({ action: 'add', content: `## Overflow\n\n${'y'.repeat(500)}` });
    expect(res.success).toBe(false);
    expect(res.hint).toContain('skill');
    expect(res.hint).toContain('knowledge');
    expect(res.currentEntries).toHaveLength(1);
  });

  it('rejects unknown actions gracefully', async () => {
    const out = (await memoryManageTool.execute({ action: 'nuke' })) as string;
    expect(out).toContain('Unknown action');
  });
});
