/**
 * Remote-sync test isolation — the one predicate that answers "may this process
 * write to the user's REAL provider account?".
 *
 * Deliberately its own module rather than a constants.ts export: ~400 test files
 * mock src/constants.js with a fixed object, and vitest throws on an unmocked
 * named export of a mocked module — a predicate living there would have to be
 * re-declared in every one of them. Only WALNUT_HOME is imported (mocked to a
 * temp dir in tests, which is exactly the signal this file reads).
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WALNUT_HOME } from '../constants.js';

/**
 * Why this server must NOT activate a plugin that writes to the user's real
 * provider account — or null when it may.
 *
 * The 2026-09-02 leak: a temp-home test server copied the user's REAL
 * config.yaml (for its `hosts` block) and thereby handed its sync plugins the
 * user's live provider credentials. A fixture task created against that server
 * was pushed to the user's actual account, which created a remote list there;
 * days later a full reconcile on the PRODUCTION server pulled that list back and
 * re-created a project the user had deleted, with the fixture task inside it.
 * Nothing in the plugin loader refused remote writes from a throwaway server.
 *
 * Two signals, both meaning "this process is not the user's real Walnut":
 *   - a test runner (VITEST / NODE_ENV=test), and
 *   - a data directory under the OS temp dir (ephemeral servers, temp-home
 *     fixtures) — which is never where production data lives.
 *
 * Escape hatch for deliberately testing a real integration end to end:
 * WALNUT_ALLOW_REMOTE_SYNC_IN_TEST=1.
 */
export function remoteSyncIsolationReason(): string | null {
  if (process.env.WALNUT_ALLOW_REMOTE_SYNC_IN_TEST === '1') return null
  if (process.env.VITEST || process.env.VITEST_WORKER_ID) return 'test runner (VITEST)'
  if (process.env.NODE_ENV === 'test') return 'NODE_ENV=test'
  if (isUnderTempDir(WALNUT_HOME)) return `data dir under the OS temp dir (${WALNUT_HOME})`
  return null
}

/**
 * Is `inputPath` inside the OS temp dir (or /tmp)? Symlink-aware: on macOS
 * os.tmpdir() is /var/folders/… while /tmp → /private/tmp, so a literal prefix
 * test alone misses half the real paths.
 */
function isUnderTempDir(inputPath: string): boolean {
  const roots = new Set<string>()
  const add = (p: string) => {
    roots.add(path.resolve(p))
    try { roots.add(fs.realpathSync(p)) } catch { /* best-effort */ }
  }
  add(os.tmpdir())
  add('/tmp')
  const candidates = new Set<string>([path.resolve(inputPath)])
  try { candidates.add(fs.realpathSync(inputPath)) } catch { /* path may not exist yet */ }
  for (const candidate of candidates) {
    for (const root of roots) {
      if (candidate === root || candidate.startsWith(root + path.sep)) return true
    }
  }
  return false
}
