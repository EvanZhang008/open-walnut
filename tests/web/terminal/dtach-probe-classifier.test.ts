import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BEGIN_MARKER,
  buildCompileScript,
  buildInstallScript,
  buildProbeScript,
  classifyScriptRun,
  parseHostPlatform,
  toHostOs,
} from '../../../src/web/terminal/dtach-probe-script.js';
import { decideTerminalMode } from '../../../src/web/terminal/dtach-check.js';
import { DTACH_SOURCES } from '../../../src/web/terminal/dtach-sources.js';
import { findPrebuiltDtach } from '../../../src/web/terminal/dtach-prebuilt.js';

/**
 * The dtach probe classifier decides whether a terminal opens persistent, as a
 * plain shell, or not at all. The bug it guards: ssh failures (empty stdout)
 * used to be reported as "no C compiler", so the UI told users with a broken
 * ssh key to install gcc. Captured outputs below mirror what `ssh host sh -s`
 * really prints for each case.
 */
const run = (stdout: string, stderr = '', code = 0, timedOut = false) => ({ stdout, stderr, code, timedOut });
/** What the scripts print first: the marker, then `uname -s` and `uname -m`. */
const LINUX = `${BEGIN_MARKER}\nOS:Linux\nARCH:x86_64\n`;
const DARWIN = `${BEGIN_MARKER}\nOS:Darwin\nARCH:arm64\n`;

