/**
 * ensureTriageRoutine — the ONE routine, and nothing else.
 *
 * The routine layer is injected (spies over createRoutine/patchRoutine/
 * listRoutines), so this file is about the DECISIONS: does enabling create
 * exactly one routine and zero tasks, is a second enable a no-op, does disabling
 * disable rather than delete, does a config change re-patch the right fields, and
 * does a missing console agent stop the whole thing.
 *
 * "Zero tasks, zero sessions" is asserted the only honest way at this layer: the
 * task manager and quickStartSession are spied and must never be called. The run
 * path (which DOES create a task) belongs to the executor, not to enabling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

const addTask = vi.fn();
const quickStartSession = vi.fn();
vi.mock('../../src/core/task-manager.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  addTask,
}));
vi.mock('../../src/core/sessions/quick-start.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  quickStartSession,
}));

import {
  ensureTriageRoutine,
  stopTriage,
  startTriageConfigWatcher,
  buildTriageRoutineSpec,
  findTriageRoutine,
  TRIAGE_PROJECT,
  TRIAGE_CONFIG_SUBSCRIBER,
} from '../../src/core/triage/bootstrap.js';
import { readTriageConfig } from '../../src/core/triage/config.js';
import { TRIAGE_ACTION_ID, TRIAGE_AGENT_ID } from '../../src/core/triage/types.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import type { CronJob } from '../../src/core/cron/types.js';
import type { TriageConfig } from '../../src/core/triage/types.js';

/** A spy routine layer holding jobs in memory, shaped like the real one. */
function spyLayer(initial: CronJob[] = []) {
  const jobs = [...initial];
  let nextId = 1;
  const createRoutine = vi.fn(async (body: any) => {
    const job = {
      id: `job-${nextId++}`,
      state: {},
      ...body,
      // The engine defaults `enabled` to true; mirror that.
      enabled: body.enabled ?? true,
      // The engine drops an explicit `wake: null` on a create.
      ...(body.wake === null ? { wake: undefined } : {}),
    } as CronJob;
    jobs.push(job);
    return { job };
  });
  const patchRoutine = vi.fn(async (id: string, body: any) => {
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`unknown cron job id: ${id}`);
    for (const [key, value] of Object.entries(body)) {
      if (key === 'wake' && value === null) { delete (job as any).wake; continue; }
      (job as any)[key] = value;
    }
    return { job };
  });
  return {
    jobs,
    deps: {
      listRoutines: async () => jobs,
      createRoutine,
      patchRoutine,
      resolveAgent: async (id: string) => ({ id, name: 'Inbox Triage' }),
    },
    createRoutine,
    patchRoutine,
  };
}

function cfg(triage: TriageConfig | undefined) {
  return async () => (triage ? { triage } : {});
}

const ON: TriageConfig = {
  enabled: true, every: '30m', every_messages: 20, sources: ['mail', 'slack'], mode: 'ask',
};

beforeEach(() => {
  addTask.mockClear();
  quickStartSession.mockClear();
  bus.unsubscribe(TRIAGE_CONFIG_SUBSCRIBER);
});

describe('off by default', () => {
  it('a fresh install creates nothing', async () => {
    const layer = spyLayer();
    const res = await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(undefined) });
    expect(res.outcome).toBe('absent');
    expect(layer.jobs).toHaveLength(0);
    expect(layer.createRoutine).not.toHaveBeenCalled();
    expect(layer.patchRoutine).not.toHaveBeenCalled();
  });

  it('every: "0" is off too — no routine, even with enabled: true', async () => {
    const layer = spyLayer();
    const res = await ensureTriageRoutine({
      ...layer.deps, getConfig: cfg({ enabled: true, every: '0' }),
    });
    expect(res.outcome).toBe('absent');
    expect(layer.createRoutine).not.toHaveBeenCalled();
  });
});

