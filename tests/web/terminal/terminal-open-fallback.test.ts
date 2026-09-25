import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

/**
 * terminal:open end to end through the real register → dtach-check →
 * dtach-provision → terminal-manager → spawn chain. Only the process edges are
 * stubbed: `execFile` plays the remote host (answers the probe/build scripts
 * per scenario, no real ssh) and node-pty records what would be spawned.
 *
 * Guards the fresh-host report: a host without a C compiler got NO terminal,
 * and an ssh failure was blamed on the compiler.
 */

// The shipped prebuilts live in a per-file dir so each test decides which exist.
vi.mock('../../../src/constants.js', () => {
  const c = createMockConstants('walnut-term-open');
  return { ...c, DAEMON_BINARIES_DIR: path.join(c.WALNUT_HOME as string, 'prebuilt-bin') };
});

// ---- the remote host, as seen by execFile ----------------------------------
type HostScenario = 'no_compiler' | 'mac_no_clt' | 'ssh_denied' | 'walnut' | 'build_fails' | 'builds'
  | 'mac_prebuilt' | 'linux_prebuilt_fails_builds';
const hostState: { scenario: HostScenario; scripts: string[] } = { scenario: 'no_compiler', scripts: [] };

function answer(input: string): { code: number; stdout: string; stderr: string } {
  const BEGIN = 'WALNUT_DTACH_BEGIN\nOS:Linux\nARCH:x86_64\n';
  const MAC = 'WALNUT_DTACH_BEGIN\nOS:Darwin\nARCH:arm64\n';
  const isBuild = input.includes('base64 -d');
  switch (hostState.scenario) {
    case 'ssh_denied': return { code: 255, stdout: '', stderr: 'alice@devbox.example.com: Permission denied (publickey).\n' };
    case 'walnut': return { code: 0, stdout: `${BEGIN}DTACH_OK:walnut:/home/alice/.local/bin/walnut-dtach\n`, stderr: '' };
    case 'no_compiler': return { code: 0, stdout: `${BEGIN}NO_COMPILER\n`, stderr: '' };
    case 'mac_no_clt': return { code: 0, stdout: `${MAC}NO_COMPILER\n`, stderr: '' };
    case 'mac_prebuilt':
      return isBuild
        ? { code: 0, stdout: `${MAC}PREBUILT:/Users/alice/.local/bin/walnut-dtach\n`, stderr: '' }
        : { code: 0, stdout: `${MAC}NO_COMPILER\n`, stderr: '' };
    case 'linux_prebuilt_fails_builds':
      return isBuild
        ? { code: 0, stdout: `${BEGIN}PREBUILT_FAILED\nBUILT:/home/alice/.local/bin/walnut-dtach\n`, stderr: 'prebuilt dtach does not run on this host: GLIBC_2.34 not found\n' }
        : { code: 0, stdout: `${BEGIN}NEED_BUILD:gcc\n`, stderr: '' };
    case 'build_fails':
      return isBuild
        ? { code: 0, stdout: `${BEGIN}BUILD_FAILED\n`, stderr: '/usr/bin/ld: cannot find -lutil\n' }
        : { code: 0, stdout: `${BEGIN}NEED_BUILD:gcc\n`, stderr: '' };
    case 'builds':
      return isBuild
        ? { code: 0, stdout: `${BEGIN}BUILT:/home/alice/.local/bin/walnut-dtach\n`, stderr: '' }
        : { code: 0, stdout: `${BEGIN}NEED_BUILD:gcc\n`, stderr: '' };
  }
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const execFile = (cmd: string, args: string[], _opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
    if (cmd !== 'ssh') throw new Error(`unexpected execFile(${cmd}) in this test`);
    // Lifecycle helpers pass their script as the remote command (no stdin).
    if (args.at(-1) !== 'sh -s') {
      setImmediate(() => cb(null, 'DONE\n', ''));
      return { stdin: null };
    }
    return {
      stdin: {
        on: () => {},
        end: (input: string) => {
          hostState.scripts.push(input);
          const r = answer(input);
          const err = r.code === 0 ? null : Object.assign(new Error('ssh failed'), { code: r.code });
          setImmediate(() => cb(err, r.stdout, r.stderr));
        },
      },
    };
  };
  return { ...real, execFile };
});

// ---- node-pty: record spawns, hand back a controllable fake ----------------
interface Spawned { file: string; args: string[]; kill: ReturnType<typeof vi.fn>; exit: () => void }
const spawned: Spawned[] = [];
vi.mock('@homebridge/node-pty-prebuilt-multiarch', () => ({
  spawn: (file: string, args: string[]) => {
    let onExit: (e: { exitCode: number }) => void = () => {};
    const rec: Spawned = { file, args, kill: vi.fn(), exit: () => onExit({ exitCode: 0 }) };
    spawned.push(rec);
    return {
      onData: () => {},
      onExit: (cb: typeof onExit) => { onExit = cb; },
      write: vi.fn(),
      resize: vi.fn(),
      kill: rec.kill,
    };
  },
}));