describe('classifyScriptRun: captured probe/build outputs', () => {
  it('walnut binary already present', () => {
    expect(classifyScriptRun(run(`${LINUX}DTACH_OK:walnut:/home/alice/.local/bin/walnut-dtach\n`)))
      .toEqual({ kind: 'ok', source: 'walnut', path: '/home/alice/.local/bin/walnut-dtach' });
  });

  it('only a system dtach (yum/apt/brew)', () => {
    expect(classifyScriptRun(run(`${LINUX}DTACH_OK:system:/usr/bin/dtach\n`)))
      .toEqual({ kind: 'ok', source: 'system', path: '/usr/bin/dtach' });
  });

  it('compiler present: probe asks for a build, build reports BUILT', () => {
    expect(classifyScriptRun(run(`${LINUX}NEED_BUILD:gcc\n`))).toEqual({ kind: 'need_build', cc: 'gcc' });
    expect(classifyScriptRun(run(`${LINUX}BUILT:/home/alice/.local/bin/walnut-dtach\n`, 'master.c: warning: unused variable')))
      .toEqual({ kind: 'ok', source: 'built', path: '/home/alice/.local/bin/walnut-dtach' });
  });

  it('the shipped prebuilt installed: PREBUILT is ok with source prebuilt', () => {
    expect(classifyScriptRun(run(`${DARWIN}PREBUILT:/Users/alice/.local/bin/walnut-dtach\n`)))
      .toEqual({ kind: 'ok', source: 'prebuilt', path: '/Users/alice/.local/bin/walnut-dtach' });
  });

  it('a prebuilt that would not run, then a compile: the compile decides', () => {
    const stderr = 'prebuilt dtach does not run on this host: version `GLIBC_2.34\' not found';
    expect(classifyScriptRun(run(`${LINUX}PREBUILT_FAILED\nBUILT:/home/alice/.local/bin/walnut-dtach\n`, stderr)))
      .toEqual({ kind: 'ok', source: 'built', path: '/home/alice/.local/bin/walnut-dtach' });
    expect(classifyScriptRun(run(`${LINUX}PREBUILT_FAILED\nBUILD_FAILED\n`, 'ld: cannot find -lutil')))
      .toMatchObject({ kind: 'build_failed', os: 'linux' });
    // No compiler behind it: the remaining fix is installing one.
    expect(classifyScriptRun(run(`${DARWIN}PREBUILT_FAILED\nNO_COMPILER\n`))).toEqual({ kind: 'no_compiler', os: 'darwin' });
  });

  it('parseHostPlatform reads uname -s and uname -m', () => {
    expect(parseHostPlatform(DARWIN)).toEqual({ os: 'darwin', arch: 'arm64' });
    expect(parseHostPlatform(`${LINUX}NO_COMPILER\n`)).toEqual({ os: 'linux', arch: 'x86_64' });
    expect(parseHostPlatform(`${BEGIN_MARKER}\nOS:Linux\nARCH:\n`)).toEqual({ os: 'linux', arch: undefined });
    expect(parseHostPlatform('')).toEqual({ os: 'unknown', arch: undefined });
  });

  it('compiler missing needs the positive NO_COMPILER marker, and carries the OS', () => {
    expect(classifyScriptRun(run(`${LINUX}NO_COMPILER\n`))).toEqual({ kind: 'no_compiler', os: 'linux' });
  });

  it('a Mac without the Command Line Tools reports darwin', () => {
    expect(classifyScriptRun(run(`${DARWIN}NO_COMPILER\n`))).toEqual({ kind: 'no_compiler', os: 'darwin' });
    // macOS: /usr/bin/cc exists as a stub, so the probe asks for a build and the build fails.
    const stderr = 'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun';
    expect(classifyScriptRun(run(`${DARWIN}BUILD_FAILED\n`, stderr))).toEqual({ kind: 'build_failed', stderr, os: 'darwin' });
  });

  it('an unrecognised or missing uname is os unknown', () => {
    expect(classifyScriptRun(run(`${BEGIN_MARKER}\nOS:FreeBSD\nARCH:amd64\nNO_COMPILER\n`))).toEqual({ kind: 'no_compiler', os: 'unknown' });
    expect(classifyScriptRun(run(`${BEGIN_MARKER}\nOS:\nNO_COMPILER\n`))).toEqual({ kind: 'no_compiler', os: 'unknown' });
    expect(classifyScriptRun(run(`${BEGIN_MARKER}\nNO_COMPILER\n`))).toEqual({ kind: 'no_compiler', os: 'unknown' });
  });

  it('ssh exit 255 with "Permission denied" is ssh_failed, never no_compiler', () => {
    const r = classifyScriptRun(run('', 'alice@devbox.example.com: Permission denied (publickey,gssapi-with-mic).\n', 255));
    expect(r).toEqual({ kind: 'ssh_failed', exitCode: 255, stderr: 'alice@devbox.example.com: Permission denied (publickey,gssapi-with-mic).' });
  });

  it('silent ssh (no marker, no stderr) is still ssh_failed, with a readable reason', () => {
    expect(classifyScriptRun(run('', '', 0))).toMatchObject({ kind: 'ssh_failed', exitCode: 0 });
    expect(classifyScriptRun(run('', '', 1, true))).toMatchObject({ kind: 'ssh_failed', stderr: expect.stringMatching(/timed out/) });
  });

  it('build failure keeps the ld error for the UI', () => {
    const stderr = '/usr/bin/ld: cannot find -lutil\ncollect2: error: ld returned 1 exit status\n';
    expect(classifyScriptRun(run(`${LINUX}BUILD_FAILED\n`, stderr)))
      .toEqual({ kind: 'build_failed', stderr: stderr.trim(), os: 'linux' });
  });

  it('connection dropped mid-script (255 after the marker) is ssh_failed', () => {
    expect(classifyScriptRun(run(LINUX, 'Connection to devbox.example.com closed by remote host.', 255)))
      .toMatchObject({ kind: 'ssh_failed', exitCode: 255 });
  });

  it('a positive marker wins over a non-zero exit (ssh noise after the script)', () => {
    expect(classifyScriptRun(run(`${LINUX}DTACH_OK:walnut:/home/alice/.local/bin/walnut-dtach\n`, 'mux_client_request_session: read from master failed', 255)))
      .toMatchObject({ kind: 'ok', source: 'walnut' });
  });
});