describe('enabling', () => {
  it('creates EXACTLY ONE routine, and no task and no session', async () => {
    const layer = spyLayer();
    const res = await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });

    expect(res.outcome).toBe('created');
    expect(layer.createRoutine).toHaveBeenCalledTimes(1);
    expect(layer.jobs).toHaveLength(1);
    // Each run mints its own task+session (decision D2) — enabling mints neither.
    expect(addTask).not.toHaveBeenCalled();
    expect(quickStartSession).not.toHaveBeenCalled();

    const job = layer.jobs[0] as any;
    expect(job.name).toBe('Inbox Triage');
    expect(job.schedule).toEqual({ kind: 'every', everyMs: 30 * 60_000 });
    expect(job.wake).toEqual({
      events: ['plugin:mail:messages-received', 'plugin:slack:messages-received'],
      countField: 'count',
      threshold: 20,
      skipWhenIdle: true,
    });
    expect(job.initProcessor).toEqual({
      actionId: TRIAGE_ACTION_ID, invokeAgent: true, timeoutSeconds: 30,
    });
    expect(job.executor.type).toBe('claude-code');
    expect(job.executor.config).toMatchObject({
      walnutAgent: true,
      agentId: TRIAGE_AGENT_ID,
      project: TRIAGE_PROJECT,
      titleTemplate: 'Triage · {time} · {count} items',
    });
    // The engine, deliberately: absent so the launch inherits defaults.engine.
    expect(job.executor.config.engine).toBeUndefined();
    expect(job.executor.config.instructions).toContain('walnut-inbox-triage');
  });

  it('files the run under the agent\'s own Ask project, not Ask Walnut', () => {
    expect(TRIAGE_PROJECT).toBe('Ask Inbox Triage');
  });

  it('is idempotent: a second enable (or a restart) creates nothing new', async () => {
    const layer = spyLayer();
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    const second = await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    expect(second.outcome).toBe('unchanged');
    expect(layer.createRoutine).toHaveBeenCalledTimes(1);
    expect(layer.patchRoutine).not.toHaveBeenCalled();
    expect(layer.jobs).toHaveLength(1);
  });

  it('recognises its own routine after the user renamed the card', async () => {
    const layer = spyLayer();
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    (layer.jobs[0] as any).name = 'My inbox robot';
    const again = await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    expect(again.outcome).toBe('unchanged');
    expect(layer.jobs).toHaveLength(1);
    // The rename survives: name and description are the user's.
    expect((layer.jobs[0] as any).name).toBe('My inbox robot');
  });

  it('adopts a routine that carries only the name (no marker yet)', async () => {
    const layer = spyLayer([{ id: 'legacy', name: 'Inbox Triage', enabled: true } as CronJob]);
    const res = await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    expect(res.outcome).toBe('patched');
    expect(res.jobId).toBe('legacy');
    expect(layer.createRoutine).not.toHaveBeenCalled();
  });
});

describe('disabling', () => {
  it('disables the routine and does NOT delete it', async () => {
    const layer = spyLayer();
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    const res = await ensureTriageRoutine({
      ...layer.deps, getConfig: cfg({ ...ON, enabled: false }),
    });
    expect(res.outcome).toBe('disabled');
    expect(layer.patchRoutine).toHaveBeenCalledWith(res.jobId, { enabled: false });
    expect(layer.jobs).toHaveLength(1);
    expect((layer.jobs[0] as any).enabled).toBe(false);
  });

  it('disabling twice patches once', async () => {
    const layer = spyLayer();
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    const off = cfg({ ...ON, enabled: false });
    await ensureTriageRoutine({ ...layer.deps, getConfig: off });
    const second = await ensureTriageRoutine({ ...layer.deps, getConfig: off });
    expect(second.outcome).toBe('already-disabled');
    expect(layer.patchRoutine).toHaveBeenCalledTimes(1);
  });

  it('stopTriage disables without reading the enabled flag from config', async () => {
    const layer = spyLayer();
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    const res = await stopTriage({ ...layer.deps, getConfig: cfg(ON) });
    expect(res.outcome).toBe('disabled');
    expect((layer.jobs[0] as any).enabled).toBe(false);
  });

  it('re-enabling brings the same routine back, never a second one', async () => {
    const layer = spyLayer();
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg({ ...ON, enabled: false }) });
    const back = await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    expect(back.outcome).toBe('patched');
    expect(layer.jobs).toHaveLength(1);
    expect((layer.jobs[0] as any).enabled).toBe(true);
  });
});