// ---- RPC plumbing, session registry, host config ---------------------------
type Handler = (payload: unknown, client: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const sent: { name: string; data: unknown }[] = [];
vi.mock('../../../src/web/ws/handler.js', () => ({
  registerMethod: (name: string, fn: Handler) => { handlers.set(name, fn); },
  sendToClient: (_ws: unknown, name: string, data: unknown) => { sent.push({ name, data }); },
}));

vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(async (sid: string) => ({ claudeSessionId: sid, host: 'devbox', cwd: '/home/alice/proj' })),
  listSessions: vi.fn(async () => []),
}));

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ hosts: { devbox: { hostname: 'devbox.example.com', user: 'alice' } } })),
}));

import { registerTerminalRpc } from '../../../src/web/terminal/register.js';
import { terminalManager } from '../../../src/web/terminal/terminal-manager.js';
import { resetDtachCacheForTests } from '../../../src/web/terminal/dtach-provision.js';
import { conditionalReap } from '../../../src/web/terminal/dtach-lifecycle.js';
import { DAEMON_BINARIES_DIR } from '../../../src/constants.js';

/** Put a shipped prebuilt in place (the bytes only travel, the host is simulated). */
function ship(name: string): void {
  fs.mkdirSync(DAEMON_BINARIES_DIR, { recursive: true });
  fs.writeFileSync(path.join(DAEMON_BINARIES_DIR, name), 'prebuilt-bytes');
}

const ws = { readyState: 1 };
const open = (sessionId: string, extra: Record<string, unknown> = {}) =>
  handlers.get('terminal:open')!({ sessionId, cols: 100, rows: 30, ...extra }, ws) as Promise<Record<string, unknown>>;

beforeEach(async () => {
  if (!handlers.size) expect(await registerTerminalRpc()).toBe(true);
  terminalManager.shutdown();
  resetDtachCacheForTests();
  spawned.length = 0;
  sent.length = 0;
  hostState.scripts = [];
  fs.rmSync(DAEMON_BINARIES_DIR, { recursive: true, force: true });
});

afterAll(() => terminalManager.shutdown());

describe('terminal:open without dtach on the host', () => {
  it('no compiler → opens a plain ssh shell, persistent:false, reason no_compiler', async () => {
    hostState.scenario = 'no_compiler';
    const res = await open('sess-plain');
    expect(res).toMatchObject({
      ok: true,
      terminalId: 'sess-plain',
      persistent: false,
      reason: 'no_compiler',
      host: 'devbox',
      installCommand: 'sudo yum install -y gcc',
    });
    expect(res.installHint).toMatch(/No C compiler on devbox/);
    // One probe round trip, no build attempt.
    expect(hostState.scripts).toHaveLength(1);
    // The spawned shell is plain: login shell in the cwd, no dtach anywhere.
    expect(spawned).toHaveLength(1);
    const remoteCmd = spawned[0].args.at(-1)!;
    expect(spawned[0].file).toBe('ssh');
    expect(spawned[0].args).toContain('-tt');
    expect(remoteCmd).toBe(`cd '/home/alice/proj' && exec "\${SHELL:-/bin/bash}" -l`);
    expect(spawned[0].args.join(' ')).not.toMatch(/dtach|dsock/);
  });

  it('no compiler and only another machine\'s prebuilt: still one probe, no upload', async () => {
    hostState.scenario = 'no_compiler';
    ship('dtach-darwin-arm64'); // the host is Linux x86_64
    const res = await open('sess-other-arch');
    expect(res).toMatchObject({ persistent: false, reason: 'no_compiler' });
    expect(hostState.scripts).toHaveLength(1);
  });

  it('a remote Mac without the Command Line Tools gets xcode-select, not yum', async () => {
    hostState.scenario = 'mac_no_clt';
    const res = await open('sess-mac');
    expect(res).toMatchObject({ ok: true, persistent: false, reason: 'no_compiler', installCommand: 'xcode-select --install' });
    expect(JSON.stringify(res)).not.toMatch(/yum|apt-get/);
  });

  it('build failure → plain shell with reason build_failed and the ld error as detail', async () => {
    hostState.scenario = 'build_fails';
    const res = await open('sess-bf');
    expect(res).toMatchObject({ ok: true, persistent: false, reason: 'build_failed', installCommand: 'sudo yum install -y gcc glibc-devel' });
    expect(res.detail).toContain('cannot find -lutil');
    expect(hostState.scripts).toHaveLength(2); // probe, then build
  });

  it('ssh failure → ok:false SSH_FAILED with ssh stderr, no terminal, no compiler advice', async () => {
    hostState.scenario = 'ssh_denied';
    const res = await open('sess-ssh');
    expect(res).toMatchObject({ ok: false, code: 'SSH_FAILED', host: 'devbox' });
    expect(res.detail).toContain('Permission denied (publickey)');
    expect(String(res.hint)).toContain('ssh devbox');
    expect(JSON.stringify(res)).not.toMatch(/gcc|compiler/i);
    expect(spawned).toHaveLength(0);
  });

  it('dtach present → persistent:true and the dtach spawn', async () => {
    hostState.scenario = 'walnut';
    const res = await open('sess-p');
    expect(res).toEqual({ ok: true, terminalId: 'sess-p', cols: 100, rows: 30, persistent: true });
    expect(spawned[0].args.at(-1)).toContain("exec '/home/alice/.local/bin/walnut-dtach' -A");
  });
});

