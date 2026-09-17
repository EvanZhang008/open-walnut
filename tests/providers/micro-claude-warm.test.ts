/**
 * Warm micro-Claude pool ratchet — the pre-booted stream-json child that
 * saves the ~2-2.5s CLI boot (POC 2026-08-30: cold 4.6s vs warm 2.0s
 * send→result). Pin: the spawn shape (stream-json in/out + full slim combo
 * + thinking off), pool reuse by spec key, and replacement prewarming.
 * Tool budgets are prompt-only by design (watchdog injection reverted as
 * over-engineering — user call, 2026-08-30).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { createMockConstants } from '../helpers/mock-constants.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-micro-claude-warm'));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../../src/core/claude-cli-detect.js', () => ({
  resolveClaudeCliExecutable: () => '/usr/local/bin/claude',
}));

import { realpathSync } from 'node:fs';
import {
  runWarmMicroClaude,
  prewarmMicroClaude,
  resolvedTmpdir,
  _resetWarmPoolForTesting,
} from '../../src/providers/micro-claude-warm.js';

interface FakeProc extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
}

function fakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  proc.exitCode = null;
  proc.killed = false;
  return proc;
}

const SPEC = { system: 'tiny contract', model: 'sonnet', tools: ['Bash'] };

function feedResult(proc: FakeProc, result = '{"results":[]}'): void {
  proc.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result, total_cost_usd: 0.01 }) + '\n');
}

/** The CLI's own `system:init` line — a pooled child prints it while booting. */
function feedInit(proc: FakeProc, sessionId: string, cwd?: string): void {
  proc.stdout.write(JSON.stringify({
    type: 'system', subtype: 'init', session_id: sessionId, model: 'sonnet', ...(cwd ? { cwd } : {}),
  }) + '\n');
}

function feedToolUse(proc: FakeProc, id: string): void {
  proc.stdout.write(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'curl …' } }] },
  }) + '\n');
}

beforeEach(() => {
  _resetWarmPoolForTesting();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeProc());
});

