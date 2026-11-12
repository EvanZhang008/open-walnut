/**
 * desktop/apply-update.sh: the step after the Mac app quits to update (what
 * Squirrel's ShipIt does). It waits for the app's pid, swaps the
 * staged new app into place with two renames and opens it; any failure puts the
 * old app back and opens that. Run for real on temp dirs with a stub opener.
 * And the two build scripts ship it and compile the updater, so a release app
 * can always finish what it starts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { swiftCompiles } from '../helpers/swift-compiles.js';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'desktop/apply-update.sh');
const dirs: string[] = [];

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-update-'));
  dirs.push(dir);
  const target = path.join(dir, 'Apps', 'Walnut.app');
  const staged = path.join(dir, 'Apps', '.Walnut-1.1.0.app');
  fs.mkdirSync(path.join(target, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(target, 'Contents', 'version'), '1.0.0');
  fs.mkdirSync(path.join(staged, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(staged, 'Contents', 'version'), '1.1.0');
  const opened = path.join(dir, 'opened.txt');
  const opener = path.join(dir, 'open.sh');
  fs.writeFileSync(opener, `#!/bin/sh\necho "$*" >> "${opened}"\n`, { mode: 0o755 });
  const log = path.join(dir, 'apply.log');
  return { dir, target, staged, opened, opener, log };
}

// Async on purpose: a blocked event loop never reaps the stand-in app, and a
// zombie still answers kill -0, so a sync run would wait out the full minute.
function run(args: string[], env: Record<string, string> = {}): Promise<{ status: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: 'ignore' });
    child.on('exit', (status) => resolve({ status }));
  });
}

const started: number[] = [];

afterEach(() => {
  for (const p of started.splice(0)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A stand-in for `Walnut --session-host -- <program>`: what ps shows is the real host's
 * command line (bash's `exec -a`), and like the real host it has an inner generation
 * below it (a sleep under the same command line). On SIGTERM the outer one records
 * which app version is in place at that moment, then ends the inner one.
 */
