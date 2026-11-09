import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────
// Fake IPty: records writes/resizes, lets the test drive onData/onExit.
interface FakePty {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  _emitData: (s: string) => void;
  _emitExit: (code: number, signal?: number) => void;
}

function makeFakePty(): FakePty {
  let dataCb: (s: string) => void = () => {};
  let exitCb: (e: { exitCode: number; signal?: number }) => void = () => {};
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb: (s: string) => void) => { dataCb = cb; },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { exitCb = cb; },
    _emitData: (s: string) => dataCb(s),
    _emitExit: (code: number, signal?: number) => exitCb({ exitCode: code, signal }),
  } as unknown as FakePty;
}

let currentPty: FakePty;

// Capture sendToClient calls (terminal:data:<id> events).
const sentEvents: { name: string; data: unknown; ws?: unknown }[] = [];
vi.mock('../../../src/web/ws/handler.js', () => ({
  sendToClient: (ws: unknown, name: string, data: unknown) => { sentEvents.push({ name, data, ws }); },
}));

// Stub the session record lookup — local session with a cwd.
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(async (sid: string) => ({
    claudeSessionId: sid,
    cwd: '/home/u/proj',
    host: undefined,
  })),
}));

// resolveSpawnForSession returns our fake pty.
vi.mock('../../../src/web/terminal/spawn.js', () => ({
  resolveSpawnForSession: vi.fn(async () => ({ pty: currentPty, cwd: '/home/u/proj', host: undefined })),
  // Fake path only — this mock never touches disk. Deliberately NOT the real
  // socket dir: a prod-looking literal here would read as an assertion about
  // where sockets live (they now follow LOG_DIR — see src/constants.ts).
  dtachSocketPath: (sid: string) => `/tmp/walnut-fake-term/walnut-${sid}.dsock`,
}));

import { terminalManager } from '../../../src/web/terminal/terminal-manager.js';

const fakeWs = { readyState: 1 } as unknown as import('ws').WebSocket;

beforeEach(async () => {
  sentEvents.length = 0;
  currentPty = makeFakePty();
  // Reset singleton state between tests by killing everything.
  terminalManager.shutdown();
  const { resolveSpawnForSession } = await import('../../../src/web/terminal/spawn.js');
  (resolveSpawnForSession as ReturnType<typeof vi.fn>).mockClear();
});

describe('TerminalManager.open', () => {
  it('spawns a pty and returns terminalId == sessionId', async () => {
    const res = await terminalManager.open('sess-1', fakeWs, 80, 24);
    expect(res.terminalId).toBe('sess-1');
    expect(res.cols).toBe(80);
    expect(res.rows).toBe(24);
  });

  it('reuses the same terminal when reopened for the same session (attach, no respawn)', async () => {
    const { resolveSpawnForSession } = await import('../../../src/web/terminal/spawn.js');
    await terminalManager.open('sess-2', fakeWs, 80, 24);
    await terminalManager.open('sess-2', fakeWs, 80, 24);
    expect(resolveSpawnForSession).toHaveBeenCalledTimes(1);
  });
});

