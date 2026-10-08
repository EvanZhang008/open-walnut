/**
 * project-summary — fast-model per-project summaries regenerated on task-count
 * threshold CROSSINGS (1, 2, 4, 8, 20, then every 20). Contract pinned:
 *   - crossing math: any threshold in (lastCount, count] fires, so bulk jumps
 *     and failed generations self-heal instead of waiting for an exact hit
 *   - full regeneration: previous summary + task titles reach the prompt;
 *     missing descriptions never block
 *   - persisted onto the task_projects registry row as summary + summary_task_count
 *   - between-threshold counts never call the model
 *   - bulk sources are debounced per project (one refresh after the burst),
 *     never refreshed per event and never dropped
 *   - the catch-up sweep refreshes exactly the projects whose stored count
 *     was crossed (or whose summary is missing) and skips current ones
 *
 * Real: summary code, task-manager (SQLite temp store). Fake: sendMessage,
 * config.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-project-summary'));

const sendMessageMock = vi.fn();
vi.mock('../../src/model/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
// config-manager is NOT mocked: constants point at a temp WALNUT_HOME, so the
// real one serves first-run defaults (bedrock provider) — and task-manager's
// addTask needs the full config shape (defaults.priority etc.).

import { WALNUT_HOME } from '../../src/constants.js';
import {
  hasCrossedThreshold, maybeRefreshForTask, refreshProjectSummary, regenerateSummaryOnDemand, runSummaryCatchUp,
  __resetProjectSummaryState, SUMMARY_REGENERATE_DEADLINE_MS,
} from '../../src/core/project-summary.js';
import { addTask, getTask, getProjectMetadata, setProjectMetadata, _resetForTesting as resetTaskManager } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import type { Task } from '../../src/core/types.js';

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

let seedCounter = 0;
async function seedTasks(n: number, project = 'walnut'): Promise<Task> {
  let last: Task | undefined;
  for (let i = 0; i < n; i++) {
    const { task } = await addTask({ title: `Task number ${++seedCounter}`, project });
    last = task;
  }
  return getTask(last!.id);
}

beforeEach(async () => {
  closeDb(); // rm alone leaves the open handle → tasks leak across tests
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  __resetProjectSummaryState();
  seedCounter = 0;
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(textResult('{"summary":"A project about walnut development."}'));
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('hasCrossedThreshold', () => {
  it('fires when any threshold lies in (lastCount, count]', () => {
    // Single-step creates reproduce the old exact-hit behavior…
    const singleStepHits = Array.from({ length: 61 }, (_, i) => i)
      .filter((count) => hasCrossedThreshold(count - 1, count));
    expect(singleStepHits).toEqual([1, 2, 4, 8, 20, 40, 60]);
    // …and jumps catch thresholds they leapt over.
    expect(hasCrossedThreshold(0, 3)).toBe(true);     // crossed 1 and 2
    expect(hasCrossedThreshold(0, 300)).toBe(true);   // bulk import
    expect(hasCrossedThreshold(8, 21)).toBe(true);    // crossed 20 (failed gen at 20 heals at 21)
    expect(hasCrossedThreshold(295, 301)).toBe(true); // crossed 300
  });

  it('stays quiet between thresholds and on shrink', () => {
    expect(hasCrossedThreshold(2, 3)).toBe(false);
    expect(hasCrossedThreshold(20, 39)).toBe(false);
    expect(hasCrossedThreshold(40, 40)).toBe(false);
    expect(hasCrossedThreshold(40, 21)).toBe(false); // deletes never trigger
    expect(hasCrossedThreshold(0, 0)).toBe(false);
  });
});

describe('maybeRefreshForTask', () => {
  it('generates and persists summary + summary_task_count at a threshold', async () => {
    const task = await seedTasks(1);

    const ran = await maybeRefreshForTask(task, 'web-api');

    expect(ran).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledOnce();
    const meta = await getProjectMetadata('walnut');
    expect(meta?.summary).toBe('A project about walnut development.');
    expect(meta?.summary_task_count).toBe(1);
  });

  it('the task-count refresh is a background model call (nobody waits on it)', async () => {
    const task = await seedTasks(1);
    expect(await maybeRefreshForTask(task, 'web-api')).toBe(true);
    expect(sendMessageMock.mock.calls[0][0].purpose).toBe('background');
  });

  it('does nothing between thresholds', async () => {
    const t2 = await seedTasks(2);
    await maybeRefreshForTask(t2, 'web-api'); // summarizes at count 2
    sendMessageMock.mockClear();

    const t3 = await seedTasks(1); // count 3 — no threshold in (2, 3]
    expect(await maybeRefreshForTask(t3, 'web-api')).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('a failed generation self-heals on the next create (crossing, not exact hit)', async () => {
    const t2 = await seedTasks(2);
    sendMessageMock.mockResolvedValueOnce(textResult('not json')); // generation fails at 2
    expect(await maybeRefreshForTask(t2, 'web-api')).toBe(false);

    const t3 = await seedTasks(1); // count 3: (0, 3] still contains 1 and 2
    expect(await maybeRefreshForTask(t3, 'web-api')).toBe(true);
    const meta = await getProjectMetadata('walnut');
    expect(meta?.summary_task_count).toBe(3);
  });

  it('skips subtasks and metadata tasks', async () => {
    const task = await seedTasks(1);
    expect(await maybeRefreshForTask({ ...task, parent_task_id: 'x' }, 'web-api')).toBe(false);
    expect(await maybeRefreshForTask({ ...task, title: '.metadata_project' }, 'web-api')).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('debounces bulk sources: a burst is one refresh at the final count, never a drop', async () => {
    process.env.WALNUT_SUMMARY_SYNC_DEBOUNCE_MS = '50';
    try {
      // Simulate a sync import: 5 creates in a tight loop, each firing the event.
      for (let i = 0; i < 5; i++) {
        const last = await seedTasks(1);
        expect(await maybeRefreshForTask(last, 'ms-todo-reconcile')).toBe(false);
      }
      expect(sendMessageMock).not.toHaveBeenCalled(); // nothing during the burst

      // Wait for the stored count, not the model call: the metadata write lands after
      // the call resolves, and a read in between sees nothing on a slow runner.
      await vi.waitFor(async () => {
        const meta = await getProjectMetadata('walnut');
        expect(meta?.summary_task_count).toBe(5); // final count, not any mid-burst size
      }, { timeout: 3_000 });
      expect(sendMessageMock).toHaveBeenCalledOnce();

      // The quiet window elapsing again must not double-fire.
      await new Promise((r) => setTimeout(r, 150));
      expect(sendMessageMock).toHaveBeenCalledOnce();
    } finally {
      delete process.env.WALNUT_SUMMARY_SYNC_DEBOUNCE_MS;
    }
  });

  it('dedupes a re-fired threshold via summary_task_count', async () => {
    const task = await seedTasks(2);

    expect(await maybeRefreshForTask(task, 'web-api')).toBe(true);
    expect(await maybeRefreshForTask(task, 'web-api')).toBe(false); // same count, already recorded
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  it('feeds the previous summary and task titles into the prompt; tolerates missing descriptions', async () => {
    const task = await seedTasks(2);
    await maybeRefreshForTask(task, 'web-api'); // seeds previous summary at count 2

    // Two more tasks → count 4 (threshold). None of the tasks have descriptions.
    const t4 = await seedTasks(2);
    sendMessageMock.mockResolvedValue(textResult('{"summary":"Updated: walnut work continues."}'));
    expect(await maybeRefreshForTask(t4, 'web-api')).toBe(true);

    const content = sendMessageMock.mock.calls.at(-1)![0].messages[0].content as string;
    expect(content).toContain('Previous summary:');
    expect(content).toContain('A project about walnut development.');
    expect(content).toContain('Task number 4');
    const meta = await getProjectMetadata('walnut');
    expect(meta?.summary).toBe('Updated: walnut work continues.');
    expect(meta?.summary_task_count).toBe(4);
  });

  it('never summarizes Inbox (no project = the unfiled pile)', async () => {
    const { task } = await addTask({ title: 'Loose thought' });
    expect(task.project).toBe('');

    expect(await maybeRefreshForTask(await getTask(task.id), 'web-api')).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('counts a project case-insensitively (NOCASE identity)', async () => {
    // 'walnut' + 'WALNUT' are one project → the 2nd create hits threshold 2.
    await seedTasks(1, 'walnut');
    const task = await seedTasks(1, 'WALNUT');

    expect(await maybeRefreshForTask(task, 'web-api')).toBe(true);
    const content = sendMessageMock.mock.calls.at(-1)![0].messages[0].content as string;
    expect(content).toContain('(2 tasks)');
  });

  it('keeps prior metadata keys when writing the summary', async () => {
    const { setProjectMetadata } = await import('../../src/core/task-manager.js');
    await setProjectMetadata('walnut', { default_cwd: '/tmp/walnut' });
    const task = await seedTasks(1);

    await maybeRefreshForTask(task, 'web-api');

    const meta = await getProjectMetadata('walnut');
    expect(meta?.default_cwd).toBe('/tmp/walnut');
    expect(meta?.summary).toBeTruthy();
  });
});

describe('runSummaryCatchUp', () => {
  it('refreshes projects with a missing or stale-count summary, skips current ones', async () => {
    // "fresh": summarized at its current size → untouched.
    const fresh = await seedTasks(2, 'fresh');
    await maybeRefreshForTask(fresh, 'web-api');
    // "stale": summarized at 2, then grew past a threshold while events were missed.
    const stale = await seedTasks(2, 'stale');
    await maybeRefreshForTask(stale, 'web-api');
    await seedTasks(2, 'stale'); // count 4 — no event delivered (e.g. server was down)
    // "naked": tasks imported before the mechanism existed — no summary at all.
    await seedTasks(3, 'naked');
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue(textResult('{"summary":"Caught up."}'));

    const refreshed = await runSummaryCatchUp();

    expect(refreshed).toBe(2);
    expect((await getProjectMetadata('fresh'))?.summary).toBe('A project about walnut development.');
    expect((await getProjectMetadata('stale'))?.summary).toBe('Caught up.');
    expect((await getProjectMetadata('stale'))?.summary_task_count).toBe(4);
    expect((await getProjectMetadata('naked'))?.summary).toBe('Caught up.');
    // The boot sweep runs on its own: background.
    expect(sendMessageMock.mock.calls.map(([o]) => o.purpose)).toEqual(['background', 'background']);
  });

  it('regenerates when the summary text vanished even though the count survived', async () => {
    const task = await seedTasks(2, 'wiped');
    await maybeRefreshForTask(task, 'web-api');
    await setProjectMetadata('wiped', { summary: '' }); // registry edited, count stays 2
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValue(textResult('{"summary":"Restored."}'));

    expect(await runSummaryCatchUp()).toBe(1);
    expect((await getProjectMetadata('wiped'))?.summary).toBe('Restored.');
  });

  it('one failing project does not stop the sweep', async () => {
    await seedTasks(1, 'alpha');
    await seedTasks(1, 'beta');
    sendMessageMock
      .mockResolvedValueOnce(textResult('not json'))
      .mockResolvedValueOnce(textResult('{"summary":"Beta ok."}'));

    expect(await runSummaryCatchUp()).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('aborts after three consecutive generation failures (model route down)', async () => {
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) await seedTasks(1, p);
    sendMessageMock.mockResolvedValue(textResult('not json')); // every generation fails

    expect(await runSummaryCatchUp()).toBe(0);
    expect(sendMessageMock).toHaveBeenCalledTimes(3); // p4/p5 never burn a timeout
  });
});

describe('refreshProjectSummary', () => {
  it('returns false (and persists nothing) when the model output is unusable', async () => {
    await seedTasks(1);
    sendMessageMock.mockResolvedValue(textResult('not json'));

    expect(await refreshProjectSummary('walnut', { purpose: 'interactive' })).toBe(false);
    expect(await getProjectMetadata('walnut')).toBeNull();
  });

  it('hands the caller\'s purpose to the model call', async () => {
    await seedTasks(1);
    expect(await refreshProjectSummary('walnut', { purpose: 'interactive' })).toBe(true);
    expect(await refreshProjectSummary('walnut', { purpose: 'background' })).toBe(true);
    expect(sendMessageMock.mock.calls.map(([o]) => o.purpose)).toEqual(['interactive', 'background']);
  });

  it('returns false for a project with no tasks', async () => {
    expect(await refreshProjectSummary('ghost', { purpose: 'interactive' })).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('regenerateSummaryOnDemand ("Regenerate summary")', () => {
  type Held = { signal: AbortSignal; answer: () => void };
  /** Model calls that answer only when told to, or with nothing once their signal aborts. */
  function holdCalls(): Held[] {
    const calls: Held[] = [];
    sendMessageMock.mockImplementation((opts: { signal: AbortSignal }) => new Promise((resolve) => {
      opts.signal.addEventListener('abort', () => resolve({ content: [], stopReason: null, aborted: true }), { once: true });
      calls.push({ signal: opts.signal, answer: () => resolve(textResult('{"summary":"Held."}')) });
    }));
    return calls;
  }
  async function untilCalls(calls: Held[], n: number): Promise<void> {
    const end = Date.now() + 10_000;
    while (calls.length < n) {
      if (Date.now() > end) throw new Error(`expected ${n} model calls, saw ${calls.length}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('a repeat request for the same project joins the run: one model call answers both', async () => {
    await seedTasks(1);
    const calls = holdCalls();
    const first = regenerateSummaryOnDemand('walnut', new AbortController().signal);
    await untilCalls(calls, 1);
    const repeat = regenerateSummaryOnDemand('Walnut');
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(1);
    calls[0].answer();
    expect(await first).toBe(true);
    expect(await repeat).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledOnce();
    expect(sendMessageMock.mock.calls[0][0].purpose).toBe('interactive');
    expect((await getProjectMetadata('walnut'))?.summary).toBe('Held.');
  });

  it('stops the model turn once every requester has gone, and the next request starts afresh', async () => {
    await seedTasks(1);
    const calls = holdCalls();
    const one = new AbortController();
    const two = new AbortController();
    const a = regenerateSummaryOnDemand('walnut', one.signal);
    const b = regenerateSummaryOnDemand('walnut', two.signal);
    await untilCalls(calls, 1);
    one.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls[0].signal.aborted).toBe(false); // the other one still waits
    two.abort();
    expect(calls[0].signal.aborted).toBe(true);
    // A click right after, while the stopped turn is still winding down, starts
    // its own instead of joining the one nobody waits for.
    const again = regenerateSummaryOnDemand('walnut');
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    await untilCalls(calls, 2);
    expect(calls[1].signal.aborted).toBe(false);
    calls[1].answer();
    expect(await again).toBe(true);
    expect((await getProjectMetadata('walnut'))?.summary).toBe('Held.');
  });

  it('a request whose signal already aborted starts no model call', async () => {
    await seedTasks(1);
    const calls = holdCalls();
    const gone = new AbortController();
    gone.abort();
    expect(await regenerateSummaryOnDemand('walnut', gone.signal)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('stops the model turn at its deadline', async () => {
    await seedTasks(1);
    const calls = holdCalls();
    const t0 = Date.now();
    const run = regenerateSummaryOnDemand('walnut', undefined, { deadlineMs: 200 });
    await untilCalls(calls, 1);
    expect(await run).toBe(false);
    expect(calls[0].signal.aborted).toBe(true);
    // The deadline stopped it, long before the attempt's own 15 s budget.
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('without a deadline of its own, a click stops at SUMMARY_REGENERATE_DEADLINE_MS (the direct attempt plus the CLI budget)', async () => {
    await seedTasks(1);
    const calls = holdCalls();
    expect(SUMMARY_REGENERATE_DEADLINE_MS).toBe(15_000 + 60_000);
    // The deadline timer is the first one a new run arms, before its first await.
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const run = regenerateSummaryOnDemand('walnut');
    const armed = spy.mock.calls.slice();
    spy.mockRestore();
    expect(armed[0]?.[1]).toBe(SUMMARY_REGENERATE_DEADLINE_MS);
    await untilCalls(calls, 1);
    expect(calls[0].signal.aborted).toBe(false);
    (armed[0][0] as () => void)();
    expect(calls[0].signal.aborted).toBe(true);
    expect(await run).toBe(false);
  });
});