describe('warm micro-claude pool', () => {
  it('spawns the pinned stream-json slim shape with thinking off', async () => {
    const procs: FakeProc[] = [];
    spawnMock.mockImplementation(() => { const p = fakeProc(); procs.push(p); return p; });
    const done = runWarmMicroClaude({ ...SPEC, prompt: 'find it', timeoutMs: 5_000, toolUseId: 'tu-w1' });
    await new Promise((r) => setTimeout(r, 10));
    feedResult(procs[0]);
    const run = await done;
    expect(run.response).toBe('{"results":[]}');
    expect(run.costUsd).toBe(0.01);
    expect(run.warm).toBe(false); // no pooled child existed

    const [, args, opts] = spawnMock.mock.calls[0];
    for (const pair of [['--input-format', 'stream-json'], ['--output-format', 'stream-json'],
      ['--system-prompt', 'tiny contract'], ['--tools', 'Bash'], ['--setting-sources', '']] as const) {
      expect(args[args.indexOf(pair[0]) + 1]).toBe(pair[1]);
    }
    expect(args).toContain('--bare');
    expect(opts.cwd).toBe(tmpdir());
    expect(opts.env.CLAUDE_CODE_ENTRYPOINT).toBe('walnut-utility');
    expect(opts.env.MAX_THINKING_TOKENS).toBe('0');
    // The prompt rides stdin as ONE stream-json user message.
    const wrote = JSON.parse(procs[0].stdin.write.mock.calls[0][0] as string);
    expect(wrote).toEqual({ type: 'user', message: { role: 'user', content: 'find it' } });
    // Single-use: stdin closed after the result.
    expect(procs[0].stdin.end).toHaveBeenCalled();
  });

  it('a prewarmed child with the same spec is reused, and a replacement is prewarmed', async () => {
    const procs: FakeProc[] = [];
    spawnMock.mockImplementation(() => { const p = fakeProc(); procs.push(p); return p; });
    prewarmMicroClaude(SPEC);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    prewarmMicroClaude(SPEC); // idempotent while the pooled child lives
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const done = runWarmMicroClaude({ ...SPEC, prompt: 'q', timeoutMs: 5_000, toolUseId: 'tu-w2' });
    await new Promise((r) => setTimeout(r, 10));
    // The POOLED proc got the prompt; a replacement spawn already happened.
    expect(procs[0].stdin.write).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    feedResult(procs[0]);
    expect((await done).warm).toBe(true);
  });

  it('a spec mismatch does not reuse the pooled child', async () => {
    const procs: FakeProc[] = [];
    spawnMock.mockImplementation(() => { const p = fakeProc(); procs.push(p); return p; });
    prewarmMicroClaude(SPEC);
    const done = runWarmMicroClaude({ ...SPEC, model: 'haiku', prompt: 'q', timeoutMs: 5_000, toolUseId: 'tu-w3' });
    await new Promise((r) => setTimeout(r, 10));
    expect(procs[0].stdin.write).not.toHaveBeenCalled(); // pooled sonnet child untouched
    feedResult(procs[1]);
    expect((await done).warm).toBe(false);
  });

  it('streams tool_call blocks to onBlock and writes ONLY the prompt on stdin (no injections)', async () => {
    const procs: FakeProc[] = [];
    spawnMock.mockImplementation(() => { const p = fakeProc(); procs.push(p); return p; });
    const blocks: string[] = [];
    const done = runWarmMicroClaude({
      ...SPEC, prompt: 'q', timeoutMs: 5_000, toolUseId: 'tu-w4',
      onBlock: (b) => blocks.push(b.type),
    });
    await new Promise((r) => setTimeout(r, 10));
    feedToolUse(procs[0], 'b1');
    feedToolUse(procs[0], 'b2');
    feedToolUse(procs[0], 'b3');
    await new Promise((r) => setTimeout(r, 10));
    // Tool budgets are prompt-only (user call): stdin carries the ONE prompt
    // message and nothing else, however many tools the child runs.
    expect(procs[0].stdin.write).toHaveBeenCalledTimes(1);
    feedResult(procs[0]);
    await done;
    expect(blocks.filter((b) => b === 'tool_call')).toHaveLength(3);
  });

  it('rejects when the child dies before answering', async () => {
    const procs: FakeProc[] = [];
    spawnMock.mockImplementation(() => { const p = fakeProc(); procs.push(p); return p; });
    const done = runWarmMicroClaude({ ...SPEC, prompt: 'q', timeoutMs: 5_000, toolUseId: 'tu-w5' });
    await new Promise((r) => setTimeout(r, 10));
    procs[0].exitCode = 1;
    procs[0].emit('exit', 1);
    await expect(done).rejects.toThrow(/exited before answering/);
  });

  // The child is a real Claude Code session, and reporting WHICH one is what
  // lets a caller hand the finished conversation to the user (the ✦ search
  // card's "Open as session") instead of running the work twice.
  describe('the run reports the child it ran on', () => {
    it('captures the session id a POOLED child printed while it was booting', async () => {
      const procs: FakeProc[] = [];
      spawnMock.mockImplementation(() => { const p = fakeProc(); procs.push(p); return p; });
      prewarmMicroClaude(SPEC);
      // The init line lands BEFORE any call takes this child out — the whole
      // point of the pool. A capture that only listened from runWarmMicroClaude
      // would miss it (readline drops lines nobody is listening for), leaving
      // the warm path — the common one — with no session to adopt.
      feedInit(procs[0], 'sess-pooled-1', '/private/var/folders/xx/T');
      await new Promise((r) => setTimeout(r, 10));

      const done = runWarmMicroClaude({ ...SPEC, prompt: 'q', timeoutMs: 5_000, toolUseId: 'tu-w6' });
      await new Promise((r) => setTimeout(r, 10));
      feedResult(procs[0]);
      const run = await done;
      expect(run.warm).toBe(true);
      expect(run.sessionId).toBe('sess-pooled-1');
      // The CLI's OWN cwd, not what we asked for: its encoding is what names the
      // transcript directory, and the CLI reports the realpath.
      expect(run.cwd).toBe('/private/var/folders/xx/T');
    });

    it('captures it on a cold spawn too, and falls back to the spawn cwd', async () => {
      const procs: FakeProc[] = [];
      spawnMock.mockImplementation(() => { const p = fakeProc(); procs.push(p); return p; });
      const done = runWarmMicroClaude({ ...SPEC, prompt: 'q', timeoutMs: 5_000, toolUseId: 'tu-w7' });
      await new Promise((r) => setTimeout(r, 10));
      feedInit(procs[0], 'sess-cold-1'); // no cwd in the init line
      feedResult(procs[0]);
      const run = await done;
      expect(run.warm).toBe(false);
      expect(run.sessionId).toBe('sess-cold-1');
      // REALPATH'd, not the raw spawn cwd: on macOS os.tmpdir() is
      // `/var/folders/…` while the CLI resolves and encodes
      // `/private/var/folders/…`, so the raw string names a project directory no
      // transcript is ever written to — an adopter checking it finds nothing and
      // silently falls back to starting a new session.
      expect(run.cwd).toBe(resolvedTmpdir());
      if (realpathSync(tmpdir()) !== tmpdir()) expect(run.cwd).not.toBe(tmpdir());
    });

    it('reports no session id when the child never announced one', async () => {
      const procs: FakeProc[] = [];
      spawnMock.mockImplementation(() => { const p = fakeProc(); procs.push(p); return p; });
      const done = runWarmMicroClaude({ ...SPEC, prompt: 'q', timeoutMs: 5_000, toolUseId: 'tu-w8' });
      await new Promise((r) => setTimeout(r, 10));
      feedResult(procs[0]);
      // Undefined, never invented: an adopter must degrade to starting a fresh
      // session rather than resume an id that no transcript belongs to.
      expect((await done).sessionId).toBeUndefined();
    });
  });
});