describe('several terminals per session (slots)', () => {
  it('each slot is its own pty and key; slot 1 keeps the session id', async () => {
    const { resolveSpawnForSession } = await import('../../../src/web/terminal/spawn.js');
    const ptys: FakePty[] = [];
    (resolveSpawnForSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const p = makeFakePty();
      ptys.push(p);
      return { pty: p, cwd: '/home/u/proj', host: undefined };
    });
    try {
      const a = await terminalManager.open('sess-m', fakeWs, 80, 24);
      const b = await terminalManager.open('sess-m', fakeWs, 80, 24, undefined, 2);
      const c = await terminalManager.open('sess-m', fakeWs, 80, 24, undefined, 3);
      expect([a.terminalId, b.terminalId, c.terminalId]).toEqual(['sess-m', 'sess-m__term2', 'sess-m__term3']);
      expect(resolveSpawnForSession).toHaveBeenCalledTimes(3);
      expect((resolveSpawnForSession as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[3]?.terminalKey)).toEqual(['sess-m', 'sess-m__term2', 'sess-m__term3']);
      expect(terminalManager.liveSlots('sess-m').map((t) => t.slot)).toEqual([1, 2, 3]);
      expect(terminalManager.listActive().filter((t) => t.sessionId === 'sess-m').map((t) => t.terminalKey).sort()).toEqual(['sess-m', 'sess-m__term2', 'sess-m__term3']);

      // Output and input stay with their own terminal.
      ptys[1]!._emitData('two');
      expect(sentEvents.at(-1)).toMatchObject({ name: 'terminal:data:sess-m__term2', data: { data: 'two' } });
      terminalManager.input('sess-m__term3', 'ls\r');
      expect(ptys[2]!.write).toHaveBeenCalledWith('ls\r');
      expect(ptys[0]!.write).not.toHaveBeenCalled();

      // Reopening a slot reattaches it; ending one leaves the others.
      await terminalManager.open('sess-m', fakeWs, 80, 24, undefined, 2);
      expect(resolveSpawnForSession).toHaveBeenCalledTimes(3);
      terminalManager.end('sess-m__term2');
      expect(terminalManager.liveSlots('sess-m').map((t) => t.slot)).toEqual([1, 3]);
      expect(terminalManager.isViewing('sess-m')).toBe(true);
      expect(terminalManager.isViewing('sess-m__term2')).toBe(false);
    } finally {
      (resolveSpawnForSession as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ pty: currentPty, cwd: '/home/u/proj', host: undefined }));
    }
  });

  it('a double open of the same slot spawns one pty', async () => {
    const { resolveSpawnForSession } = await import('../../../src/web/terminal/spawn.js');
    await Promise.all([
      terminalManager.open('sess-d', fakeWs, 80, 24, undefined, 4),
      terminalManager.open('sess-d', fakeWs, 80, 24, undefined, 4),
    ]);
    expect(resolveSpawnForSession).toHaveBeenCalledTimes(1);
  });

  it('refuses a slot out of range', async () => {
    await expect(terminalManager.open('sess-x', fakeWs, 80, 24, undefined, 9)).rejects.toThrow(/slot/);
  });
});

describe('several windows viewing one terminal', () => {
  const otherWs = { readyState: 1, other: true } as unknown as import('ws').WebSocket;

  it('every window gets the output; one leaving keeps the others live', async () => {
    await terminalManager.open('sess-w', fakeWs, 80, 24, undefined, 3);
    currentPty._emitData('early ');
    sentEvents.length = 0;
    await terminalManager.open('sess-w', otherWs, 100, 30, undefined, 3);
    // The second window gets the backlog; the first is not sent it again.
    expect(sentEvents).toEqual([{ name: 'terminal:data:sess-w__term3', data: { data: 'early ' }, ws: otherWs }]);
    sentEvents.length = 0;
    currentPty._emitData('both');
    expect(sentEvents.map((e) => e.ws)).toEqual([fakeWs, otherWs]);
    terminalManager.close('sess-w__term3', fakeWs);
    expect(terminalManager.isViewing('sess-w__term3')).toBe(true);
    sentEvents.length = 0;
    currentPty._emitData('still');
    expect(sentEvents.map((e) => e.ws)).toEqual([otherWs]);
    terminalManager.onClientDisconnect(otherWs);
    expect(terminalManager.isViewing('sess-w__term3')).toBe(false);
    expect(currentPty.kill).not.toHaveBeenCalled(); // grace period, dtach kept
  });

  it('an End from one window tells the other windows it exited, never the one that ended it', async () => {
    await terminalManager.open('sess-e', fakeWs, 80, 24, undefined, 2);
    await terminalManager.open('sess-e', otherWs, 80, 24, undefined, 2);
    sentEvents.length = 0;
    terminalManager.end('sess-e__term2', fakeWs);
    expect(sentEvents).toEqual([{ name: 'terminal:exit:sess-e__term2', data: { exitCode: 0, signal: null, ended: true, endedElsewhere: true }, ws: otherWs }]);
    expect(currentPty.kill).toHaveBeenCalled();
  });

  it('an end asked by a socket with no view of it (a tool, an agent) or by the server is not "another window"', async () => {
    const tool = { readyState: 1, tool: true } as unknown as import('ws').WebSocket;
    await terminalManager.open('sess-k', fakeWs, 80, 24, undefined, 2);
    sentEvents.length = 0;
    terminalManager.end('sess-k__term2', tool);
    expect(sentEvents).toEqual([{ name: 'terminal:exit:sess-k__term2', data: { exitCode: 0, signal: null, ended: true, endedElsewhere: false }, ws: fakeWs }]);
    await terminalManager.open('sess-k', fakeWs, 80, 24, undefined, 3);
    sentEvents.length = 0;
    terminalManager.end('sess-k__term3');
    expect(sentEvents).toEqual([{ name: 'terminal:exit:sess-k__term3', data: { exitCode: 0, signal: null, ended: true, endedElsewhere: false }, ws: fakeWs }]);
  });
});

