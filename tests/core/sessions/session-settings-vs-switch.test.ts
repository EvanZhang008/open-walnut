/**
 * A session's settings (model, effort, permission mode, an ACP engine's controls) and a pending
 * engine switch or move are two separate actions: changing one never cancels, restarts or rewrites
 * the other (2026-11-15: the user changed a task's model to Opus while a move the Walnut VP queued
 * waited, read the move's line as the result of their own click, and the move ended cancelled).
 *
 * The guard runs every session-setting change Walnut offers over a task with a switch waiting, and
 * fails when one of them touches it. It also fails when a new setting change is added to
 * session-controls.ts or session-extras.ts and not to the matrix below, so a new member of the
 * class is checked too.
 *
 * The reverse: a switch keeps the settings picked in the session while it waited (keptSettings).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('session-settings-vs-switch'));
vi.mock('../../../src/utils/process.js', () => ({ isProcessAlive: () => true, isProcessAliveAsync: async () => true }));
vi.mock('../../../src/core/agents/host-engines.js', () => ({ hostEngineAvailability: async () => null }));
vi.mock('../../../src/core/config-manager.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/config-manager.js')>();
  return { ...real, getConfig: async () => ({ ...(await real.getConfig()), hosts: { cloud: { hostname: 'cloud', enabled: true } } }) };
});
vi.mock('../../../src/core/sessions/task-start.js', () => ({
  startSessionForTask: async () => { throw new Error('a setting change must never start a session'); },
}));

import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask, getTask, _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { requestEngineSwitch, keptSettings } from '../../../src/core/sessions/engine-switch.js';
import { mutateStore } from '../../../src/core/session-queue-store.js';
import { _resetHostModelCatalogCache } from '../../../src/core/host-model-catalog.js';
import * as controls from '../../../src/core/sessions/session-controls.js';
import * as extras from '../../../src/core/sessions/session-extras.js';
import { patchSession } from '../../../src/core/sessions/session-lifecycle.js';
import type { EngineSwitchState } from '../../../src/core/types.js';

/**
 * Every setting change of a session, as the picker, the phone and the API make it. A new one
 * (an `apply...` export of session-controls.ts or session-extras.ts) goes here, or the
 * completeness test below fails.
 */
const SETTING_CHANGES: Record<string, (sid: string) => Promise<unknown>> = {
  applySessionModelChange: (sid) => controls.applySessionModelChange(sid, 'opus'),
  applySessionEffortChange: (sid) => controls.applySessionEffortChange(sid, 'high'),
  applySessionControl: (sid) => extras.applySessionControl(sid, 'mode', 'plan'),
  patchSession: (sid) => patchSession(sid, { mode: 'plan' }),
};

beforeEach(async () => {
  closeTaskDb(); closeSessionDb(); _resetForTesting(); _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await mutateStore((st) => { st.queues = {}; }, false, true);
  _resetHostModelCatalogCache();
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 30));
  closeTaskDb(); closeSessionDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

/** A task whose session (Claude Code, or an ACP engine's) is in a turn, with a lead task that asks for the switch. */
async function busyTask(engine: 'claude' | 'codex' = 'claude'): Promise<{ taskId: string; sid: string; leadSid: string }> {
  const { task: lead } = await addTask({ title: 'Walnut VP', project: 'Marina', cwd: '/work/repo' } as never);
  const leadSid = 'lead-sid';
  await createSessionRecord(leadSid, lead.id, 'Marina', '/work/repo');
  const { task } = await addTask({ title: 'Drawing app plugin', project: 'Marina', cwd: '/work/repo' } as never);
  const sid = 'worker-sid';
  await createSessionRecord(sid, task.id, 'Marina', '/work/repo');
  await updateSessionRecord(sid, {
    process_status: 'running', messageCount: 4,
    ...(engine === 'claude' ? { cliModel: 'sonnet' } : { engine, acpModel: 'gpt-5.5' }),
  } as never);
  return { taskId: task.id, sid, leadSid };
}

const PENDING: Array<{ name: string; engine: 'claude' | 'codex'; ask: (t: { taskId: string; leadSid: string }) => Promise<unknown> }> = [
  {
    name: 'a move to another host',
    engine: 'claude',
    ask: ({ taskId, leadSid }) => requestEngineSwitch({
      taskId, engine: 'claude', host: 'cloud', message: 'Carry on.', reason: 'to run browser tests', source: 'api-agent', callerSid: leadSid,
    }),
  },
  {
    name: 'an engine switch',
    engine: 'claude',
    ask: ({ taskId, leadSid }) => requestEngineSwitch({ taskId, engine: 'codex', message: 'Carry on.', source: 'api-agent', callerSid: leadSid }),
  },
  {
    name: 'an ACP session\'s move',
    engine: 'codex',
    ask: ({ taskId, leadSid }) => requestEngineSwitch({ taskId, engine: 'codex', host: 'cloud', message: 'Carry on.', source: 'api-agent', callerSid: leadSid }),
  },
];

