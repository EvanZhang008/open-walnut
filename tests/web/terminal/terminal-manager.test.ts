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
const sentEvents: { name: string; data: unknown }[] = [];
vi.mock('../../../src/web/ws/handler.js', () => ({
  sendToClient: (_ws: unknown, name: string, data: unknown) => { sentEvents.push({ name, data }); },
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

describe('output piping + scrollback', () => {
  it('forwards pty output to the attached client as terminal:data:<id>', async () => {
    await terminalManager.open('sess-3', fakeWs, 80, 24);
    currentPty._emitData('hello');
    const dataEvents = sentEvents.filter(e => e.name === 'terminal:data:sess-3');
    expect(dataEvents.length).toBeGreaterThanOrEqual(1);
    expect((dataEvents.at(-1)!.data as { data: string }).data).toBe('hello');
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
    terminalManager.close('sess-8');
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
