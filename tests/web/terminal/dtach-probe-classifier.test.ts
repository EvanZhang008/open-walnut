import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BEGIN_MARKER,
  buildCompileScript,
  buildProbeScript,
  classifyScriptRun,
  toHostOs,
} from '../../../src/web/terminal/dtach-probe-script.js';
import { decideTerminalMode } from '../../../src/web/terminal/dtach-check.js';
import { DTACH_SOURCES } from '../../../src/web/terminal/dtach-sources.js';

/**
 * The dtach probe classifier decides whether a terminal opens persistent, as a
 * plain shell, or not at all. The bug it guards: ssh failures (empty stdout)
 * used to be reported as "no C compiler", so the UI told users with a broken
 * ssh key to install gcc. Captured outputs below mirror what `ssh host sh -s`
 * really prints for each case.
 */
const run = (stdout: string, stderr = '', code = 0, timedOut = false) => ({ stdout, stderr, code, timedOut });
/** What the scripts print first: the marker, then `uname -s`. */
const LINUX = `${BEGIN_MARKER}\nOS:Linux\n`;
const DARWIN = `${BEGIN_MARKER}\nOS:Darwin\n`;

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
    expect(classifyScriptRun(run(`${BEGIN_MARKER}\nOS:FreeBSD\nNO_COMPILER\n`))).toEqual({ kind: 'no_compiler', os: 'unknown' });
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
  for (const tool of ['grep', 'dirname', 'mkdir', 'mktemp', 'base64', 'printf', 'rm', 'mv', 'uname']) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim();
    if (found.startsWith('/')) fs.symlinkSync(found, path.join(bin, tool));
  }
  const exec = (script: string) => {
    const r = spawnSync('/bin/sh', ['-s'], { input: script, encoding: 'utf-8', env: { HOME: home, PATH: bin }, timeout: 30_000 });
    return classifyScriptRun({ code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' });
  };
  const fakeTool = (dir: string, name: string, body: string) => {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };
  return { home, bin, exec, fakeTool };
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