describe('terminal:open with a shipped prebuilt for the host', () => {
  it('a remote Mac without the Command Line Tools gets the prebuilt: persistent, no compile', async () => {
    hostState.scenario = 'mac_prebuilt';
    ship('dtach-darwin-arm64');
    const res = await open('sess-mac-pre');
    expect(res).toEqual({ ok: true, terminalId: 'sess-mac-pre', cols: 100, rows: 30, persistent: true });
    expect(hostState.scripts).toHaveLength(2); // probe, then install
    const install = hostState.scripts[1];
    expect(install).toContain('WALNUT_DTACH_PREBUILT_EOF');
    expect(install).toContain(Buffer.from('prebuilt-bytes').toString('base64'));
    expect(install).not.toContain('master.c'); // no compiler, so no source shipped
    expect(spawned[0].args.at(-1)).toContain("exec '/Users/alice/.local/bin/walnut-dtach' -A");
  });

  it('a Linux prebuilt that will not run there falls back to compiling in the same round trip', async () => {
    hostState.scenario = 'linux_prebuilt_fails_builds';
    ship('dtach-linux-x64');
    const res = await open('sess-linux-pre');
    expect(res).toMatchObject({ ok: true, persistent: true });
    expect(hostState.scripts).toHaveLength(2);
    expect(hostState.scripts[1]).toContain('WALNUT_DTACH_PREBUILT_EOF');
    expect(hostState.scripts[1]).toContain('master.c');
  });

  it('with a compiler and no matching prebuilt the install ships only the source', async () => {
    hostState.scenario = 'builds';
    ship('dtach-darwin-arm64');
    await open('sess-src-only');
    expect(hostState.scripts[1]).not.toContain('WALNUT_DTACH_PREBUILT_EOF');
    expect(hostState.scripts[1]).toContain('master.c');
  });
});

describe('Retry (reprobe) and reattach', () => {
  it('a plain reopen reattaches the live shell without re-probing', async () => {
    hostState.scenario = 'no_compiler';
    await open('sess-r1');
    hostState.scripts = [];
    const again = await open('sess-r1');
    expect(again).toMatchObject({ persistent: false, reason: 'no_compiler' });
    expect(hostState.scripts).toHaveLength(0);
    expect(spawned).toHaveLength(1);
  });

  it('a failed Retry keeps the plain shell (no respawn, no kill)', async () => {
    hostState.scenario = 'no_compiler';
    await open('sess-r2');
    const res = await open('sess-r2', { reprobe: true });
    expect(res).toMatchObject({ persistent: false });
    expect(hostState.scripts).toHaveLength(2); // the Retry re-probed despite the cached failure
    expect(spawned).toHaveLength(1);
    expect(spawned[0].kill).not.toHaveBeenCalled();
  });

  it('a Retry after gcc was installed upgrades: plain shell replaced, persistent spawned', async () => {
    hostState.scenario = 'no_compiler';
    await open('sess-r3');
    hostState.scenario = 'builds';
    const res = await open('sess-r3', { reprobe: true });
    expect(res).toMatchObject({ ok: true, terminalId: 'sess-r3', persistent: true });
    expect(spawned).toHaveLength(2);
    expect(spawned[0].kill).toHaveBeenCalled();
    expect(spawned[1].args.at(-1)).toContain('walnut-dtach');
    // The replaced shell's late exit must not forget its successor or tell the UI it exited.
    spawned[0].exit();
    expect(terminalManager.liveMode('sess-r3')).toEqual({ persistent: true });
    expect(sent.find((e) => e.name === 'terminal:exit:sess-r3')).toBeUndefined();
  });

  it('terminal:kill ends a plain shell immediately', async () => {
    hostState.scenario = 'no_compiler';
    await open('sess-k');
    await handlers.get('terminal:kill')!({ terminalId: 'sess-k' }, ws);
    expect(spawned[0].kill).toHaveBeenCalled();
    expect(terminalManager.liveMode('sess-k')).toBeNull();
  });

  it('conditionalReap ends a detached plain shell (it has no dtach socket to inspect)', async () => {
    hostState.scenario = 'no_compiler';
    await open('sess-reap');
    terminalManager.close('sess-reap'); // detach: nobody is viewing it
    expect(await conditionalReap({ claudeSessionId: 'sess-reap', host: 'devbox' })).toBe('killed');
    expect(spawned[0].kill).toHaveBeenCalled();
    expect(terminalManager.liveMode('sess-reap')).toBeNull();
  });
});
