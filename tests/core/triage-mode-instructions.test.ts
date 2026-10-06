/**
 * `triage.mode` reaches a run, and changing it re-patches the routine (S15, item 6).
 *
 * The mode is the ONLY difference between `ask` and `assist`, and it travels in the
 * routine's stored `executor.config.instructions` — which is why `matchesSpec`
 * compares that field. Without the comparison, flipping the switch in Settings
 * would leave every future run reading the old rules until some other field
 * happened to drift, and nobody would ever see a bug report for it.
 *
 * The wording itself is graded in tests/core/triage-quota.test.ts; here the
 * question is whether the wiring carries it.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('triage-mode'));

import {
  buildTriageRoutineSpec,
  ensureTriageRoutine,
  triageInstructionsFor,
} from '../../src/core/triage/bootstrap.js';
import { readTriageConfig } from '../../src/core/triage/config.js';
import { TRIAGE_MARK_READ_RULE, TRIAGE_NO_REMOVAL } from '../../src/core/triage/letter-rules.js';
import type { CronJob } from '../../src/core/cron/types.js';
import type { TriageConfig } from '../../src/core/triage/types.js';

/** An in-memory routine layer, shaped like the real one. */
function spyLayer() {
  const jobs: CronJob[] = [];
  let nextId = 1;
  const createRoutine = vi.fn(async (body: any) => {
    const job = { id: `job-${nextId++}`, state: {}, ...body, enabled: body.enabled ?? true } as CronJob;
    jobs.push(job);
    return { job };
  });
  const patchRoutine = vi.fn(async (id: string, body: any) => {
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`unknown cron job id: ${id}`);
    Object.assign(job as any, body);
    return { job };
  });
  return {
    jobs,
    createRoutine,
    patchRoutine,
    deps: {
      listRoutines: async () => jobs,
      createRoutine,
      patchRoutine,
      resolveAgent: async (id: string) => ({ id, name: 'Inbox Triage' }),
    },
  };
}

function cfg(triage: TriageConfig) {
  return async () => ({ triage });
}

const ASK: TriageConfig = { enabled: true, every: '30m', every_messages: 20, mode: 'ask' };

function instructionsOf(job: CronJob): string {
  return String((job.executor?.config ?? {}).instructions ?? '');
}

describe('the run instructions carry the mode', () => {
  it('ask and assist produce different instructions, both with the same budget', () => {
    const ask = triageInstructionsFor(readTriageConfig({ triage: { ...ASK, mode: 'ask' } }));
    const assist = triageInstructionsFor(readTriageConfig({ triage: { ...ASK, mode: 'assist' } }));
    expect(ask).not.toBe(assist);
    for (const text of [ask, assist]) {
      // The fixed half, then the budget, then the mode.
      expect(text).toContain('You are running one Inbox Triage batch');
      expect(text).toContain('at most 3 decision letters');
      expect(text).toContain('mail_request_send');
    }
    expect(ask).toContain('Mode: ask');
    expect(assist).toContain('Mode: assist');
  });

  it('the spec the routine is created with holds them', () => {
    const spec = buildTriageRoutineSpec(readTriageConfig({ triage: { ...ASK, mode: 'assist' } }));
    const config = (spec.executor as { config: Record<string, unknown> }).config;
    expect(String(config.instructions)).toContain('Mode: assist');
  });
});

describe('changing the mode re-patches the routine', () => {
  it('ask → assist is a patch, and a second call with the same mode is unchanged', async () => {
    const layer = spyLayer();
    const created = await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ASK) });
    expect(created.outcome).toBe('created');
    expect(instructionsOf(layer.jobs[0])).toContain('Mode: ask');

    const patched = await ensureTriageRoutine({
      ...layer.deps, getConfig: cfg({ ...ASK, mode: 'assist' }),
    });
    expect(patched.outcome).toBe('patched');
    expect(instructionsOf(layer.jobs[0])).toContain('Mode: assist');
    expect(instructionsOf(layer.jobs[0])).not.toContain('Mode: ask');

    const again = await ensureTriageRoutine({
      ...layer.deps, getConfig: cfg({ ...ASK, mode: 'assist' }),
    });
    expect(again.outcome).toBe('unchanged');
    expect(layer.patchRoutine).toHaveBeenCalledTimes(1);
  });

  it('auto_mark_read moves the instructions too — it is a permission, not a display flag', async () => {
    const layer = spyLayer();
    const assist: TriageConfig = { ...ASK, mode: 'assist' };
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(assist) });
    expect(instructionsOf(layer.jobs[0])).toContain('may NOT mark mail as read');

    const patched = await ensureTriageRoutine({
      ...layer.deps, getConfig: cfg({ ...assist, auto_mark_read: true }),
    });
    expect(patched.outcome).toBe('patched');
    expect(instructionsOf(layer.jobs[0])).toContain(TRIAGE_MARK_READ_RULE);
  });

  it('auto_mark_read moves ask mode as well: promotional mail may be marked read there too', async () => {
    const layer = spyLayer();
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ASK) });
    const before = instructionsOf(layer.jobs[0]);
    expect(before).not.toContain('mail_mark_read');
    const again = await ensureTriageRoutine({
      ...layer.deps, getConfig: cfg({ ...ASK, auto_mark_read: true }),
    });
    expect(again.outcome).toBe('patched');
    expect(instructionsOf(layer.jobs[0])).toContain('Mode: ask');
    expect(instructionsOf(layer.jobs[0])).toContain(TRIAGE_MARK_READ_RULE);
  });
});

describe('what a run does with each item', () => {
  const text = triageInstructionsFor(readTriageConfig({ triage: ASK }));

  it('hands an item to the task that already owns it, without a reply and without a letter', () => {
    expect(text).toContain('hand the item to that task with task_send (expect_reply=false)');
    expect(text).toContain('Do not do its work, and do not write the user a letter about it as well.');
  });

  it('does the homework before it asks the user', () => {
    expect(text).toContain('mail_draft');
    expect(text).toContain('the user only decides');
  });

  it('never removes mail, in either mode', () => {
    for (const mode of ['ask', 'assist'] as const) {
      expect(triageInstructionsFor(readTriageConfig({ triage: { ...ASK, mode } }))).toContain(TRIAGE_NO_REMOVAL);
    }
  });
});