describe('a session-setting change never touches a pending switch', () => {
  it('covers every setting change session-controls.ts and session-extras.ts export', () => {
    const offered = [...Object.entries(controls), ...Object.entries(extras)]
      .filter(([name, value]) => /^apply[A-Z]\w*$/.test(name) && typeof value === 'function').map(([name]) => name);
    expect(offered.length).toBeGreaterThan(0);
    for (const name of offered) expect(SETTING_CHANGES, `${name} is a session-setting change: add it to SETTING_CHANGES`).toHaveProperty(name);
  });

  for (const pending of PENDING) {
    for (const [change, run] of Object.entries(SETTING_CHANGES)) {
      it(`${change} leaves ${pending.name} exactly as it was`, async () => {
        const t = await busyTask(pending.engine);
        const res = await pending.ask(t) as { state: string };
        expect(res.state).toBe('pending');
        const before = structuredClone((await getTask(t.taskId)).engine_switch) as EngineSwitchState;
        expect(before.state).toBe('pending');
        // Whether the change applies (no live CLI here) is not this test's question: only that the
        // switch is untouched, either way. Each change awaits its own writes before it answers.
        await run(t.sid).catch(() => {});
        expect((await getTask(t.taskId)).engine_switch).toEqual(before);
        // The session is still the task's, in its turn: nothing restarted it.
        expect(await getSessionByClaudeId(t.sid)).toMatchObject({ process_status: 'running' });
      });
    }
  }

  it('a pending move says who asked for it and why', async () => {
    const t = await busyTask();
    await PENDING[0].ask(t);
    expect((await getTask(t.taskId)).engine_switch).toMatchObject({
      state: 'pending', move: true, by_name: 'Walnut VP', reason: 'to run browser tests',
    });
  });

  it('nothing outside the engine-switch modules writes a task\'s engine_switch or cancels one', () => {
    const root = path.resolve(__dirname, '../../../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk(root);
    const writers: string[] = [];
    const cancellers: string[] = [];
    for (const f of files) {
      const rel = path.relative(root, f);
      const text = fs.readFileSync(f, 'utf8');
      // A key (`engine_switch: x`), a shorthand (`{ engine_switch }`) or an assignment (`.engine_switch = x`).
      const writes = /\bengine_switch\s*:|[{,]\s*engine_switch\s*[,}]|\.engine_switch\s*=[^=]|\[\s*['"]engine_switch['"]\s*\]\s*=[^=]/.test(text);
      if (rel !== 'core/types.ts' && writes && !/^core\/sessions\/engine-switch[\w-]*\.ts$/.test(rel)) writers.push(rel);
      if (/\bcancelPendingSwitch\b/.test(text) && rel !== 'core/sessions/engine-switch.ts') cancellers.push(rel);
    }
    expect(writers).toEqual([]);
    // The one way to cancel: the switch line's own Cancel (DELETE /tasks/:id/switch-engine).
    expect(cancellers).toEqual(['web/routes/engine-switch-v1.ts']);
  });

  it('the web calls the cancel only from the switch line\'s own buttons', () => {
    const root = path.resolve(__dirname, '../../../web/src');
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          const text = fs.readFileSync(p, 'utf8');
          // A call of the client, or a request of its own to the route.
          if (/\bcancelEngineSwitch\s*\(|switch-engine/.test(text)) callers.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(callers.sort()).toEqual(['api/engine-switch.ts', 'components/sessions/EngineSwitch.tsx']);
  });
});

describe('a switch keeps the settings picked in the session while it waited', () => {
  const pendingMove = { to: { engine: 'claude' as const, host: 'cloud' } };
  it('a move on the same engine starts with the session\'s current model and effort', async () => {
    expect(await keptSettings({ engine: undefined, cliModel: 'opus', effort: 'xhigh' }, pendingMove, 'claude', 'cloud')).toEqual({ model: 'opus', effort: 'xhigh' });
  });
  it('the switch\'s own model wins, and the old effort never rides on it', async () => {
    expect(await keptSettings({ cliModel: 'opus', effort: 'max' }, { to: { engine: 'claude', model: 'haiku' } }, 'claude', 'cloud')).toEqual({ model: 'haiku' });
    expect(await keptSettings({ cliModel: 'opus', effort: 'xhigh' }, { to: { engine: 'claude', model: 'sonnet', effort: 'low' } }, 'claude', 'cloud')).toEqual({ model: 'sonnet', effort: 'low' });
  });
  it('another engine has models of its own: nothing carries', async () => {
    expect(await keptSettings({ cliModel: 'opus', effort: 'xhigh' }, { to: { engine: 'codex' } }, 'codex', 'cloud')).toEqual({});
  });
  it('an id the target host does not list goes as its family\'s alias, without its effort', async () => {
    expect(await keptSettings({ cliModel: 'global.anthropic.claude-opus-5-5', effort: 'xhigh' }, pendingMove, 'claude', 'cloud')).toEqual({ model: 'opus' });
    expect(await keptSettings({ cliModel: 'global.anthropic.claude-fable-5[1m]' }, pendingMove, 'claude', 'cloud')).toEqual({ model: 'fable[1m]' });
  });
  it('an id the target host lists goes as it is, with its effort', async () => {
    const { saveHostModelCatalog } = await import('../../../src/core/host-model-catalog.js');
    await saveHostModelCatalog('cloud', [{ value: 'global.anthropic.claude-opus-5-5', resolvedModel: 'global.anthropic.claude-opus-5-5', displayName: 'Opus' }] as never);
    expect(await keptSettings({ cliModel: 'global.anthropic.claude-opus-5-5', effort: 'xhigh' }, pendingMove, 'claude', 'cloud'))
      .toEqual({ model: 'global.anthropic.claude-opus-5-5', effort: 'xhigh' });
  });
  it('a model of no known family, the default, or one the launch would refuse stays behind', async () => {
    expect(await keptSettings({ cliModel: 'converse/global.openai.gpt-6.1-sol', effort: 'high' }, pendingMove, 'claude', 'cloud')).toEqual({});
    expect(await keptSettings({ cliModel: 'default' }, pendingMove, 'claude', 'cloud')).toEqual({});
    expect(await keptSettings({ cliModel: 'not a model at all' }, pendingMove, 'claude', 'cloud')).toEqual({});
  });
});
