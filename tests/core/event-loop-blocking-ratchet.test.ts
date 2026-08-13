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
 * the daemon twins, CLI-only hooks) — listed in EXEMPT_PATHS.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Files whose code never runs on the web server's event loop. */
const EXEMPT_PATHS = [
  'src/workers/',            // separate child processes by design
  'src/providers/daemon-standalone.ts', // daemon twin — its own process on exec hosts
  'src/providers/daemon-source.ts',     // daemon twin (JS fallback)
  'src/hooks/on-stop.ts',    // Claude CLI hook — runs inside the CLI process
  'src/core/cloud-setup/steps.ts', // one-shot EC2 provisioning script path
];

/**
 * Grandfathered call-site budget per file (execSync + spawnSync occurrences).
 * DO NOT raise a number here — move the new call off the event loop instead
 * (child process + timeout + cached value). Lower/remove entries freely.
 */
const BASELINE: Record<string, number> = {
  'src/integrations/tmux.ts': 11,
  'src/integrations/git-sync.ts': 3,
  'src/utils/process.ts': 1,
  'src/providers/daemon-core.ts': 1,
  'src/providers/daemon-version-check.ts': 1,
};

function countSyncCalls(): Map<string, number> {
  // git grep is fast and respects the repo tree; -n gives one line per site.
  const out = execFileSync(
    'git',
    // POSIX ERE (git grep) has no \b; the call-shape `execSync(`/`spawnSync(`
    // is distinctive enough on its own.
    ['grep', '-nE', '(execSync|spawnSync) ?\\(', '--', 'src/'],
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
  it('no NEW execSync/spawnSync call sites in server-reachable code', () => {
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
});
