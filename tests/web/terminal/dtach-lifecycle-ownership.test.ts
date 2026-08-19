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
    if (script.includes('OWNER:')) {
      const sockets = socketList.map((sid) => `/x/term/walnut-${sid}.dsock`).join('\n');
      cb(null, `OWNER:${ownerResponse}\n${sockets}\n`, '');
    } else if (script.includes('MASTERPID:')) {
      cb(null, 'MASTERPID:\n', ''); // no dtach master → hasForegroundProcess=false
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
vi.mock('../../../src/web/terminal/terminal-manager.js', () => ({
  terminalManager: { isViewing: () => viewing },
}));

import { reapOrphanDtach, conditionalReap } from '../../../src/web/terminal/dtach-lifecycle.js';

const killsExecuted = () => shellCalls.filter((s) => s.includes('pkill')).length;

beforeEach(() => {
  shellCalls.length = 0;
  liveSessionIds.length = 0;
  socketList = ['orphan-sid-1', 'orphan-sid-2'];
  viewing = false;
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
    expect(shellCalls.filter((s) => s.includes('pkill')).some((s) => s.includes('orphan-sid-1'))).toBe(false);
  });

  it('REFUSES to sweep a dir owned by another instance (the 2026-08-18 incident)', async () => {
    // The sweeping instance has an empty registry (liveSessionIds=[]) — under
    // the old code every socket below would be "an orphan" and get pkill'd.
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
