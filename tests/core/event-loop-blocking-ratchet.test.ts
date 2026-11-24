/**
 * Event-loop blocking ratchet.
 *
 * The web server is single-threaded: ONE synchronous blocking call anywhere on
 * its event loop freezes EVERY route, including static index.html. Shipped
 * outages of exactly this shape:
 *  - 2026-08-11: a synchronous ScreenCaptureKit native call (getAudioApps) on
 *    the /api/audio/apps request path spun a CFRunLoop for minutes — the whole
 *    app "stuck on refresh".
 *  - 2026-07: gitPull via execSync blocked the loop mid-request.
 *
 * This test is a RATCHET, not a linter: every existing execSync/spawnSync call
 * site is grandfathered into the baseline below. Adding a NEW one fails the
 * quick tier with instructions. Removing one? Delete it from the baseline so
 * the ratchet only tightens.
 *
 * The rule (also in AGENTS.md → "Never block the web server's event loop"):
 * run blocking work in a child process/worker with a timeout and serve a
 * cached value — see refreshAppsInBackground in src/core/audio-capture.ts.
 * `setImmediate` does NOT count as a fix: deferred sync work still blocks.
 *
 * Files that never share the web server's event loop are exempt (workers/,
 * the daemon's child wrapper, CLI-only hooks) — listed in EXEMPT_PATHS.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonRuntimeText } from '../helpers/daemon-runtime-text.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Files whose code never runs on the web server's event loop. */
const EXEMPT_PATHS = [
  'src/workers/',            // separate child processes by design
  'src/providers/daemon-child-spawn.ts', // the daemon's child wrapper: it only forwards the daemon's own calls, counted where daemon-standalone.ts makes them
  // daemon-standalone.ts is NOT exempt: a server can run the daemon runtime on its own main
  // thread (experiment in_process_daemon, src/providers/in-process-daemon.ts).
  'src/hooks/on-stop.ts',    // Claude CLI hook — runs inside the CLI process
  'src/core/cloud-setup/steps.ts', // one-shot EC2 provisioning script path
];

/**
 * Grandfathered call-site budget per file (execSync + execFileSync + spawnSync occurrences).
 * DO NOT raise a number here — move the new call off the event loop instead
 * (child process + timeout + cached value). Lower/remove entries freely.
 */
const BASELINE: Record<string, number> = {
  'src/integrations/git-sync.ts': 3,
  'src/utils/process.ts': 1,
  'src/providers/daemon-core.ts': 2,
  // macOS only (Linux reads /proc): a pid's command line, and a stand-in's command line at an
  // update's handback. None runs on a clock.
  'src/providers/daemon-standalone.ts': 2,
  // macOS only (Linux reads /proc): `ps` for the process groups still running (the exit ladder).
  'src/providers/daemon-process-groups.ts': 1,
  'src/providers/host-runtime-core.ts': 2,
  'src/providers/session-io.ts': 1,
  'src/providers/pw-noactivate-core.ts': 1,
  'src/core/companion-build/shim.ts': 1,
  // Pre-listen startup guard. It runs ONCE in `walnut web` before the server
  // binds a port, so there is no request path and no route to freeze, and it
  // is advisory (it logs and continues, never exits).
  'src/providers/daemon-version-check.ts': 1,
  // The account's passwd entry under bun (whose os.userInfo() reads $USER/$HOME):
  // ONE cached child per process (`id -P` on macOS, `getent` only when /etc/passwd
  // lacks the uid on Linux), first asked by a boot guard or a rare user action.
  'src/lib/account.ts': 1,
};

