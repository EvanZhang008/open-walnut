/**
 * Delivering a compacted chain to the hub (step 7 of compactGitHistory).
 *
 * The rewritten chain shares no COMMIT with the hub, but every kept commit
 * points at a tree the hub already holds (commit-tree reuses each original
 * commit's tree). Neither `git push` nor a bundle with `^<hub head>` sees that:
 * both negotiate by commit ancestry, so they ship every blob again, the whole
 * multi-GB repo. 2026-11-25: that bundle passed the hub's 4 GB budget (HTTP
 * 413) and compaction failed every day while the repo kept growing.
 *
 * So on a Walnut hub the chain goes through the chunked bundle channel with
 * each kept commit's tree marked as already there (`remoteHas`): the bundle
 * carries the new commit objects plus whatever only this machine has (commits
 * after the hub's head), a few KB to MB. The hub's fetch checks connectivity,
 * and its ref update is a CAS on the pre-rewrite head, so a hub that moved or
 * lacks a tree refuses the swap and compaction rolls back.
 *
 * A remote with no bundle channel (a plain git server, a path, an http remote
 * whose /bundle/start is not there) gets the force push with lease, as before.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bundleEndpointFromRemote, pushViaBundle } from './git-bundle-client.js';
import { gitSafe, gitSafeAsync } from './git-sync.js';
import { gitChildEnv } from '../lib/git-env.js';
import { log } from '../logging/index.js';

const execFileAsync = promisify(execFile);

export type DeliveryResult = { ok: true; via: 'bundle' | 'push' } | { ok: false; error: string };

/** The remote answered start as something that is not a Walnut hub's bundle channel. */
function noBundleChannel(error: string): boolean {
  return /^start: HTTP (404|405|501)\b/.test(error) || /JSON/.test(error);
}

/**
 * Trees of kept commits that the hub holds: every kept commit reachable from
 * the hub's head. Commits after that head exist only here; their trees ship.
 * null when that cannot be read (the caller then claims nothing).
 */
export async function keptTreesOnHub(repoDir: string, keptHashes: string[], oldMain: string, remoteHead: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-list', `${remoteHead}..${oldMain}`], {
      cwd: repoDir, encoding: 'utf-8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024, env: gitChildEnv(undefined, process.env, repoDir),
    });
    const localOnly = new Set(stdout.split('\n').filter(Boolean));
    return keptHashes.filter((h) => !localOnly.has(h)).map((h) => `${h}^{tree}`);
  } catch (err) {
    log.git.warn('compaction: cannot tell which commits the hub holds, sending a complete bundle', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function pushWithLease(repoDir: string, remoteHead: string | null): Promise<DeliveryResult> {
  // Pinned to the pre-rewrite head: if anything was pushed since the fetch,
  // the lease fails instead of destroying it. 120s: a full history upload.
  const lease = remoteHead ? `--force-with-lease=refs/heads/main:${remoteHead}` : '--force-with-lease';
  if (await gitSafeAsync(`push ${lease} origin main`, { cwd: repoDir, timeout: 120_000 }) === null) {
    return { ok: false, error: 'push rejected or timed out' };
  }
  return { ok: true, via: 'push' };
}

export async function deliverCompactedChain(opts: {
  repoDir: string;
  /** Original hashes of the commits the new chain keeps (their trees are reused). */
  keptHashes: string[];
  /** The pre-rewrite main (the backup branch). */
  oldMain: string;
  /** The new main. */
  newHead: string;
  /** The hub's head fetched before the rewrite; null for an empty hub. */
  remoteHead: string | null;
}): Promise<DeliveryResult> {
  const { repoDir, remoteHead } = opts;
  const cwd = { cwd: repoDir };
  const remoteUrl = gitSafe('remote get-url origin', cwd);
  if (!remoteUrl || !bundleEndpointFromRemote(remoteUrl)) return pushWithLease(repoDir, remoteHead);

  const remoteHas = remoteHead ? (await keptTreesOnHub(repoDir, opts.keptHashes, opts.oldMain, remoteHead)) ?? [] : [];
  const bundled = await pushViaBundle({
    repoDir,
    branch: 'main',
    remoteUrl,
    // Lease: the hub must still be at the pre-rewrite head or the CAS fails.
    oldValue: remoteHead ?? '',
    remoteHas,
    // A rewrite is the one legitimate non-fast-forward swap.
    allowNonFastForward: true,
  });
  if (bundled.ok) {
    log.git.info('compaction: rewritten history delivered via bundle channel', {
      bytes: bundled.bytes, chunks: bundled.chunks, chunksSent: bundled.chunksSent,
      sweeps: bundled.sweeps, resumedFromSeq: bundled.resumedFromSeq, treesOnHub: remoteHas.length,
    });
    // The hub ref moved but our remote-tracking ref does not know yet.
    await gitSafeAsync('fetch origin main', { ...cwd, timeout: 60_000 });
    return { ok: true, via: 'bundle' };
  }
  const error = bundled.error ?? 'lease lost or network';
  if (noBundleChannel(error)) {
    log.git.info('compaction: the remote has no bundle channel, pushing instead', { error });
    return pushWithLease(repoDir, remoteHead);
  }
  // The finish answer can be lost after the hub's swap: rolling back then would
  // leave the two sides on different chains. Ask the hub what it holds.
  const hubNow = (await gitSafeAsync('ls-remote origin refs/heads/main', { ...cwd, timeout: 60_000 }))?.split(/\s/)[0];
  if (hubNow === opts.newHead) {
    log.git.info('compaction: bundle answer lost, but the hub holds the new chain', { error });
    await gitSafeAsync('fetch origin main', { ...cwd, timeout: 60_000 });
    return { ok: true, via: 'bundle' };
  }
  log.git.warn('compaction: bundle delivery failed', {
    error, bytes: bundled.bytes, chunks: bundled.chunks, chunksSent: bundled.chunksSent,
    sweeps: bundled.sweeps, resumedFromSeq: bundled.resumedFromSeq, leaseKept: bundled.leaseKept,
    treesOnHub: remoteHas.length,
  });
  return { ok: false, error };
}