function standInHost(dir: string, commandLine: string, marker: string, versionFile: string): Promise<void> {
  const inner = path.join(dir, `host-${started.length}.sh`);
  fs.writeFileSync(inner, [
    'marker="$1"; name="$2"; version="$3"',
    'trap \'cat "$version" >> "$marker" 2>/dev/null || echo gone >> "$marker"; kill "$c" 2>/dev/null; exit 0\' TERM',
    '( exec -a "$name" /bin/sleep 300 ) & c=$!',
    'wait',
    '',
  ].join('\n'));
  const child = spawn('/bin/bash', ['-c', 'exec -a "$1" /bin/bash "$2" "$3" "$1" "$4"', 'x', commandLine, inner, marker, versionFile],
    { stdio: 'ignore', detached: true });
  child.unref();
  started.push(child.pid!);
  // Ready once the inner generation shows up under the outer one.
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      const ps = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
      if (ps.split('\n').some((l) => l.trim().split(/\s+/)[1] === String(child.pid) && l.includes(commandLine))) return resolve();
      if (Date.now() > deadline) return reject(new Error('stand-in host did not start'));
      setTimeout(poll, 50);
    };
    poll();
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('apply-update.sh', () => {
  it('waits for the app to quit, swaps in the new app, removes the old one and opens it', async () => {
    const s = scratch();
    const app = spawn('/bin/sleep', ['0.6']);
    const started = Date.now();
    const r = await run([String(app.pid), s.target, s.staged, s.log], { WALNUT_APPLY_UPDATE_OPEN: s.opener });
    expect(r.status).toBe(0);
    // It did not swap while the app was still running.
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(fs.readFileSync(path.join(s.target, 'Contents', 'version'), 'utf8')).toBe('1.1.0');
    expect(fs.existsSync(s.staged)).toBe(false);
    expect(fs.readdirSync(path.dirname(s.target))).toEqual(['Walnut.app']);
    expect(fs.readFileSync(s.opened, 'utf8').trim()).toBe(s.target);
    expect(fs.readFileSync(s.log, 'utf8')).toContain('updated');
  });

  it('leaves everything in place when the app never quits', async () => {
    const s = scratch();
    const app = spawn('/bin/sleep', ['30']);
    try {
      const r = await run([String(app.pid), s.target, s.staged, s.log], { WALNUT_APPLY_UPDATE_OPEN: s.opener, WALNUT_APPLY_UPDATE_WAIT_TICKS: '3' });
      expect(r.status).toBe(1);
      expect(fs.readFileSync(path.join(s.target, 'Contents', 'version'), 'utf8')).toBe('1.0.0');
      expect(fs.existsSync(s.staged)).toBe(true);
      // The old app is still running, so nothing is opened.
      expect(fs.existsSync(s.opened)).toBe(false);
      expect(fs.readFileSync(s.log, 'utf8')).toContain('still running');
    } finally {
      app.kill();
    }
  });

  it('puts the old app back and opens it when the new one cannot move in', async () => {
    const s = scratch();
    // The staged copy disappears between the check and the swap: simulate with a
    // staged path whose parent is read-only for the rename.
    const blocked = path.join(s.dir, 'ro');
    fs.mkdirSync(path.join(blocked, '.Walnut-1.1.0.app'), { recursive: true });
    fs.chmodSync(blocked, 0o555);
    try {
      const r = await run(['999999', s.target, path.join(blocked, '.Walnut-1.1.0.app'), s.log], { WALNUT_APPLY_UPDATE_OPEN: s.opener });
      expect(r.status).toBe(1);
      expect(fs.readFileSync(path.join(s.target, 'Contents', 'version'), 'utf8')).toBe('1.0.0');
      expect(fs.readdirSync(path.dirname(s.target))).toContain('Walnut.app');
      expect(fs.readdirSync(path.dirname(s.target)).filter((n) => n.includes('previous'))).toEqual([]);
      expect(fs.readFileSync(s.opened, 'utf8').trim()).toBe(s.target);
    } finally {
      fs.chmodSync(blocked, 0o755);
    }
  });

  // 2026-11-12: session hosts kept running from the old app after a swap, so macOS asked
  // for Local Network access as that copy. They end only once the new app is in place, so
  // what starts them again (the server, launchd) starts them from the new app.
  it('ends the session hosts of the old app once the new app is in place, and no others', async () => {
    const s = scratch();
    const exe = path.join(s.target, 'Contents', 'MacOS', 'Walnut');
    const version = path.join(s.target, 'Contents', 'version');
    const mine = path.join(s.dir, 'mine.txt');
    const other = path.join(s.dir, 'other.txt');
    await standInHost(s.dir, `${exe} --session-host -- /stage/walnut __daemon --start`, mine, version);
    const outer = started[started.length - 1]!;
    await standInHost(s.dir, `${path.join(s.dir, 'Other', 'Walnut.app', 'Contents', 'MacOS', 'Walnut')} --session-host -- /x`, other, version);
    const decoy = started[started.length - 1]!;
    const r = await run(['999999', s.target, s.staged, s.log], { WALNUT_APPLY_UPDATE_OPEN: s.opener });
    expect(r.status).toBe(0);
    // Signalled once (the outer generation), after the swap.
    expect(fs.readFileSync(mine, 'utf8').trim()).toBe('1.1.0');
    expect(alive(outer)).toBe(false);
    expect(fs.existsSync(other)).toBe(false);
    expect(alive(decoy)).toBe(true);
    expect(fs.readdirSync(path.dirname(s.target))).toEqual(['Walnut.app']);
    expect(fs.readFileSync(s.log, 'utf8')).toContain(`ending the session hosts of the old app: ${outer}`);
  });

  it('removes an old app an earlier run left beside the new one', async () => {
    const s = scratch();
    const left = path.join(path.dirname(s.target), 'Walnut.previous-999999.app');
    fs.mkdirSync(path.join(left, 'Contents'), { recursive: true });
    const r = await run(['999999', s.target, s.staged, s.log], { WALNUT_APPLY_UPDATE_OPEN: s.opener });
    expect(r.status).toBe(0);
    expect(fs.readdirSync(path.dirname(s.target))).toEqual(['Walnut.app']);
  });

  // How a build you made goes in place (desktop/README.md): no app to wait for.
  it('with pid 0 refuses while the app runs, and otherwise swaps and opens it in the background', async () => {
    const s = scratch();
    const exe = path.join(s.target, 'Contents', 'MacOS', 'Walnut');
    const gui = spawn('/bin/bash', ['-c', 'exec -a "$1" /bin/sleep 300', 'x', exe], { stdio: 'ignore' });
    started.push(gui.pid!);
    for (let i = 0; i < 100 && !spawnSync('ps', ['-o', 'command=', '-p', String(gui.pid)], { encoding: 'utf8' }).stdout.startsWith(exe); i++) {
      await new Promise((ok) => setTimeout(ok, 50));
    }
    expect((await run(['0', s.target, s.staged, s.log], { WALNUT_APPLY_UPDATE_OPEN: s.opener })).status).toBe(1);
    expect(fs.readFileSync(path.join(s.target, 'Contents', 'version'), 'utf8')).toBe('1.0.0');
    expect(fs.readFileSync(s.log, 'utf8')).toContain('quit it first');
    gui.kill('SIGKILL');
    await new Promise((ok) => gui.once('exit', ok));
    expect((await run(['0', s.target, s.staged, s.log], { WALNUT_APPLY_UPDATE_OPEN: s.opener })).status).toBe(0);
    expect(fs.readFileSync(path.join(s.target, 'Contents', 'version'), 'utf8')).toBe('1.1.0');
    expect(fs.readFileSync(s.opened, 'utf8').trim()).toBe(`-g ${s.target}`);
  });

  it('refuses bad arguments without touching anything', async () => {
    const s = scratch();
    expect((await run(['not-a-pid', s.target, s.staged, s.log])).status).toBe(2);
    expect((await run(['1', path.join(s.dir, 'not-an-app'), s.staged, s.log])).status).toBe(2);
    expect((await run(['1', s.target, path.join(s.dir, 'missing.app'), s.log])).status).toBe(2);
    expect((await run([])).status).toBe(2);
    expect(fs.readFileSync(path.join(s.target, 'Contents', 'version'), 'utf8')).toBe('1.0.0');
  });
});