describe('windows opening one terminal at the same moment', () => {
  const otherWs = { readyState: 1, other: true } as unknown as import('ws').WebSocket;

  it('the second open, joined to the first, views the terminal too', async () => {
    const { resolveSpawnForSession } = await import('../../../src/web/terminal/spawn.js');
    let release!: () => void;
    (resolveSpawnForSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ pty: currentPty, cwd: '/home/u/proj', host: undefined });
    }));
    const a = terminalManager.open('sess-j', fakeWs, 80, 24, undefined, 2);
    const b = terminalManager.open('sess-j', otherWs, 80, 24, undefined, 2);
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect((await a).terminalId).toBe((await b).terminalId);
    expect(resolveSpawnForSession).toHaveBeenCalledTimes(1);
    sentEvents.length = 0;
    currentPty._emitData('to both');
    expect(sentEvents.map((e) => e.ws)).toEqual([fakeWs, otherWs]);
  });

  it('a socket that closed while the shell spawned is let go (the grace timer runs)', async () => {
    const closed = { readyState: 3 } as unknown as import('ws').WebSocket;
    await terminalManager.open('sess-c', closed, 80, 24, undefined, 2);
    expect(terminalManager.isViewing('sess-c__term2')).toBe(false);
  });

  it('a plain shell replaced by a persistent one tells its other windows it ended', async () => {
    const plain = { persistent: false } as unknown as import('../../../src/web/terminal/dtach-check.js').TerminalMode;
    await terminalManager.open('sess-u', fakeWs, 80, 24, plain, 2);
    await terminalManager.open('sess-u', otherWs, 80, 24, plain, 2);
    const old = currentPty;
    currentPty = makeFakePty();
    sentEvents.length = 0;
    await terminalManager.open('sess-u', fakeWs, 80, 24, undefined, 2);
    expect(sentEvents.filter((e) => e.name === 'terminal:exit:sess-u__term2')).toEqual([
      { name: 'terminal:exit:sess-u__term2', data: { exitCode: 0, signal: null, ended: true, endedElsewhere: true }, ws: otherWs },
    ]);
    expect(old.kill).toHaveBeenCalled();
  });
});

describe('reserving a slot for a new terminal', () => {
  it('two windows asking at once get two different slots', () => {
    const a = terminalManager.reserveSlot('sess-r', [1, 2, 3], [1, 2, 3], 1_000);
    const b = terminalManager.reserveSlot('sess-r', [1, 2, 3], [1, 2, 3], 1_001);
    expect([a, b]).toEqual([4, 5]);
  });

  it('skips live terminals, host sockets and the window\'s own slots; a reservation lapses or is taken by its open', async () => {
    await terminalManager.open('sess-q', fakeWs, 80, 24, undefined, 1);
    expect(terminalManager.reserveSlot('sess-q', [], [2], 0)).toBe(3);
    expect(terminalManager.reserveSlot('sess-q', [4], [2], 1)).toBe(5);
    // A minute later the unopened reservations are free again.
    expect(terminalManager.reserveSlot('sess-q', [], [2], 120_000)).toBe(3);
    currentPty = makeFakePty();
    await terminalManager.open('sess-q', fakeWs, 80, 24, undefined, 3);
    expect(terminalManager.reserveSlot('sess-q', [], [2], 120_001)).toBe(4);
  });

  it('never hands out a slot whose open is still on the way (spawning over ssh)', async () => {
    const { resolveSpawnForSession } = await import('../../../src/web/terminal/spawn.js');
    let release!: () => void;
    (resolveSpawnForSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ pty: currentPty, cwd: '/home/u/proj', host: undefined });
    }));
    expect(terminalManager.reserveSlot('sess-o', [1], [1], 0)).toBe(2);
    const opening = terminalManager.open('sess-o', fakeWs, 80, 24, undefined, 2);
    await new Promise((r) => setTimeout(r, 0));
    // A minute later the reservation lapsed, but the open still runs: slot 2 stays taken.
    expect(terminalManager.reserveSlot('sess-o', [1], [1], 120_000)).toBe(3);
    release();
    await opening;
    expect(terminalManager.reserveSlot('sess-o', [1], [1], 120_001)).toBe(4);
  });

  it('answers null when every slot is taken', () => {
    expect(terminalManager.reserveSlot('sess-full', [1, 2, 3, 4, 5, 6, 7, 8], [], 0)).toBeNull();
  });
});

