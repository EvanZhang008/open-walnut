import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The shipped prebuilt dtach (scripts/build-dtach.sh) is how a Mac without the
 * Command Line Tools gets a persistent terminal. Pinned here: the name mapping
 * for both vocabularies (Node's process.platform/arch locally, uname remotely),
 * the lookup's refusals, and the local order: cache, system, prebuilt, compile.
 * A prebuilt that fails its `--help` check must fall through to compiling, never
 * be trusted and never abort the provision.
 */

vi.mock('../../../src/constants.js', async () => {
  const { createMockConstants } = await import('../../helpers/mock-constants.js');
  const c = createMockConstants('walnut-dtach-prebuilt');
  return { ...c, DAEMON_BINARIES_DIR: path.join(c.WALNUT_HOME as string, 'prebuilt-bin') };
});

// The machine running the tests may have a system dtach or a compiler; neither
// may decide these cases. `which` and the compiler are simulated, every other
// command (the fake prebuilts' --help) really runs.
const env = vi.hoisted(() => ({ hasCc: false, ccCalls: [] as string[][] }));
const SYSTEM_DTACH = ['/opt/homebrew/bin/dtach', '/usr/local/bin/dtach', '/usr/bin/dtach'];
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const execFile = (cmd: string, args: string[], opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => {
    const reply = (code: number, stdout: string) => {
      setImmediate(() => cb(code === 0 ? null : Object.assign(new Error('exit'), { code }), stdout, ''));
      return { stdin: null };
    };
    if (cmd === 'which') return args[0] === 'cc' && env.hasCc ? reply(0, '/usr/bin/cc\n') : reply(1, '');
    if (SYSTEM_DTACH.includes(cmd)) return reply(1, 'not this one');
    if (cmd === 'cc') {
      // A "compile" that produces a working dtach at the -o path.
      env.ccCalls.push(args);
      const out = args[args.indexOf('-o') + 1];
      fs.writeFileSync(out, '#!/bin/sh\necho "dtach - version 0.9, compiled from source"\n', { mode: 0o755 });
      return reply(0, '');
    }
    return real.execFile(cmd, args, opts as never, cb as never);
  };
  return { ...real, execFile };
});

import { DAEMON_BINARIES_DIR, TMP_DIR } from '../../../src/constants.js';
import { findPrebuiltDtach, prebuiltDtachName } from '../../../src/web/terminal/dtach-prebuilt.js';
import { resolveLocalDtach, resetDtachCacheForTests } from '../../../src/web/terminal/dtach-provision.js';

const LOCAL_BIN = path.join(TMP_DIR, 'bin', 'walnut-dtach');
const HOST_PREBUILT = prebuiltDtachName(process.platform, process.arch);

function shipPrebuilt(content: string | Buffer): string {
  fs.mkdirSync(DAEMON_BINARIES_DIR, { recursive: true });
  const p = path.join(DAEMON_BINARIES_DIR, HOST_PREBUILT!);
  fs.writeFileSync(p, content, { mode: 0o755 });
  return p;
}

beforeEach(() => {
  resetDtachCacheForTests();
  fs.rmSync(DAEMON_BINARIES_DIR, { recursive: true, force: true });
  fs.rmSync(path.join(TMP_DIR, 'bin'), { recursive: true, force: true });
  env.hasCc = false;
  env.ccCalls = [];
});

describe('prebuiltDtachName', () => {
  it('maps Node platform/arch words', () => {
    expect(prebuiltDtachName('darwin', 'arm64')).toBe('dtach-darwin-arm64');
    expect(prebuiltDtachName('darwin', 'x64')).toBe('dtach-darwin-x64');
    expect(prebuiltDtachName('linux', 'x64')).toBe('dtach-linux-x64');
    expect(prebuiltDtachName('linux', 'arm64')).toBe('dtach-linux-arm64');
  });

  it('maps uname -s / uname -m words to the same names', () => {
    expect(prebuiltDtachName('Darwin', 'arm64')).toBe('dtach-darwin-arm64');
    expect(prebuiltDtachName('Darwin', 'x86_64')).toBe('dtach-darwin-x64');
    expect(prebuiltDtachName('Linux', 'x86_64')).toBe('dtach-linux-x64');
    expect(prebuiltDtachName('Linux', 'aarch64')).toBe('dtach-linux-arm64');
    expect(prebuiltDtachName('Linux', 'amd64\n')).toBe('dtach-linux-x64');
  });

  it('has no name for a platform or machine nothing is built for', () => {
    for (const [p, a] of [['win32', 'x64'], ['FreeBSD', 'amd64'], ['Linux', 'ppc64le'], ['Linux', 'armv7l'], ['unknown', 'arm64'], [undefined, 'x64'], ['linux', undefined]]) {
      expect(prebuiltDtachName(p, a)).toBeNull();
    }
  });
});

