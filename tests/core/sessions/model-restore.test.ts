/**
 * A model Walnut's safeguard switch or an agent picked holds for one turn; after it the session is
 * back on its own model (2026-11-16: a lead moved a task's session from Opus 5.5 to Sonnet 5.5 after
 * the safeguards refused it, nothing moved it back, and the task woke on Sonnet three hours later).
 * A person's own pick is never undone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('model-restore'));
vi.mock('../../../src/utils/process.js', () => ({ isProcessAlive: () => false, isProcessAliveAsync: async () => false }));
vi.mock('../../../src/core/agents/host-engines.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/agents/host-engines.js')>()),
  hostEngineAvailability: async () => null,
}));
vi.mock('../../../src/core/sessions/task-start.js', () => ({
  startSessionForTask: async () => { throw new Error('a model change must never start a session'); },
}));

import { WALNUT_HOME } from '../../../src/constants.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { applySessionModelChange } from '../../../src/core/sessions/session-controls.js';
import {
  markTemporary, modelChoiceOf, restoreHeldBy, restoreTarget, startModelRestore, RESTORE_PAUSE_AFTER_SWITCHES,
} from '../../../src/core/sessions/model-restore.js';
import { startSafeguardSwitch } from '../../../src/core/sessions/safeguard-switch.js';
import type { ModelRow } from '../../../src/core/sessions/safeguard-stop.js';
import { beginQuietTurn, resetQuietTurnsForTest } from '../../../src/core/sessions/quiet-turn.js';
import type { SessionRecord } from '../../../src/core/types.js';

const SID = 'mr-session-1';
/** The menu a Bedrock host serves (GET /api/v1/sessions/:id/model-options, 2026-11-16). */
const MENU: ModelRow[] = [
  { id: 'default', label: 'Default', resolvedModel: 'global.anthropic.claude-opus-5-5' },
  { id: 'sonnet', label: 'Sonnet 5.5', resolvedModel: 'global.anthropic.claude-sonnet-5-5' },
  { id: 'global.anthropic.claude-fable-5-2[1m]', label: 'Fable', resolvedModel: 'global.anthropic.claude-fable-5-2' },
  { id: 'opus', label: 'Opus 5.5', resolvedModel: 'global.anthropic.claude-opus-5-5' },
];

