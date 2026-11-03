/**
 * After a compaction, Main's or a VP's core instructions come back first and whole, whatever else
 * the restatement holds (2026-11-03: the Walnut VP's restatement was 47 KB, Claude Code showed the
 * model a 2 KB preview, the core instructions sat at character 21,587, and the VP did the work itself
 * right after). The rest is cut to what a hook may add, and `full` reads it all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-compaction-core-first'));
import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask, updateTaskRaw } from '../../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js';
import { WALNUT_PROMPT_MARK, buildSessionContext } from '../../../src/core/sessions/session-context.js';
import { HOOK_CONTEXT_MAX, READ_ALL_AFTER_COMPACTION, collectOpenItems } from '../../../src/core/sessions/open-items.js';
import { orgSelfWorkRule } from '../../../src/core/org/core-instructions.js';
import { resetCache } from '../../../src/core/session-message-queue.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});

/** An org node's session, with a MEMORY.md long enough to push the restatement past the limit. */
async function node(role: 'main' | 'lead', prompt: 'current' | 'ancient') {
  const { task } = await addTask({ title: role === 'main' ? 'Main agent' : 'Lead', project: role === 'main' ? 'Ask Walnut' : 'marina', org_role: role });
  const memory = Array.from({ length: 300 }, (_, i) => `- line ${i}: a tracking note about one of the teams, long enough to matter.`).join('\n');
  await updateTaskRaw(task.id, { agent_memory: { text: memory, at: new Date().toISOString() } } as never);
  const sid = randomUUID();
  await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
  await updateSessionRecord(sid, { appliedAppendSystemPrompt: prompt === 'current' ? (await buildSessionContext(task.id)).systemPrompt : WALNUT_PROMPT_MARK });
  return { sid, task };
}

describe('the compaction readback of an org node', () => {
  for (const role of ['lead', 'main'] as const) {
    for (const prompt of ['current', 'ancient'] as const) {
      it(`${role}, ${prompt} prompt: core instructions first and whole, the rest cut within the limit`, async () => {
        const { sid } = await node(role, prompt);
        const hook = await collectOpenItems(sid, Date.now(), { afterCompaction: true });
        expect(hook.text.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX);
        expect(hook.text.startsWith('Restated after the compaction, first because they are your role\'s first rules.')).toBe(true);
        expect(hook.text).toContain(orgSelfWorkRule(role));
        const full = await collectOpenItems(sid, Date.now(), { afterCompaction: true, full: true });
        expect(full.text.startsWith('Restated after the compaction')).toBe(true);
        expect(full.text).toContain('line 0: a tracking note');
        // Cut: it says so and how to read it all; uncut: full is the same text.
        if (hook.text.includes('(Cut here:')) {
          expect(hook.text).toContain(READ_ALL_AFTER_COMPACTION);
          expect(full.text.length).toBeGreaterThan(hook.text.length);
        }
      });
    }
  }

  it('a worker gets no core instructions block', async () => {
    const { task } = await addTask({ title: 'Worker', project: 'marina' });
    const sid = randomUUID();
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: (await buildSessionContext(task.id)).systemPrompt });
    const hook = await collectOpenItems(sid, Date.now(), { afterCompaction: true });
    expect(hook.text).not.toContain('Restated after the compaction');
  });
});
