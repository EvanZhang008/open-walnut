/**
 * Two Walnut processes installing the same component into one data home (two
 * servers, the CLI next to the server): real child processes against a real
 * local HTTP server. One downloads while the other waits; and a holder that
 * was paused past the lock's stale limit (a sleeping Mac) never writes over
 * the install that took over from it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { MARKER } from '../../../src/core/components/paths.js';
import { fakeComponent, startReleaseServer, tmpDir, type ReleaseServer } from './helpers.js';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const CHILD = path.join(import.meta.dirname, 'install-child.ts');
const PLATFORM = 'linux-x64' as const;
let srv: ReleaseServer;

beforeAll(async () => { srv = await startReleaseServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { srv.requests.length = 0; });

type Line = { phase?: string; done?: string; error?: string; code?: string };

interface Child {
  proc: ChildProcess;
  lines: Line[];
  /** The first line (seen or to come) that matches. */
  next(match: (l: Line) => boolean, ms?: number): Promise<Line>;
  exit: Promise<number | null>;
}

function startChild(job: object): Child {
  // This file's runtime: bun runs the TypeScript as is.
  const execArgv: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env, INSTALL_CHILD: JSON.stringify(job), WALNUT_COMPONENTS_BASE_URL: srv.base, OPEN_WALNUT_HOME: tmpDir('walnut-comp-child-home-'),
  };
  const proc = spawn(process.execPath, [...execArgv, CHILD], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'inherit'] });
  const lines: Line[] = [];
  const waiters: Array<{ match: (l: Line) => boolean; resolve: (l: Line) => void }> = [];
  createInterface({ input: proc.stdout! }).on('line', (raw) => {
    let l: Line;
    try { l = JSON.parse(raw) as Line; } catch { return; }
    lines.push(l);
    for (const w of [...waiters]) if (w.match(l)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(l); }
  });
  const exit = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  return {
    proc, lines, exit,
    next: (match, ms = 30_000) => new Promise<Line>((resolve, reject) => {
      const seen = lines.find(match);
      if (seen) { resolve(seen); return; }
      const t = setTimeout(() => reject(new Error(`no matching line in ${ms} ms; got ${JSON.stringify(lines)}`)), ms);
      waiters.push({ match, resolve: (l) => { clearTimeout(t); resolve(l); } });
    }),
  };
}

const asked = (asset: string) => srv.requests.filter((r) => r.url.endsWith(asset)).length;

describe('two processes, one data home', () => {
  it('one downloads, the other says it is waiting and then finds the same install', async () => {
    const c = fakeComponent('images', PLATFORM, { padBytes: 600_000 });
    srv.serve(c.entry.asset, c.archive);
    srv.fault(c.entry.asset, { chunkDelayMs: 20 });
    const root = tmpDir();
    const job = { name: 'images', root, platform: PLATFORM, manifest: c.manifest, options: { backoffMs: 20, lock: { pollMs: 20 } } };
    const a = startChild(job);
    await a.next((l) => l.phase === 'downloading');
    const b = startChild(job);
    const [ra, rb] = await Promise.all([a.next((l) => !!l.done || !!l.error), b.next((l) => !!l.done || !!l.error)]);
    expect([ra.error, rb.error]).toEqual([undefined, undefined]);
    expect(ra.done).toBe(path.join(root, 'images', '1.0.0-1', PLATFORM));
    expect(rb.done).toBe(ra.done);
    expect(b.lines.map((l) => l.phase)).toContain('waiting');
    expect(b.lines.map((l) => l.phase)).not.toContain('downloading');
    expect(asked(c.entry.asset)).toBe(1);
    expect(await a.exit).toBe(0);
    expect(await b.exit).toBe(0);
    expect(fs.readdirSync(path.join(root, '.downloads'))).toEqual([]);
    expect(fs.existsSync(path.join(root, '.locks', 'images.lock'))).toBe(false);
  }, 60_000);

  it('a holder paused past the stale limit loses the lock, and never publishes over the one that took over', async () => {
    const c = fakeComponent('images', PLATFORM, { padBytes: 600_000 });
    srv.serve(c.entry.asset, c.archive);
    // The paused holder's download is slow; the one that takes over gets a fast one.
    srv.fault(c.entry.asset, { chunkDelayMs: 30 });
    const root = tmpDir();
    const lock = { staleMs: 600, heartbeatMs: 100, pollMs: 20 };
    const job = { name: 'images', root, platform: PLATFORM, manifest: c.manifest, options: { backoffMs: 20, idleTimeoutMs: 5_000, lock } };
    const a = startChild(job);
    await a.next((l) => l.phase === 'downloading');
    // A sleeping Mac: the process lives, but runs nothing (this test's own child).
    a.proc.kill('SIGSTOP');
    try {
      const b = startChild(job);
      const rb = await b.next((l) => !!l.done || !!l.error);
      expect(rb.error).toBeUndefined();
      expect(rb.done).toBe(path.join(root, 'images', '1.0.0-1', PLATFORM));
      expect(await b.exit).toBe(0);
      const markerAfterB = fs.readFileSync(path.join(rb.done!, MARKER), 'utf8');
      const inodeAfterB = fs.statSync(rb.done!).ino;

      a.proc.kill('SIGCONT');
      const ra = await a.next((l) => !!l.done || !!l.error);
      expect(ra.error).toBeUndefined();
      // It finds the install the other one made, and leaves it as it was.
      expect(ra.done).toBe(rb.done);
      expect(await a.exit).toBe(0);
      expect(fs.readFileSync(path.join(rb.done!, MARKER), 'utf8')).toBe(markerAfterB);
      expect(fs.statSync(rb.done!).ino).toBe(inodeAfterB);
      expect(fs.readdirSync(path.join(root, 'images', '1.0.0-1'))).toEqual([PLATFORM]);
      expect(fs.readdirSync(path.join(root, '.downloads'))).toEqual([]);
    } finally {
      if (a.proc.exitCode === null) { a.proc.kill('SIGCONT'); a.proc.kill('SIGTERM'); }
    }
  }, 60_000);
});