let stops: Array<() => void> = [];
beforeEach(async () => {
  closeSessionDb(); _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await createSessionRecord(SID, 't-mr', 'Marina', '/work/repo');
  await updateSessionRecord(SID, { process_status: 'stopped' });
});
afterEach(async () => {
  for (const s of stops) s(); stops = [];
  resetQuietTurnsForTest();
  await new Promise((r) => setTimeout(r, 30));
  closeSessionDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

const rec = async () => (await getSessionByClaudeId(SID))!;
const until = async (done: () => Promise<boolean>, what: string) => {
  for (let i = 0; i < 300; i++) { if (await done()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${what}`);
};
const pause = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };
let gen = 0;
const result = (extra: Record<string, unknown> = {}) => bus.emit(EventNames.SESSION_RESULT, {
  sessionId: SID, taskId: 't-mr', turnGen: ++gen, result: 'done', isError: false, ...extra,
}, ['*'], { source: 'session-runner' });
/** A message reached the session (the queue's delivery). */
const took = () => bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: SID, messageIds: [`m-${gen}`] }, ['*'], { source: 'test' });
const refused = () => result({ result: "API Error: Opus 5.5's safeguards flagged this message", isError: true, safeguardStop: { category: 'reasoning_extraction' } });

describe('who picked a model', () => {
  it('a session, a script or job is an agent; a person, or an agent quoting the user, is a person', () => {
    expect(modelChoiceOf({ 'x-walnut-caller-sid': 'lead-sid' }, { model: 'sonnet' })).toBe('agent');
    expect(modelChoiceOf({ 'x-walnut-caller-kind': 'automation' }, { model: 'sonnet' })).toBe('agent');
    expect(modelChoiceOf({}, { model: 'sonnet' })).toBe('person');
    expect(modelChoiceOf({ 'x-walnut-caller-sid': 'lead-sid' }, { model: 'sonnet', user_words: 'switch that task to sonnet' })).toBe('person');
    expect(modelChoiceOf({ 'x-walnut-caller-sid': 'lead-sid' }, { model: 'sonnet', user_words: ' ' })).toBe('agent');
  });

  it('a chain of switches keeps the first model; a switch back to it leaves no mark', () => {
    const first = markTemporary({ cliModel: undefined, modelTemporary: null }, 'sonnet', 'agent', '2026-11-16T16:54:00Z')!;
    expect(first).toEqual({ from: null, to: 'sonnet', by: 'agent', at: '2026-11-16T16:54:00Z' });
    expect(restoreTarget(first)).toBe('default');
    const second = markTemporary({ cliModel: 'sonnet', modelTemporary: first }, 'fable', 'safeguard-switch', '2026-11-16T17:00:00Z')!;
    expect(second.from).toBeNull();
    expect(markTemporary({ cliModel: 'sonnet', modelTemporary: first }, 'default', 'agent', '2026-11-16T17:00:00Z')).toBeNull();
    // A model the user named at the start is the one it goes back to.
    expect(restoreTarget(markTemporary({ cliModel: 'sonnet' }, 'opus', 'safeguard-switch', '2026-11-16T17:00:00Z')!)).toBe('sonnet');
  });

  it('a session the safeguards keep refusing stays on its fallback for the day', () => {
    const now = Date.parse('2026-11-16T20:00:00Z');
    const base = { claudeSessionId: SID, modelTemporary: { from: null, to: 'sonnet', by: 'safeguard-switch', at: '2026-11-16T19:00:00Z' } } as SessionRecord;
    const switches = (n: number) => Array.from({ length: n }, (_, i) => ({ at: `2026-11-16T1${i}:00:00Z`, from: 'Opus 5.5', to: 'Fable', toId: 'fable', resent: 1 }));
    expect(restoreHeldBy({ ...base, safeguardSwitch: { streak: 0, switches: switches(RESTORE_PAUSE_AFTER_SWITCHES - 1) } }, now)).toBeNull();
    expect(restoreHeldBy({ ...base, safeguardSwitch: { streak: 0, switches: switches(RESTORE_PAUSE_AFTER_SWITCHES) } }, now)).toBe('switched-often');
    // An agent's switch always goes back.
    expect(restoreHeldBy({ ...base, modelTemporary: { ...base.modelTemporary!, by: 'agent' }, safeguardSwitch: { streak: 0, switches: switches(5) } }, now)).toBeNull();
  });
});

describe('a lead switches a session\'s model', () => {
  it('holds for one turn: the next clean turn puts the session back on its own model (Opus 5.5)', async () => {
    stops.push(startModelRestore().stop);
    await applySessionModelChange(SID, 'sonnet', { choice: 'agent' });
    expect((await rec()).cliModel).toBe('sonnet');
    expect((await rec()).modelTemporary).toMatchObject({ from: null, to: 'sonnet', by: 'agent' });
    // The turn that was already running when the lead switched took nothing after it: not its turn.
    result();
    await pause();
    expect((await rec()).cliModel).toBe('sonnet');
    // The lead's message reaches it. A refused or failed turn answered nothing: the switch still holds.
    took();
    refused();
    result({ isError: true });
    result({ interrupted: true });
    result({ teamActive: true });
    await pause();
    expect((await rec()).cliModel).toBe('sonnet');
    result();
    await until(async () => !(await rec()).modelTemporary, 'the switch back');
    expect((await rec()).cliModel).toBe('default');
    // The next turn starts on Opus 5.5 again and nothing switches it later.
    result();
    await pause();
    expect((await rec()).cliModel).toBe('default');
  });

  it('a quiet turn of Walnut\'s own (an idle compaction) is not the turn the switch was for', async () => {
    stops.push(startModelRestore().stop);
    await applySessionModelChange(SID, 'sonnet', { choice: 'agent' });
    took();
    beginQuietTurn(SID, 'idle-compact', 'idle-compact', Date.now());
    result();
    await pause();
    expect((await rec()).cliModel).toBe('sonnet');
  });

  it('a person\'s pick is the session\'s own: it clears the mark and nothing moves it back', async () => {
    stops.push(startModelRestore().stop);
    await applySessionModelChange(SID, 'sonnet', { choice: 'agent' });
    await applySessionModelChange(SID, 'global.anthropic.claude-fable-5-2[1m]', { choice: 'person' });
    expect((await rec()).modelTemporary ?? null).toBeNull();
    took();
    result();
    await pause();
    expect((await rec()).cliModel).toBe('global.anthropic.claude-fable-5-2[1m]');
  });

  it('a model the user named at the start is the one the session goes back to', async () => {
    await updateSessionRecord(SID, { cliModel: 'sonnet' });
    stops.push(startModelRestore().stop);
    await applySessionModelChange(SID, 'opus', { choice: 'agent' });
    took();
    result();
    await until(async () => !(await rec()).modelTemporary, 'the switch back');
    expect((await rec()).cliModel).toBe('sonnet');
  });
  it('a model moved elsewhere since (a /model typed in the session) is kept; only the mark goes', async () => {
    stops.push(startModelRestore().stop);
    await applySessionModelChange(SID, 'sonnet', { choice: 'agent' });
    // The CLI now answers on Fable although the record still says Sonnet.
    await updateSessionRecord(SID, { model: 'global.anthropic.claude-fable-5-2' });
    took(); result();
    await until(async () => !(await rec()).modelTemporary, 'the mark cleared');
    expect((await rec()).cliModel).toBe('sonnet');
    await applySessionModelChange(SID, 'sonnet', { choice: 'agent' });
    await updateSessionRecord(SID, { model: 'claude-sonnet-5-5', cliModel: 'haiku' });
    took(); result();
    await until(async () => !(await rec()).modelTemporary, 'the mark cleared');
    expect((await rec()).cliModel).toBe('haiku');
  });

  it('a switch back that does not take leaves the record on the model the CLI runs, and stops after a few tries', async () => {
    const kept: string[] = [];
    let record = { claudeSessionId: SID, taskId: 't-mr', cliModel: 'sonnet', modelTemporary: { from: null, to: 'sonnet', by: 'agent', at: new Date(Date.now() - 1000).toISOString() } } as SessionRecord;
    const h = startModelRestore({
      getSession: async () => record,
      applyModel: async () => false,
      keepModel: async (_id, m) => { kept.push(m); },
      clearMark: async () => { record = { ...record, modelTemporary: null }; },
      held: async () => false,
      emitNote: () => {},
    });
    stops.push(h.stop);
    h.instance.handleEvent({ name: EventNames.SESSION_MESSAGES_DELIVERED, data: { sessionId: SID, messageIds: ['x'] } } as never);
    expect(await h.instance.restore(SID)).toBe('not-applied');
    expect(await h.instance.restore(SID)).toBe('not-applied');
    expect(await h.instance.restore(SID)).toBe('gave-up');
    expect(kept).toEqual(['sonnet', 'sonnet', 'sonnet']);
    expect(record.modelTemporary).toBeNull();
  });
});

describe('the safeguard switch moves a session, then the next turn is on Opus 5.5 again', () => {
  it('Opus refused twice, Fable answers the resend, and the session is back on its default (Opus 5.5)', async () => {
    const sends: string[] = [];
    const sg = startSafeguardSwitch({
      getSession: async (id) => getSessionByClaudeId(id),
      saveSession: async (id, updates) => updateSessionRecord(id, updates),
      modelOptions: async () => ({ models: MENU, current: (await rec()).cliModel ?? 'default' }),
      applyModel: async (id, modelId) => { await applySessionModelChange(id, modelId, { remember: false }); return { rejected: false }; },
      send: async (_id, text) => { sends.push(text); },
      stopFence: async () => null,
      taskOpen: async () => true,
      deleteQueued: async () => true,
      emitNote: () => {},
      tellLead: async () => {},
      gaveUp: async () => {},
    });
    stops.push(sg.stop);
    stops.push(startModelRestore().stop);
    refused(); refused();
    await until(async () => sends.length === 1, 'the switch and its resend');
    expect((await rec()).cliModel).toBe('global.anthropic.claude-fable-5-2[1m]');
    expect((await rec()).modelTemporary).toMatchObject({ from: null, by: 'safeguard-switch' });
    expect(sends[0]).toContain('for this turn; Walnut moves you back after it');
    // Fable takes and answers the resend: that was its one turn.
    took();
    result();
    await until(async () => !(await rec()).modelTemporary, 'the switch back');
    expect((await rec()).cliModel).toBe('default');
  });
});

describe('every way a session\'s model changes says who picked it', () => {
  // A new caller that changes a running session's model without `choice` would leave an agent's pick
  // on the session for good (the 2026-11-16 bug's class). Walnut's own switches are listed by name.
  const WALNUT_OWN: Record<string, string> = {
    'src/core/sessions/safeguard-switch.ts': 'marks the one-turn model itself (markTemporary)',
    'src/core/sessions/model-restore.ts': 'the switch back to the session\'s own model',
  };
  it('each caller of applySessionModelChange passes `choice`, or is one of Walnut\'s own', async () => {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const files = execFileSync('git', ['grep', '-l', '--untracked', 'applySessionModelChange(', '--', 'src'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const seen: string[] = [];
    const missing: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (let at = text.indexOf('applySessionModelChange('); at >= 0; at = text.indexOf('applySessionModelChange(', at + 1)) {
        if (/function\s+$/.test(text.slice(Math.max(0, at - 20), at))) continue;
        // The call's arguments, to its matching parenthesis.
        let depth = 0, end = at + 'applySessionModelChange'.length;
        for (; end < text.length; end++) {
          if (text[end] === '(') depth++;
          else if (text[end] === ')' && --depth === 0) break;
        }
        const call = text.slice(at, end + 1);
        seen.push(file);
        if (!WALNUT_OWN[file] && !/\bchoice\b/.test(call)) missing.push(`${file}: ${call.replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
    // The web route, the v1 route and the relay are found (the scan itself works).
    expect(new Set(seen)).toEqual(new Set(['src/web/routes/sessions.ts', 'src/web/routes/session-control-v1.ts', 'src/core/sessions/session-controls.ts', ...Object.keys(WALNUT_OWN)]));
    expect(missing).toEqual([]);
  });
});