describe('output piping + scrollback', () => {
  it('forwards pty output to the attached client as terminal:data:<id>', async () => {
    await terminalManager.open('sess-3', fakeWs, 80, 24);
    currentPty._emitData('hello');
    const dataEvents = sentEvents.filter(e => e.name === 'terminal:data:sess-3');
    expect(dataEvents.length).toBeGreaterThanOrEqual(1);
    expect((dataEvents.at(-1)!.data as { data: string }).data).toBe('hello');
  });

  it("drops dtach's own end line from a persistent shell's output", async () => {
    await terminalManager.open('sess-eof', fakeWs, 80, 24);
    sentEvents.length = 0;
    currentPty._emitData('logout\r\n\x1b[999H\r\n[EOF - dtach terminating]\r\n');
    currentPty._emitData('[EOF - dtach terminating]\r\n');
    expect(sentEvents.map((e) => (e.data as { data: string }).data)).toEqual(['logout\r\n']);
  });

  it('replays scrollback on attach (reconnect)', async () => {
    await terminalManager.open('sess-4', fakeWs, 80, 24);
    currentPty._emitData('line-A');
    sentEvents.length = 0;
    // Simulate reconnect: attach a new ws to the same live terminal.
    const ws2 = { readyState: 1 } as unknown as import('ws').WebSocket;
    const ok = terminalManager.attach('sess-4', ws2, 80, 24);
    expect(ok).toBe(true);
    const replay = sentEvents.find(e => e.name === 'terminal:data:sess-4');
    expect(replay).toBeDefined();
    expect((replay!.data as { data: string }).data).toContain('line-A');
  });

  it('attach returns false for an unknown terminal (server restart → reopen path)', () => {
    expect(terminalManager.attach('does-not-exist', fakeWs, 80, 24)).toBe(false);
  });
});

describe('input + resize', () => {
  it('writes input to the pty', async () => {
    await terminalManager.open('sess-5', fakeWs, 80, 24);
    terminalManager.input('sess-5', 'ls\n');
    expect(currentPty.write).toHaveBeenCalledWith('ls\n');
  });

  it('resizes the pty', async () => {
    await terminalManager.open('sess-6', fakeWs, 80, 24);
    terminalManager.resize('sess-6', 120, 40);
    expect(currentPty.resize).toHaveBeenCalledWith(120, 40);
  });
});

describe('disconnect → detach keeps pty alive (no kill)', () => {
  it('does NOT kill the pty when the client disconnects (grace period)', async () => {
    await terminalManager.open('sess-7', fakeWs, 80, 24);
    terminalManager.onClientDisconnect(fakeWs);
    expect(currentPty.kill).not.toHaveBeenCalled();
  });

  it('close() only detaches — pty stays alive (dtach kept)', async () => {
    await terminalManager.open('sess-8', fakeWs, 80, 24);
    terminalManager.close('sess-8', fakeWs);
    expect(currentPty.kill).not.toHaveBeenCalled();
  });
});

describe('pty exit', () => {
  it('emits terminal:exit:<id> and forgets the terminal', async () => {
    await terminalManager.open('sess-9', fakeWs, 80, 24);
    currentPty._emitExit(0);
    const exitEvent = sentEvents.find(e => e.name === 'terminal:exit:sess-9');
    expect(exitEvent).toBeDefined();
    // After exit, reopening should spawn a fresh pty.
    const { resolveSpawnForSession } = await import('../../../src/web/terminal/spawn.js');
    (resolveSpawnForSession as ReturnType<typeof vi.fn>).mockClear();
    currentPty = makeFakePty();
    await terminalManager.open('sess-9', fakeWs, 80, 24);
    expect(resolveSpawnForSession).toHaveBeenCalledTimes(1);
  });
});
