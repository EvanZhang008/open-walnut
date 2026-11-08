/**
 * A task has exactly one live session after any move or engine switch (replaced-session.ts).
 *
 * 2026-11-08: a deploy's daemon restart left a live CLI behind a record that said `stopped`. A
 * move later trusted that record twice: it did not wait for the CLI's turn, and it sent no stop
 * (the retire stopped the old session only when its record read live). The old CLI worked on
 * beside the new session and removed the new session's folder as a leftover of the move.
 *
 * Pinned here, from the source, so a new path fails:
 *  - every start that takes a task's work over from its session (`ownMove: true`) is made by the
 *    switch funnel (engine-switch.ts), and every entry that moves or switches a task goes through
 *    that funnel (requestEngineSwitch / runEngineSwitch);
 *  - the funnel's retire stops the old session through its owner (endReplacedSession), never
 *    gated on its record, and a switch or move waits on the owner's view of the turn (`owner`);
 *  - every file that marks a session replaced by another is listed with how its old CLI ends;
 * and, behaviourally, what endReplacedSession and ownerView answer for each owner reply.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const SRC = path.join(REPO, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(SRC).map((f) => ({ rel: path.relative(REPO, f), text: fs.readFileSync(f, 'utf8') }));
const grep = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.rel).sort();

describe('one live session after a move or switch: every path goes through the owner', () => {
  it('only the switch funnel starts a session that takes a task over from its old one (ownMove)', () => {
    expect(grep(/ownMove:\s*true/)).toEqual(['src/core/sessions/engine-switch.ts']);
  });

  it('every entry that moves or switches a task goes through the funnel', () => {
    // A new entry is fine as long as it calls the funnel; one that starts a session itself fails above.
    expect(grep(/\b(requestEngineSwitch|runEngineSwitch)\(/)).toEqual([
      'src/core/sessions/engine-switch-watch.ts',
      'src/core/sessions/engine-switch.ts',
      'src/core/sessions/task-start.ts',
      'src/web/routes/engine-switch-v1.ts',
      'src/web/routes/session-chat.ts',
      'src/web/routes/task-move-v1.ts',
    ]);
  });

  it("the funnel's retire stops the old session through its owner, never gated on its record", () => {
    const src = fs.readFileSync(path.join(SRC, 'core/sessions/engine-switch.ts'), 'utf8');
    const retire = src.slice(src.indexOf('const retire = async'), src.indexOf('let prepared:'));
    expect(retire).toContain('endReplacedSession(old');
    expect(retire).not.toMatch(/process_status/);
    expect(src).not.toMatch(/LIVE\.has\(old\.process_status\)/);
    // A switch or move judges the old session's turn by its owner too.
    expect(src).toMatch(/turnHold\(rec, \{ queue: true, owner: true \}\)/);
    const watch = fs.readFileSync(path.join(SRC, 'core/sessions/engine-switch-watch.ts'), 'utf8');
    expect(watch).toMatch(/owner: true,/);
  });

  // Each writer of a "replaced by another session" mark, with how its old CLI ends.
  const REPLACERS: Record<string, string> = {
    'src/core/sessions/engine-switch.ts': 'retire: endReplacedSession before the new session starts',
    'src/core/sessions/engine-switch-watch.ts': 'a restart mid-switch: endReplacedSession on the session it replaced',
    'src/core/sessions/engine-switch-resume.ts': 'runs after retire ended the old session; the resumed one is the same session id',
  };
  it('every file that marks a session replaced (engine_switched, supersededBy) is listed with how its old CLI ends', () => {
    // A write of the mark (a log line reading `record.supersededBy` is no write).
    const writers = grep(/archive_reason:\s*engineSwitchedReason\(|supersededBy:\s*(?!undefined\b)(?!record\.)[a-zA-Z]/);
    expect(writers).toEqual(Object.keys(REPLACERS).sort());
    for (const rel of writers) {
      if (rel.endsWith('engine-switch-resume.ts')) continue;
      expect(fs.readFileSync(path.join(REPO, rel), 'utf8'), rel).toContain('endReplacedSession(');
    }
  });

  it('task_transfer judges the source turn by its owner too', () => {
    const src = fs.readFileSync(path.join(SRC, 'core/transfer/transfer.ts'), 'utf8');
    expect(src).toMatch(/turnHold\(session, \{ queue: false, owner: true \}\)/);
    // A transfer that completes its source ends the source's CLI through its owner as well.
    expect(src).toMatch(/if \(sourceCompleted\) \{[\s\S]*?endReplacedSession\(session/);
  });
});

const term = vi.hoisted(() => ({ result: null as unknown, throws: null as Error | null, calls: [] as string[] }));
vi.mock('../../../src/core/sessions/session-lifecycle.js', () => ({
  terminateSession: async (sid: string) => {
    term.calls.push(sid);
    if (term.throws) throw term.throws;
    return term.result;
  },
}));
const stops = vi.hoisted(() => ({ withdrawn: [] as Array<[string, string]> }));
vi.mock('../../../src/core/sessions/session-stop.js', () => ({
  sessionStops: { withdraw: async (sid: string, id: string) => { stops.withdrawn.push([sid, id]); return true; } },
}));
const pool = vi.hoisted(() => ({ reply: null as unknown, probe: null as unknown }));
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getPooledSnapshotConnection: () => (pool.reply === undefined ? null : { send: async () => pool.reply }),
  probeDaemonSession: async () => pool.probe,
}));

import { endReplacedSession, ownerView, __setOwnerViewForTesting, ReplacedSessionLiveError } from '../../../src/core/sessions/replaced-session.js';

describe('endReplacedSession', () => {
  const rec = { claudeSessionId: 'old-sid', host: 'cloud' };
  beforeEach(() => { term.result = null; term.throws = null; term.calls.length = 0; });
  afterEach(() => { __setOwnerViewForTesting(null); });

  it('always asks the owner to stop it, and returns once that stop is confirmed', async () => {
    term.result = { status: 'terminated', sessionId: 'old-sid' };
    await expect(endReplacedSession(rec)).resolves.toEqual({ confirmed: true });
    expect(term.calls).toEqual(['old-sid']);
  });

  it('a lost host: the stop stands here and its host ends the CLI on return', async () => {
    term.result = { status: 'terminated', sessionId: 'old-sid', hostLost: { host: 'cloud', at: 'x' } };
    await expect(endReplacedSession(rec)).resolves.toEqual({ confirmed: true, hostLost: true });
  });

  it('a stop not confirmed while the owner says its CLI runs refuses the replacement, and withdraws that stop', async () => {
    stops.withdrawn.length = 0;
    term.result = { status: 'pending', sessionId: 'old-sid', stopRequest: { id: 'stop-1', requestedAt: 'x', state: 'pending' } };
    __setOwnerViewForTesting(async () => ({ alive: true, hold: 'idle' }));
    await expect(endReplacedSession(rec)).rejects.toBeInstanceOf(ReplacedSessionLiveError);
    // The task stays on that session: its stop must not end it later or hold its messages.
    expect(stops.withdrawn).toEqual([['old-sid', 'stop-1']]);
  });

  it('a stop not confirmed with no answer from the owner refuses too (it may still run)', async () => {
    term.throws = new Error('Session not found');
    __setOwnerViewForTesting(async () => null);
    await expect(endReplacedSession(rec)).rejects.toMatchObject({ code: 'old_session_live', message: expect.stringContaining('may still run') });
  });

  it('a stop not confirmed whose owner runs no CLI of it goes on', async () => {
    term.result = { status: 'pending', sessionId: 'old-sid' };
    __setOwnerViewForTesting(async () => ({ alive: false, hold: 'idle' }));
    await expect(endReplacedSession(rec)).resolves.toEqual({ confirmed: false });
  });
});

describe('ownerView reads the owning daemon, and an error answer is no answer', () => {
  const rec = { claudeSessionId: 'sid', host: 'cloud' };
  it.each([
    ['an error reply (a daemon shutting down)', { ok: false, error: 'Daemon is shutting down; retry after reconnecting' }, null],
    ['the daemon does not hold it', { ok: true, snapshotAvailable: false }, { alive: false, hold: 'idle' }],
    ['dead', { ok: true, exists: true, alive: false }, { alive: false, hold: 'idle' }],
    ['mid-turn', { ok: true, exists: true, alive: true, snapshot: { cliState: 'running' } }, { alive: true, hold: 'turn' }],
    ['a prompt waits on the person', { ok: true, exists: true, alive: true, snapshot: { cliState: 'waiting' } }, { alive: true, hold: 'turn' }],
    ['between turns, a detached command running', { ok: true, exists: true, alive: true, snapshot: { cliState: 'idle', detachedBgCount: 1 } }, { alive: true, hold: 'background' }],
    ['idle', { ok: true, exists: true, alive: true, snapshot: { cliState: 'idle' } }, { alive: true, hold: 'idle' }],
  ])('%s', async (_name, reply, want) => {
    pool.reply = reply;
    expect(await ownerView(rec)).toEqual(want);
  });

  it('a daemon without snapshots answers liveness only; no answer is null', async () => {
    pool.reply = undefined;
    pool.probe = { alive: true };
    expect(await ownerView(rec)).toEqual({ alive: true, hold: 'idle' });
    pool.probe = null;
    expect(await ownerView(rec)).toBeNull();
  });

  it('an ACP engine is asked another way (terminate stops its worker): no view here', async () => {
    pool.reply = { ok: true, exists: true, alive: true };
    expect(await ownerView({ ...rec, engine: 'codex' })).toBeNull();
  });
});