describe('decideTerminalMode', () => {
  it('ok → persistent', () => {
    expect(decideTerminalMode({ kind: 'ok', path: '/x', source: 'system' }, 'devbox')).toEqual({ ok: true, mode: { persistent: true } });
  });

  it('linux no_compiler → plain shell with the gcc command (command only, for Copy), apt in the hint', () => {
    const d = decideTerminalMode({ kind: 'no_compiler', os: 'linux' }, 'devbox');
    expect(d).toMatchObject({ ok: true, mode: { persistent: false, reason: 'no_compiler', host: 'devbox', installCommand: 'sudo yum install -y gcc' } });
    const hint = (d as { mode: { installHint: string } }).mode.installHint;
    expect(hint).toContain('sudo apt-get install -y gcc');
    expect(hint).not.toContain('xcode-select');
  });

  it('linux build_failed → plain shell, dev-headers command, stderr as detail', () => {
    const d = decideTerminalMode({ kind: 'build_failed', stderr: 'ld: cannot find -lutil', os: 'linux' }, 'devbox');
    expect(d).toMatchObject({ ok: true, mode: { persistent: false, reason: 'build_failed', installCommand: 'sudo yum install -y gcc glibc-devel', detail: 'ld: cannot find -lutil' } });
  });

  it('darwin (remote Mac or local Mac) → xcode-select, never yum or apt', () => {
    for (const r of [{ kind: 'no_compiler', os: 'darwin' }, { kind: 'build_failed', stderr: 'xcrun: error', os: 'darwin' }] as const) {
      for (const host of ['mac-mini', undefined]) {
        const d = decideTerminalMode(r, host) as { mode: { installCommand: string; installHint: string } };
        expect(d.mode.installCommand).toBe('xcode-select --install');
        expect(d.mode.installHint).not.toMatch(/yum|apt-get/);
      }
    }
  });

  it('unknown OS → yum for Copy, the hint lists yum, apt and xcode-select', () => {
    const d = decideTerminalMode({ kind: 'no_compiler', os: 'unknown' }, 'devbox') as { mode: { installCommand: string; installHint: string } };
    expect(d.mode.installCommand).toBe('sudo yum install -y gcc');
    expect(d.mode.installHint).toContain('sudo yum install -y gcc');
    expect(d.mode.installHint).toContain('sudo apt-get install -y gcc');
    expect(d.mode.installHint).toContain('xcode-select --install');
  });

  it('ssh_failed → SSH_FAILED with an ssh hint and no compiler advice', () => {
    const d = decideTerminalMode({ kind: 'ssh_failed', exitCode: 255, stderr: 'Permission denied (publickey).' }, 'devbox');
    expect(d).toMatchObject({ ok: false, code: 'SSH_FAILED', host: 'devbox', detail: 'Permission denied (publickey).' });
    expect(JSON.stringify(d)).not.toMatch(/gcc|compiler/i);
    expect((d as { hint: string }).hint).toContain('ssh devbox');
  });
});

// ---- The scripts themselves, run by a real local `sh` (no ssh) -------------

