/**
 * Git-compaction worker — runs the tiered history compaction in a CHILD
 * process, forked by the server (see startGitAutoCommit in web/server.ts).
 *
 * Why a worker: compaction is built on synchronous git calls (execSync), and
 * the first run on a neglected repo takes minutes (303s measured on the real
 * 89k-commit data repo). In the server process that would freeze the event
 * loop — every HTTP request, WS message, and session stream — for the whole
 * duration. In a fork it costs one core and nothing else.
 *
 * Protocol: parent forks with no args; worker runs runScheduledCompaction(),
 * reports { ok, result?, error? } via process.send, exits 0/1. Lock
 * coordination with the parent's 30s sync tick still works because
 * compactionInProgress is advisory — the real guard is git's own index.lock
 * plus the parent's isLockContention retry.
 */
import { initLogging, log } from '../logging/index.js';
import { runScheduledCompaction } from '../integrations/git-compaction.js';

initLogging();

try {
  // async since the bundle-fallback push (T65) — the worker is a dedicated
  // child process, so awaiting here blocks nobody.
  const result = await runScheduledCompaction();
  if (process.connected) process.send?.({ ok: true, result });
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  log.git.warn('compaction worker failed', { error: message });
  if (process.connected) process.send?.({ ok: false, error: message });
  process.exit(1);
}
