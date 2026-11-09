/**
 * Regression lock: the orphan sweep must respect the socket dir's `.owner`
 * marker, and conditionalReap must not kill a terminal a client is viewing.
 *
 * Incident 2026-08-18 (recurrence of 2026-08-10): a second Walnut instance with
 * an isolated data dir (empty session registry) but an INHERITED production
 * WALNUT_DAEMON_DIR ran reapOrphanDtach over production's socket dir. Its kill
 * rule — "socket whose sessionId is absent from MY registry → kill" — then
 * classified every production terminal as an orphan and pkill'd them all,
 * including live ones on remote hosts. Deriving DTACH_SOCKET_DIR from LOG_DIR
 * (the 2026-08-10 fix) only isolates instances that override the runtime dir;
 * ownership must be checked against the REGISTRY identity (WALNUT_HOME), which
 * is what the `.owner` marker records.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WALNUT_HOME } from '../../../src/constants.js';

// Capture every shell script the lifecycle module runs; scripted responses per call.
const shellCalls: string[] = [];
let ownerResponse: string; // what `cat .owner` yields in the sweep's list call
let socketList: string[] = [];

vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const script = args[args.length - 1] ?? '';
    shellCalls.push(script);
    if (script.includes('RECSTART:')) {
      // The master probe: each socket has a verified master (pid record, same start
      // time, `<dtach> -A <socket>` argv), with an idle login shell under it.
      const sock = /'([^']*\/walnut-[A-Za-z0-9_-]+\.dsock)'/.exec(script)?.[1] ?? '';
      const table = script.includes('TABLE:') ? 'TABLE:\n4242 1 walnut-dtach\n4243 4242 -zsh\n' : '';
      cb(null, `REC:4242\nRECSTART:ps:Mon Nov  2 10:00:00 2026\nLSOF:yes\nOWNERS:4242\nPROC:4242\nSTART:ps:Mon Nov  2 10:00:00 2026\n`
        + `ARG:/x/bin/walnut-dtach\nARG:-A\nARG:${sock}\nARG:-z\nENDPROC\nSOCKET:yes\nPROBE:END\n${table}`, '');
    } else if (script.includes('OWNER:')) {
      const sockets = socketList.map((sid) => `/x/term/walnut-${sid}.dsock`).join('\n');
      cb(null, `OWNER:${ownerResponse}\n${sockets}\n`, '');
    } else if (script.includes('kill -TERM')) {
      cb(null, 'SIGNALLED:4242\nDONE\n', '');
    } else {
      cb(null, 'DONE\n', '');
    }
  },
}));

const liveSessionIds: string[] = [];
vi.mock('../../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => liveSessionIds.map((id) => ({ claudeSessionId: id }))),
}));

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ hosts: {} })),
}));

let viewing = false;
// Terminal keys (core/terminal-key.ts) a client is viewing, beside `viewing` (every key).
const viewingKeys = new Set<string>();
vi.mock('../../../src/web/terminal/terminal-manager.js', () => ({
  terminalManager: { isViewing: (key: string) => viewing || viewingKeys.has(key), liveSlots: () => [] },
}));

import { reapOrphanDtach, conditionalReap } from '../../../src/web/terminal/dtach-lifecycle.js';

// A signal goes only to the verified master pid, in the stop script.
const killsExecuted = () => shellCalls.filter((s) => s.includes('kill -TERM 4242')).length;
// The sockets the stops ran against, by terminal key.
const stoppedKeys = () => shellCalls
  .filter((s) => s.includes('kill -TERM 4242'))
  .map((s) => /walnut-([A-Za-z0-9_-]+)\.dsock/.exec(s)?.[1])
  .sort();

beforeEach(() => {
  shellCalls.length = 0;
  liveSessionIds.length = 0;
  socketList = ['orphan-sid-1', 'orphan-sid-2'];
  viewing = false;
  viewingKeys.clear();
});

describe('reapOrphanDtach ownership gate', () => {
  it('sweeps orphans when the .owner marker matches MY data dir', async () => {
    ownerResponse = WALNUT_HOME;
    await reapOrphanDtach();
    expect(killsExecuted()).toBe(2);
  });

  it('keeps registry-tracked sockets even when owner matches', async () => {
    ownerResponse = WALNUT_HOME;
    liveSessionIds.push('orphan-sid-1'); // actually live
    await reapOrphanDtach();
    expect(killsExecuted()).toBe(1);
    expect(shellCalls.some((s) => s.includes('orphan-sid-2'))).toBe(true);
    expect(shellCalls.filter((s) => s.includes('kill -TERM')).some((s) => s.includes('orphan-sid-1'))).toBe(false);
  });

  it('REFUSES to sweep a dir owned by another instance (the 2026-08-18 incident)', async () => {
    // The sweeping instance has an empty registry (liveSessionIds=[]) — under
    // the old code every socket below would be "an orphan" and get signalled.
    ownerResponse = '/some/other/instances/data-dir';
    await reapOrphanDtach();
    expect(killsExecuted()).toBe(0);
  });

  it('REFUSES to sweep an unclaimed dir (no marker → pre-upgrade sockets are unattributable)', async () => {
    ownerResponse = ''; // cat of a missing marker → empty
    await reapOrphanDtach();
    expect(killsExecuted()).toBe(0);
  });
});

describe('conditionalReap viewing guard', () => {
  it('keeps the dtach session while a client is actively viewing it', async () => {
    viewing = true;
    const result = await conditionalReap({ claudeSessionId: 'sid-viewed', host: undefined });
    expect(result).toBe('kept');
    expect(killsExecuted()).toBe(0);
  });

  it('still kills an idle, unviewed shell (task-completion cleanup unchanged)', async () => {
    viewing = false;
    const result = await conditionalReap({ claudeSessionId: 'sid-idle', host: undefined });
    expect(result).toBe('killed');
    expect(killsExecuted()).toBe(1);
  });
});

describe('several terminals per session (terminal keys)', () => {
  it('the orphan sweep reaps every terminal of a deleted session and none of a live one', async () => {
    ownerResponse = WALNUT_HOME;
    socketList = ['gone-sid', 'gone-sid__term2', 'gone-sid__term7', 'live-sid', 'live-sid__term3'];
    liveSessionIds.push('live-sid');
    await reapOrphanDtach();
    expect(stoppedKeys()).toEqual(['gone-sid', 'gone-sid__term2', 'gone-sid__term7']);
  });

  it('the orphan sweep keeps a deleted session\'s terminal a client is viewing', async () => {
    ownerResponse = WALNUT_HOME;
    socketList = ['gone-sid', 'gone-sid__term2'];
    viewingKeys.add('gone-sid__term2');
    await reapOrphanDtach();
    expect(stoppedKeys()).toEqual(['gone-sid']);
  });

  it('task completion reaps every idle terminal of the session, never another session\'s', async () => {
    ownerResponse = WALNUT_HOME;
    socketList = ['sid-idle__term2', 'sid-idle__term5', 'other-sid__term2'];
    const result = await conditionalReap({ claudeSessionId: 'sid-idle', host: undefined });
    expect(result).toBe('killed');
    expect(stoppedKeys()).toEqual(['sid-idle', 'sid-idle__term2', 'sid-idle__term5']);
  });

  it('task completion keeps the one terminal being viewed and still reaps the others', async () => {
    ownerResponse = WALNUT_HOME;
    socketList = ['sid-mixed', 'sid-mixed__term2'];
    viewingKeys.add('sid-mixed__term2');
    const result = await conditionalReap({ claudeSessionId: 'sid-mixed', host: undefined });
    expect(result).toBe('kept');
    expect(stoppedKeys()).toEqual(['sid-mixed']);
  });
});