const tmpRoots: string[] = [];
afterAll(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

/** A sandbox: fake HOME + a PATH holding only the tools the scripts need. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-dtach-probe-'));
  tmpRoots.push(root);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of ['grep', 'dirname', 'mkdir', 'mktemp', 'base64', 'printf', 'rm', 'mv', 'uname', 'cat', 'chmod', 'head']) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim();
    if (found.startsWith('/')) fs.symlinkSync(found, path.join(bin, tool));
  }
  const execRaw = (script: string) => spawnSync('/bin/sh', ['-s'], { input: script, encoding: 'utf-8', env: { HOME: home, PATH: bin }, timeout: 30_000 });
  const exec = (script: string) => {
    const r = execRaw(script);
    return classifyScriptRun({ code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
  };
  const fakeTool = (dir: string, name: string, body: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };
  return { home, bin, exec, execRaw, fakeTool };
}

const SYSTEM_DTACH_DIRS = ['/usr/bin/dtach', '/usr/local/bin/dtach', '/opt/homebrew/bin/dtach'];
const hostHasSystemDtach = SYSTEM_DTACH_DIRS.some((p) => fs.existsSync(p));
const realCc = ['/usr/bin/cc', '/usr/bin/gcc', '/usr/bin/clang'].find((p) => fs.existsSync(p));
const ccWorks = Boolean(realCc) && spawnSync(realCc!, ['--version'], { encoding: 'utf-8' }).status === 0;

describe('probe script (real sh)', () => {
  it('finds the walnut binary in ~/.local/bin', () => {
    const s = sandbox();
    const b = s.fakeTool(path.join(s.home, '.local/bin'), 'walnut-dtach', 'echo "dtach - version 0.9"');
    expect(s.exec(buildProbeScript())).toEqual({ kind: 'ok', source: 'walnut', path: b });
  });

  it('finds a system dtach on PATH, but only one that knows -r winch', () => {
    const s = sandbox();
    s.fakeTool(s.bin, 'dtach', 'echo "dtach - version 0.9"; echo "  -r <method> none, ctrl_l, winch"');
    expect(s.exec(buildProbeScript())).toEqual({ kind: 'ok', source: 'system', path: path.join(s.bin, 'dtach') });
  });

  it.skipIf(hostHasSystemDtach)('skips a pre-0.8 system dtach (no winch) and asks for a build', () => {
    const old = sandbox();
    old.fakeTool(old.bin, 'dtach', 'echo "dtach - version 0.7"');
    old.fakeTool(old.bin, 'cc', 'exit 0');
    expect(old.exec(buildProbeScript())).toEqual({ kind: 'need_build', cc: 'cc' });
  });

  it.skipIf(hostHasSystemDtach)('reports NO_COMPILER when nothing is available, with this machine\'s OS from uname', () => {
    expect(sandbox().exec(buildProbeScript())).toEqual({ kind: 'no_compiler', os: toHostOs(process.platform) });
  });

  it('build script reports BUILD_FAILED with the compiler stderr', () => {
    const s = sandbox();
    s.fakeTool(s.bin, 'cc', 'echo "/usr/bin/ld: cannot find -lutil" >&2; exit 1');
    const r = s.exec(buildCompileScript('cc', DTACH_SOURCES));
    expect(r).toMatchObject({ kind: 'build_failed', os: toHostOs(process.platform) });
    expect((r as { stderr: string }).stderr).toContain('cannot find -lutil');
    expect(fs.existsSync(path.join(s.home, '.local/bin/walnut-dtach'))).toBe(false);
  });

  it('the probe reports uname -m for the prebuilt pick', () => {
    const r = sandbox().execRaw(buildProbeScript());
    const machine = spawnSync('uname', ['-m'], { encoding: 'utf-8' }).stdout.trim();
    expect(parseHostPlatform(r.stdout)).toEqual({ os: toHostOs(process.platform), arch: machine });
  });

  it('is_dtach wants the dtach banner, not a file name that merely contains "dtach"', () => {
    const s = sandbox();
    // What sh prints for a file it can't run: the path, which contains "dtach".
    s.fakeTool(path.join(s.home, '.local/bin'), 'walnut-dtach', 'echo "$0: cannot execute binary file" >&2; exit 126');
    expect(s.exec(buildProbeScript())).not.toMatchObject({ kind: 'ok', source: 'walnut' });
  });
});

describe('install script with a shipped prebuilt (real sh)', () => {
  const fakeDtach = Buffer.from('#!/bin/sh\necho "dtach - version 0.9, prebuilt"\n');
  // Starts like an ELF file so the kernel refuses it and sh retries it as a script.
  const corrupt = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x13, 0x37, 0x00, 0xff]);

  it('installs a prebuilt that runs, without a compiler', () => {
    const s = sandbox();
    const r = s.exec(buildInstallScript({ prebuilt: fakeDtach, sources: DTACH_SOURCES }));
    const bin = path.join(s.home, '.local/bin/walnut-dtach');
    expect(r).toEqual({ kind: 'ok', source: 'prebuilt', path: bin });
    expect(fs.readFileSync(bin)).toEqual(fakeDtach);
    expect(fs.readdirSync(path.dirname(bin))).toEqual(['walnut-dtach']);
  });

  it('a prebuilt that would not run and no compiler: no_compiler, nothing installed', () => {
    const s = sandbox();
    const raw = s.execRaw(buildInstallScript({ prebuilt: corrupt, sources: DTACH_SOURCES }));
    expect(raw.stdout).toMatch(/^PREBUILT_FAILED$/m);
    expect(raw.stderr).toContain('prebuilt dtach does not run on this host');
    expect(classifyScriptRun({ code: raw.status ?? 1, stdout: raw.stdout, stderr: raw.stderr }))
      .toEqual({ kind: 'no_compiler', os: toHostOs(process.platform) });
    expect(fs.readdirSync(path.join(s.home, '.local/bin'))).toEqual([]);
  });

  it('a prebuilt that would not run falls through to the compiler', () => {
    const s = sandbox();
    // A fake cc that "builds" a working dtach at its -o path.
    s.fakeTool(s.bin, 'cc', 'while [ "$1" != "-o" ]; do shift; done; printf \'#!/bin/sh\\necho "dtach - version 0.9"\\n\' > "$2"; chmod 755 "$2"');
    const r = s.exec(buildInstallScript({ prebuilt: corrupt, cc: 'cc', sources: DTACH_SOURCES }));
    expect(r).toEqual({ kind: 'ok', source: 'built', path: path.join(s.home, '.local/bin/walnut-dtach') });
  });

  it('a script with neither a prebuilt nor a compiler says NO_COMPILER', () => {
    expect(sandbox().exec(buildInstallScript({ sources: DTACH_SOURCES }))).toMatchObject({ kind: 'no_compiler' });
  });

  it('the compile-only script ships no prebuilt heredoc', () => {
    expect(buildCompileScript('cc', DTACH_SOURCES)).not.toContain('WALNUT_DTACH_PREBUILT_EOF');
    expect(buildInstallScript({ prebuilt: fakeDtach, sources: DTACH_SOURCES })).not.toContain('master.c');
  });
});

// The real artifact from `bash scripts/build-dtach.sh`, when this checkout has one.
const REAL_PREBUILT_DIR = path.resolve(__dirname, '../../../dist/daemon-binaries');
const realPrebuilt = fs.existsSync(path.join(REAL_PREBUILT_DIR, `dtach-${process.platform}-${process.arch}`))
  ? path.join(REAL_PREBUILT_DIR, `dtach-${process.platform}-${process.arch}`) : null;

describe.skipIf(!realPrebuilt)('the built prebuilt through the install script (real sh, real binary)', () => {
  it('survives the base64 heredoc and runs at the cache path', async () => {
    expect(await findPrebuiltDtach(process.platform, process.arch, REAL_PREBUILT_DIR)).toBe(realPrebuilt);
    const s = sandbox();
    const bytes = fs.readFileSync(realPrebuilt!);
    const r = s.exec(buildInstallScript({ prebuilt: bytes, sources: DTACH_SOURCES }));
    const bin = path.join(s.home, '.local/bin/walnut-dtach');
    expect(r).toEqual({ kind: 'ok', source: 'prebuilt', path: bin });
    expect(fs.readFileSync(bin).equals(bytes)).toBe(true);
    const help = spawnSync(bin, ['--help'], { encoding: 'utf-8' });
    expect(help.stdout + help.stderr).toMatch(/dtach - version 0\.9/);
  });
});

describe('build script (real sh, real compiler)', () => {
  it.skipIf(!ccWorks)('build script compiles the vendored source with a real compiler', () => {
    const s = sandbox();
    fs.symlinkSync(realCc!, path.join(s.bin, 'cc'));
    // A real compile needs the toolchain's own helpers (ld, as) on PATH.
    const r = spawnSync('/bin/sh', ['-s'], {
      input: buildCompileScript('cc', DTACH_SOURCES),
      encoding: 'utf-8',
      env: { HOME: s.home, PATH: `${s.bin}:/usr/bin:/bin` },
      timeout: 60_000,
    });
    const out = classifyScriptRun({ code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr });
    expect(out).toEqual({ kind: 'ok', source: 'built', path: path.join(s.home, '.local/bin/walnut-dtach') });
  });
});