describe('the build scripts ship the updater', () => {
  for (const script of ['desktop/build.sh', 'desktop/build-release.sh']) {
    it(`${script} compiles the updater and copies apply-update.sh`, () => {
      const text = fs.readFileSync(path.join(ROOT, script), 'utf8');
      for (const file of ['AppUpdateMachine.swift', 'AppUpdater.swift', 'AppUpdateBridge.swift']) {
        const compiles = swiftCompiles(text);
        expect(compiles.length).toBeGreaterThan(0);
        for (const c of compiles) expect(c).toContain(file);
      }
      expect(text).toContain('-framework Security');
      expect(text).toContain('cp "$SCRIPT_DIR/apply-update.sh" "$RESOURCES/apply-update.sh"');
    });
  }

  it('a release app names its update feed, a local build does not', () => {
    const release = fs.readFileSync(path.join(ROOT, 'desktop/build-release.sh'), 'utf8');
    expect(release).toContain('<key>WalnutUpdateFeed</key>');
    expect(release).toContain('https://github.com/EvanZhang008/open-walnut/releases');
    expect(fs.readFileSync(path.join(ROOT, 'desktop/build.sh'), 'utf8')).not.toContain('WalnutUpdateFeed');
  });

  it('scripts/test-desktop.sh runs the update tests', () => {
    expect(fs.readFileSync(path.join(ROOT, 'scripts/test-desktop.sh'), 'utf8')).toContain('tests/desktop/app-update-tests.swift');
  });
});
