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
  return throwawayServerReason()
}

/**
 * Why this process is not the user's real Walnut (a test runner, an ephemeral or temp-home server),
 * or null when it is. The one test both outward opt-ins read: task sync above, and the topics mail
 * bridge (core/topics/topic-mail.ts, WALNUT_TOPICS_MAIL_IN_TEST=1), since an ephemeral copy of the
 * user's data holds his real mail accounts and real people.
 */
export function throwawayServerReason(): string | null {
  const copy = dataCopyReason()
  if (copy) return copy
  if (process.argv.includes('--_ephemeral-child')) return 'an ephemeral server'
  if (process.env.VITEST || process.env.VITEST_WORKER_ID) return 'test runner (VITEST)'
  if (process.env.NODE_ENV === 'test') return 'NODE_ENV=test'
  if (isUnderTempDir(WALNUT_HOME)) return `data dir under the OS temp dir (${WALNUT_HOME})`
  return null
}

/**
 * The file the ephemeral launcher writes into every snapshot of the person's data
 * (commands/web-ephemeral.ts): whatever later serves that directory, and however it is
 * started, it is a copy and never writes to his accounts (accountIsolationReason).
 */
export const DATA_COPY_MARKER = 'data-copy.json'

/**
 * argv flag of a server whose home is its own, never a copy of the person's data: a test fixture
 * server (tests/e2e/browser/*-server.ts, fake mail and calendar providers), the Demo, the sandbox
 * (scripts/walnut-sandbox.sh). Its account doors stay open for the accounts made or signed in
 * there. On argv, never in the environment, so nothing it starts inherits it.
 */
export const OWN_ACCOUNTS_FLAG = '--_own-accounts'

/**
 * Why this server must never write to an account outside it (mail read flags, moves, sends,
 * calendar events, pushes, trackers, a plugin's writes, MCP writes, the data repo, the companion),
 * or null when it may. Read once at boot (web/server.ts closes the account doors with it,
 * core/leader/switch/doors.ts closeAccountDoors). First match wins:
 *   1. a snapshot of the person's data (DATA_COPY_MARKER in the home): always a copy;
 *   2. a server on a home of its own (OWN_ACCOUNTS_FLAG: fixtures, the Demo, the sandbox);
 *   3. an ephemeral server (--_ephemeral-child): it runs on a copy of the person's data.
 * Anything else is not taken for a copy: a test runner's or a test cluster's server on a home it made
 * under the temp dir holds fake accounts (plugin sync stays off there by remoteSyncIsolationReason),
 * and a copy of the data dir made by hand is served with `bun run dev:ephemeral`, which marks it.
 * 2026-11-27: an ephemeral server's Mail page marked the person's real Gmail messages read when a
 * test script opened them.
 */
export function accountIsolationReason(): string | null {
  const copy = dataCopyReason()
  if (copy) return copy
  if (process.argv.includes(OWN_ACCOUNTS_FLAG)) return null
  if (process.argv.includes('--_ephemeral-child')) return 'an ephemeral server'
  return null
}

/**
 * Why this home is a snapshot of the person's data (DATA_COPY_MARKER), or null. Every "is this the
 * person's real Walnut" test reads it first, so no fixture flag or test opt-in reopens a snapshot:
 * account doors, the topics mail bridge and plugin jobs (plugin-jobs/index.ts). The one exception
 * is task sync's documented end-to-end test, WALNUT_ALLOW_REMOTE_SYNC_IN_TEST=1, which opens that
 * door alone (web/server.ts).
 */
export function dataCopyReason(home: string = WALNUT_HOME): string | null {
  try {
    return fs.existsSync(path.join(home, DATA_COPY_MARKER)) ? `a copy of your Walnut data at ${home}` : null
  } catch {
    return null
  }
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