describe('findPrebuiltDtach', () => {
  it('is null when the file is missing, is a directory, or is empty', async () => {
    expect(await findPrebuiltDtach('linux', 'x64')).toBeNull();
    fs.mkdirSync(path.join(DAEMON_BINARIES_DIR, 'dtach-linux-x64'), { recursive: true });
    expect(await findPrebuiltDtach('linux', 'x64')).toBeNull();
    fs.writeFileSync(path.join(DAEMON_BINARIES_DIR, 'dtach-linux-arm64'), '');
    expect(await findPrebuiltDtach('linux', 'arm64')).toBeNull();
  });

  it('refuses a file far larger than any dtach (never shipped over ssh)', async () => {
    fs.mkdirSync(DAEMON_BINARIES_DIR, { recursive: true });
    const p = path.join(DAEMON_BINARIES_DIR, 'dtach-darwin-x64');
    fs.writeFileSync(p, '');
    fs.truncateSync(p, 3 * 1024 * 1024);
    expect(await findPrebuiltDtach('Darwin', 'x86_64')).toBeNull();
  });

  it('never returns another platform\'s binary', async () => {
    fs.mkdirSync(DAEMON_BINARIES_DIR, { recursive: true });
    fs.writeFileSync(path.join(DAEMON_BINARIES_DIR, 'dtach-darwin-arm64'), 'x');
    expect(await findPrebuiltDtach('Linux', 'x86_64')).toBeNull();
    expect(await findPrebuiltDtach('Darwin', 'arm64')).toBe(path.join(DAEMON_BINARIES_DIR, 'dtach-darwin-arm64'));
  });
});

describe.skipIf(!HOST_PREBUILT)('resolveLocalDtach with a shipped prebuilt', () => {
  it('installs a working prebuilt into the cache path, then reuses the cache', async () => {
    shipPrebuilt('#!/bin/sh\necho "dtach - version 0.9, prebuilt"\n');
    expect(await resolveLocalDtach()).toEqual({ kind: 'ok', path: LOCAL_BIN, source: 'prebuilt' });
    expect(fs.statSync(LOCAL_BIN).mode & 0o111).not.toBe(0);
    expect(fs.readdirSync(path.dirname(LOCAL_BIN))).toEqual(['walnut-dtach']); // no temp file left
    resetDtachCacheForTests();
    expect(await resolveLocalDtach()).toEqual({ kind: 'ok', path: LOCAL_BIN, source: 'walnut' });
  });

  it('needs no compiler (the case it exists for)', async () => {
    shipPrebuilt('#!/bin/sh\necho "dtach - version 0.9, prebuilt"\n');
    expect(await resolveLocalDtach()).toMatchObject({ kind: 'ok', source: 'prebuilt' });
    expect(env.ccCalls).toHaveLength(0);
  });

  it('a corrupt prebuilt (bytes the kernel cannot exec) falls through to compiling', async () => {
    shipPrebuilt(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x13, 0x37, 0x00, 0xff, 0xfe, 0x00, 0x01]));
    env.hasCc = true;
    expect(await resolveLocalDtach()).toEqual({ kind: 'ok', path: LOCAL_BIN, source: 'built' });
    expect(env.ccCalls).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(LOCAL_BIN))).toEqual(['walnut-dtach']);
  });

  it('a prebuilt whose error merely names the walnut-dtach file is not a dtach', async () => {
    // What sh prints for a file it can't run: the path, which contains "dtach".
    shipPrebuilt('#!/bin/sh\necho "$0: cannot execute binary file" >&2\nexit 126\n');
    env.hasCc = true;
    expect(await resolveLocalDtach()).toMatchObject({ kind: 'ok', source: 'built' });
  });

  it('a broken prebuilt and no compiler is no_compiler, with nothing left in the cache path', async () => {
    shipPrebuilt('#!/bin/sh\nexit 1\n');
    expect(await resolveLocalDtach()).toMatchObject({ kind: 'no_compiler' });
    expect(fs.existsSync(LOCAL_BIN)).toBe(false);
  });

  it('no prebuilt for this machine compiles as before', async () => {
    env.hasCc = true;
    expect(await resolveLocalDtach()).toMatchObject({ kind: 'ok', source: 'built' });
    resetDtachCacheForTests();
    fs.rmSync(path.join(TMP_DIR, 'bin'), { recursive: true, force: true });
    env.hasCc = false;
    expect(await resolveLocalDtach()).toMatchObject({ kind: 'no_compiler' });
  });
});
