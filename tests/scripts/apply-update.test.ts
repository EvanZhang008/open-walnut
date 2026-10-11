/**
 * desktop/apply-update.sh: the step after the Mac app quits to update (T3 Code's
 * quitAndInstall, Squirrel's ShipIt). It waits for the app's pid, swaps the
 * staged new app into place with two renames and opens it; any failure puts the
 * old app back and opens that. Run for real on temp dirs with a stub opener.
 * And the two build scripts ship it and compile the updater, so a release app
 * can always finish what it starts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  fs.writeFileSync(opener, `#!/bin/sh\necho "$1" >> "${opened}"\n`, { mode: 0o755 });
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

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

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

  it('refuses bad arguments without touching anything', async () => {
    const s = scratch();
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
        const compiles = text.split('swiftc ').slice(1);
        expect(compiles.length).toBeGreaterThan(0);
        for (const c of compiles) expect(c.slice(0, c.indexOf('-framework'))).toContain(file);
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