function countSyncCalls(): Map<string, number> {
  // git grep is fast and respects the repo tree; -n gives one line per site.
  const out = execFileSync(
    'git',
    // POSIX ERE (git grep) has no \b; the call-shape `execSync(`/`spawnSync(`
    // is distinctive enough on its own.
    ['grep', '-nE', '(execSync|execFileSync|spawnSync) ?\\(', '--', 'src/'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const counts = new Map<string, number>();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const file = line.slice(0, line.indexOf(':'));
    if (file.endsWith('.d.ts')) continue;
    if (EXEMPT_PATHS.some((p) => file.startsWith(p) || file === p)) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

describe('event-loop blocking ratchet', () => {
  it('no NEW execSync/execFileSync/spawnSync call sites in server-reachable code', () => {
    const counts = countSyncCalls();
    const violations: string[] = [];
    for (const [file, count] of counts) {
      const allowed = BASELINE[file] ?? 0;
      if (count > allowed) {
        violations.push(
          `${file}: ${count} sync call site(s), baseline allows ${allowed}. `
          + 'Synchronous child_process calls block the web server\'s event loop '
          + '(every route freezes — see AGENTS.md "Never block the web server\'s event loop"). '
          + 'Use async exec/execFile/spawn with a timeout, or a child process + cached value.',
        );
      }
    }
    expect(violations, violations.join('\n\n')).toEqual([]);
  });

  it('baseline entries are still accurate (ratchet only tightens)', () => {
    const counts = countSyncCalls();
    const stale: string[] = [];
    for (const [file, allowed] of Object.entries(BASELINE)) {
      const actual = counts.get(file) ?? 0;
      if (actual < allowed) {
        stale.push(`${file}: baseline says ${allowed} but only ${actual} remain — lower the baseline to ${actual} to lock in the improvement.`);
      }
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('no withFileLockSync call in server-reachable code (its wait blocks the loop up to 10s)', () => {
    // The sync lock is for a process with no event loop to keep (a hook). On the server, a
    // contended store lock would hold every route for as long as the holder takes.
    let out = '';
    try {
      out = execFileSync(
        'git',
        ['grep', '-nE', 'withFileLockSync ?[(<]', '--', 'src/'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
    } catch {
      // git grep exits 1 on no matches.
    }
    const calls = out.split('\n').filter(Boolean)
      .filter((line) => !line.startsWith('src/utils/file-lock.ts:'))
      .filter((line) => !EXEMPT_PATHS.some((p) => line.startsWith(p)));
    expect(calls, `withFileLockSync on the server's event loop:\n${calls.join('\n')}\nUse withFileLock.`).toEqual([]);
  });

  // On macOS, starting an fs.watch holds the loop until the file-event stream is up: about half a
  // second per call on a loaded Mac (2026-11-24: 8.2 s of `watch (native)` in 8 kept boot stall
  // profiles, split between the notes watcher and the ~/.claude watch, which now polls). A file
  // Walnut only needs to notice changing polls its stat with fs.watchFile (config-file-watch.ts,
  // claude-settings-watcher.ts). The count per file may only fall.
  it('fs.watch call sites in server-reachable code do not grow (poll with fs.watchFile)', () => {
    const FS_WATCH_BASELINE: Record<string, number> = {
      'src/core/notes-watcher.ts': 2, // the vault and memory, recursive: nothing polls those
      'src/core/jsonl-tailer.ts': 1, // also polls every second
      'src/providers/acp-survive.ts': 1, // also polls
      'src/integrations/mail/sort-rules-file.ts': 1,
    };
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-nE', 'fs\\.watch ?\\(', '--', 'src/'], { cwd: repoRoot, encoding: 'utf8' });
    } catch {
      // git grep exits 1 on no matches.
    }
    const counts = new Map<string, number>();
    for (const line of out.split('\n').filter(Boolean)) {
      const file = line.slice(0, line.indexOf(':'));
      if (EXEMPT_PATHS.some((p) => file.startsWith(p))) continue;
      if (/^\S+:\d+:\s*(\*|\/\/)/.test(line)) continue; // a comment naming it
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    const problems: string[] = [];
    for (const [file, n] of counts) {
      const allowed = FS_WATCH_BASELINE[file] ?? 0;
      if (n > allowed) problems.push(`${file}: ${n} fs.watch call(s), baseline ${allowed}. Poll the file with fs.watchFile instead (config-file-watch.ts).`);
    }
    for (const [file, allowed] of Object.entries(FS_WATCH_BASELINE)) {
      const n = counts.get(file) ?? 0;
      if (n < allowed) problems.push(`${file}: baseline says ${allowed} fs.watch call(s) but ${n} remain: lower it to ${n}.`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('native ScreenCaptureKit calls stay off the request path (child-process only)', () => {
    // The addon may only be touched inside audio-capture.ts, and its two
    // event-loop-hazard methods (getAudioApps / verifyPermissions) may only
    // appear inside spawned child scripts or the recording start path — never
    // as a direct call in a route-reachable method. Guard: the strings must
    // not appear anywhere in src/ outside audio-capture.ts.
    let out = '';
    try {
      out = execFileSync(
        'git',
        ['grep', '-lE', 'getAudioApps|verifyPermissions', '--', 'src/'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
    } catch {
      // git grep exits 1 on no matches — that's fine (fully removed).
    }
    const files = out.split('\n').filter(Boolean);
    expect(files.every((f) => f === 'src/core/audio-capture.ts'),
      `ScreenCaptureKit native methods referenced outside src/core/audio-capture.ts: ${files.join(', ')}`,
    ).toBe(true);
  });

  // The daemon runtime can run on the server's own thread (experiment in_process_daemon): its
  // synchronous file reads and sleeps hold every route there too. Counted for daemon-standalone.ts
  // only; the number may only fall (review S5, 2026-11-21: boot adoption re-folds a stream with
  // readSync, the isolated-dir reap sleeps with Atomics.wait).
  it('daemon-standalone.ts: readSync and Atomics.wait call sites do not grow', async () => {
    // The whole runtime: daemon-standalone.ts and its area modules (daemon-process-groups.ts sleeps the exit ladder).
    const text = daemonRuntimeText();
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    expect(count(/\breadSync\(/g), 'a new readSync( in daemon-standalone.ts: read asynchronously (fs.promises / the tailer)').toBeLessThanOrEqual(9);
    expect(count(/\bAtomics\.wait\(/g), 'a new Atomics.wait( in daemon-standalone.ts: wait with a timer').toBeLessThanOrEqual(2);
  });

  // 2026-11-22 (land 2 step 7): the registry's durable writes and the daemon log moved off the
  // thread (registry-writer-core.ts, log-appender-core.ts). Only their one exit-path sync write
  // stays, inside those cores; the runtime itself may not fsync or append synchronously again.
  it('daemon runtime: no synchronous fsync, and appendFileSync call sites do not grow', async () => {
    const fs = await import('node:fs');
    const read = (f: string) => fs.readFileSync(path.join(repoRoot, f), 'utf8');
    const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
    for (const f of ['src/providers/daemon-core.ts', 'src/providers/daemon-standalone.ts']) {
      const text = f === 'src/providers/daemon-standalone.ts' ? daemonRuntimeText() : read(f);
      expect(count(text, /\bfsyncSync\(/g), `${f}: a synchronous fsync on the thread; write through registry-writer-core.ts`).toBe(0);
    }
    expect(count(daemonRuntimeText(), /\bappendFileSync\(/g), 'a new appendFileSync( in daemon-standalone.ts: append through log-appender-core.ts or fs.promises').toBeLessThanOrEqual(4);
  });
});