describe('two enables at once', () => {
  /**
   * Settings auto-saves per field, so flipping Enable and then editing the interval
   * sends two `PUT /api/config` and fires two `config:changed` in the same tick
   * (the boot path has the same shape: server.ts starts the watcher and then awaits
   * its own ensure). Before the reconcile was serialized, both runs read
   * listRoutines() before either wrote, both saw no routine, and each created one —
   * two tasks and two sessions per interval, and findTriageRoutine/stopTriage only
   * ever act on the first, so the second is invisible from Settings.
   *
   * The gate holds the READ open, which is where the interleaving lives: a lock
   * taken after listRoutines() would not fix anything.
   */
  function gatedLayer() {
    const layer = spyLayer();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const listRoutines = vi.fn(async () => { await gate; return layer.jobs; });
    return { layer, listRoutines, open: () => open(), deps: { ...layer.deps, listRoutines } };
  }

  it('creates exactly ONE routine, and the second caller sees the first one\'s', async () => {
    const { layer, listRoutines, open, deps } = gatedLayer();
    const both = Promise.all([
      ensureTriageRoutine({ ...deps, getConfig: cfg(ON) }),
      ensureTriageRoutine({ ...deps, getConfig: cfg(ON) }),
    ]);
    open();
    const [first, second] = await both;

    expect(layer.createRoutine).toHaveBeenCalledTimes(1);
    expect(layer.jobs).toHaveLength(1);
    expect([first.outcome, second.outcome]).toEqual(['created', 'unchanged']);
    // Both callers name the SAME routine, so Settings can still stop it.
    expect(second.jobId).toBe(first.jobId);
    // Serialized, not coalesced: the second caller re-reads and sees the write.
    expect(listRoutines).toHaveBeenCalledTimes(2);
  });

  it('five at once still create one (a settings page saving every field)', async () => {
    const { layer, open, deps } = gatedLayer();
    const all = Promise.all(Array.from({ length: 5 }, (_unused, i) => ensureTriageRoutine({
      ...deps, getConfig: cfg({ ...ON, every_messages: 20 + i }),
    })));
    open();
    const outcomes = (await all).map((r) => r.outcome);
    expect(layer.jobs).toHaveLength(1);
    expect(layer.createRoutine).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toBe('created');
    // The last write wins, and it is the same routine throughout.
    expect((layer.jobs[0] as any).wake.threshold).toBe(24);
  });

  it('a rejected reconcile does not poison the queue for the next caller', async () => {
    const layer = spyLayer();
    await expect(ensureTriageRoutine({
      ...layer.deps,
      getConfig: async () => { throw new Error('config.yaml is mid-write'); },
    })).rejects.toThrow('config.yaml is mid-write');
    const after = await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    expect(after.outcome).toBe('created');
    expect(layer.jobs).toHaveLength(1);
  });
});

describe('hot config changes', () => {
  it('re-patches the schedule when every changes', async () => {
    const layer = spyLayer();
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    const res = await ensureTriageRoutine({
      ...layer.deps, getConfig: cfg({ ...ON, every: '15m' }),
    });
    expect(res.outcome).toBe('patched');
    expect((layer.jobs[0] as any).schedule).toEqual({ kind: 'every', everyMs: 15 * 60_000 });
  });

  it('re-patches wake.threshold when every_messages changes', async () => {
    const layer = spyLayer();
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg({ ...ON, every_messages: 5 }) });
    expect((layer.jobs[0] as any).wake.threshold).toBe(5);
  });

  it('re-patches wake.events when sources change', async () => {
    const layer = spyLayer();
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg({ ...ON, sources: ['slack'] }) });
    expect((layer.jobs[0] as any).wake.events).toEqual(['plugin:slack:messages-received']);
  });

  it('removing every source CLEARS wake (and with it skipWhenIdle, so the clock still runs)', async () => {
    const layer = spyLayer();
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg(ON) });
    await ensureTriageRoutine({ ...layer.deps, getConfig: cfg({ ...ON, sources: [] }) });
    expect((layer.jobs[0] as any).wake).toBeUndefined();
  });

  it('a sub-floor interval is stored clamped, and re-reading it is then unchanged', async () => {
    const layer = spyLayer();
    const fast = cfg({ ...ON, every: '1m' });
    await ensureTriageRoutine({ ...layer.deps, getConfig: fast });
    expect((layer.jobs[0] as any).schedule.everyMs).toBe(5 * 60_000);
    const again = await ensureTriageRoutine({ ...layer.deps, getConfig: fast });
    expect(again.outcome).toBe('unchanged');
  });
});

describe('the console agent guard', () => {
  it('refuses to create a routine whose agent does not exist', async () => {
    const layer = spyLayer();
    const res = await ensureTriageRoutine({
      ...layer.deps, getConfig: cfg(ON), resolveAgent: async () => undefined,
    });
    expect(res.outcome).toBe('no-agent');
    expect(layer.createRoutine).not.toHaveBeenCalled();
  });

  it('the REAL registry resolves it, so the guard never fires in production', async () => {
    const { resolveAskAgent } = await import('../../src/core/sessions/ask-agent.js');
    const agent = await resolveAskAgent(TRIAGE_AGENT_ID);
    expect(agent).toEqual({ id: 'triage', name: 'Inbox Triage' });
  });
});

describe('the config watcher', () => {
  it('reacts to config:changed and cannot loop through a routine patch', async () => {
    const layer = spyLayer();
    let triage: TriageConfig | undefined;
    const watcher = startTriageConfigWatcher({
      ...layer.deps, getConfig: async () => (triage ? { triage } : {}),
    });
    try {
      triage = ON;
      bus.emit(EventNames.CONFIG_CHANGED, { config: { triage } }, ['web-ui'], { source: 'test' });
      await vi.waitFor(() => expect(layer.jobs).toHaveLength(1), { timeout: 5_000, interval: 25 });
      // The patch a reconcile performs emits cron events, never config:changed —
      // so a second reconcile is never triggered by the first one's write.
      const calls = layer.createRoutine.mock.calls.length;
      await new Promise((r) => setTimeout(r, 200));
      expect(layer.createRoutine.mock.calls.length).toBe(calls);
    } finally {
      watcher.stop();
    }
  });

  it('ignores the narrow UI-state emits (favorites/ordering) so they cost no store read', async () => {
    const layer = spyLayer();
    const listRoutines = vi.fn(async () => layer.jobs);
    const watcher = startTriageConfigWatcher({
      ...layer.deps, listRoutines, getConfig: cfg(ON),
    });
    try {
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'], { source: 'test' });
      await new Promise((r) => setTimeout(r, 150));
      expect(listRoutines).not.toHaveBeenCalled();
      expect(layer.createRoutine).not.toHaveBeenCalled();
    } finally {
      watcher.stop();
    }
  });

  it('stop() removes the subscriber', () => {
    const layer = spyLayer();
    const watcher = startTriageConfigWatcher({ ...layer.deps, getConfig: cfg(ON) });
    watcher.stop();
    bus.emit(EventNames.CONFIG_CHANGED, { config: { triage: ON } }, ['web-ui'], { source: 'test' });
    expect(layer.createRoutine).not.toHaveBeenCalled();
  });
});

describe('the shipped skill', () => {
  // Asserted against the file in the repo, not through /api/skills: every test
  // tier mocks BUILTIN_SKILLS_DIR to a temp directory, so the API cannot see it.
  const skillPath = 'src/data/skills/walnut-inbox-triage/SKILL.md';

  it('is under 2.5 KB — it rides the Personal AI\'s injected index on every lane turn', async () => {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(skillPath, 'utf-8');
    expect(Buffer.byteLength(raw, 'utf-8')).toBeLessThanOrEqual(2560);
  });

  it('declares a NARROW description, so it is not a general-purpose match', async () => {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(skillPath, 'utf-8');
    expect(raw.startsWith('---\n')).toBe(true);
    const front = raw.slice(4, raw.indexOf('\n---', 4));
    expect(front).toContain('name: walnut-inbox-triage');
    // It must say what it is NOT for; the `triage` skill (task triage) is the
    // nearest neighbour and the one it would otherwise steal queries from.
    expect(front).toContain('Not for');
    expect(front).toContain('`triage` skill');
  });

  it('names the memory layers the run must write', async () => {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(skillPath, 'utf-8');
    for (const needle of [
      'notes/Walnut/Triage/State.md',
      'notes/Walnut/Triage/Runs/',
      'notes/Projects/<P>/Tracking.md',
      'project_tracking_get',
      'mail_request_send',
      'slack_request_post',
      'mail_unsubscribe_request',
    ]) {
      expect(raw, needle).toContain(needle);
    }
  });
});

describe('the spec and the finder, as pure functions', () => {
  it('a sources-less config carries wake: null (clear), never a counter nobody feeds', () => {
    const spec = buildTriageRoutineSpec(readTriageConfig({ triage: { enabled: true, sources: [] } }));
    expect(spec.wake).toBeNull();
  });

  it('the finder prefers the action marker over the name', () => {
    const jobs = [
      { id: 'renamed', name: 'Whatever', initProcessor: { actionId: TRIAGE_ACTION_ID } },
      { id: 'impostor', name: 'Inbox Triage' },
    ] as CronJob[];
    expect(findTriageRoutine(jobs)?.id).toBe('renamed');
  });

  it('the finder ignores unrelated routines', () => {
    const jobs = [{ id: 'other', name: 'Daily report' }] as CronJob[];
    expect(findTriageRoutine(jobs)).toBeUndefined();
  });
});
