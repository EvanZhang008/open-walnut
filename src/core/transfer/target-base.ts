/**
 * What the target of a task move already holds of a repository, so the move bundles only the
 * commits it lacks ('task-move-base-v1').
 *
 * 2026-11-12: a move from this Mac shipped 2,240 commits of the shared main (hours at the paced
 * upload rate) to a dev host whose checkout already held all but a few: the bundle's base came from
 * the remote, and this Mac's main reaches no remote as the same commits (a land pushes
 * tree-identical ones). Now the target's daemon names the commits near the HEAD of each copy it has
 * (its known checkouts of the repository, a copy the work left in the task directory), the source's
 * pack bases the bundle on the newest of them its HEAD builds on, and a base the copy the target
 * will set the work up from does not hold is packed again the old way.
 */
import path from 'node:path';
import type { HostProfile } from '../hosts/host-profile.js';
import { repoKey } from '../hosts/host-profile.js';
import type { PackMeta } from './daemon-transfer-client.js';
import { log } from '../../logging/index.js';
import { interruptedByShutdown } from '../server-stopping.js';

export interface TargetCommits {
  /** Every commit named, for `haves` of the pack. */
  haves: string[];
  byRoot: Map<string, string[]>;
}

/** The target's copies of a repository whose folder is `folder`: its known checkouts by that name, and `extra`. */
export function targetRoots(profile: HostProfile | null, folder: string, extra: string[] = []): string[] {
  const roots = new Set(extra);
  for (const [key, v] of Object.entries(profile?.observed.repoPaths ?? {})) {
    if (key === `dir:${folder}` || key.endsWith(`/${folder.toLowerCase()}`) || path.posix.basename(v.path.replace(/\/+$/, '')) === folder) roots.add(v.path);
  }
  return [...roots].slice(0, 8);
}

/** The commits near HEAD in each of `roots` on `targetHost`, or null from a daemon without 'task-move-base-v1'. */
export async function targetCommits(client: typeof import('./daemon-transfer-client.js'), targetHost: string, roots: string[]): Promise<TargetCommits | null> {
  try {
    const byRoot = await client.recentCommits(targetHost, roots);
    if (!byRoot) return null;
    return { haves: [...new Set([...byRoot.values()].flat())].slice(0, 64), byRoot };
  } catch (err) {
    // Only a better base is lost: the pack bases its bundle on the remote, as before.
    if (interruptedByShutdown(err)) throw err;
    log.session.info('task move: the target did not say which commits it holds; the bundle is based on the remote', { host: targetHost, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * The copies on the target the pack's work may be set up from: a copy it returns into, and always
 * the fallback when that copy refuses it (changed since): the target's known checkout of the
 * repository (cloneFrom), or none (a clone of the remote, which holds no target-only commit).
 */
export function setUpFrom(meta: PackMeta, profile: HostProfile | null, url: string | undefined, intoDest?: string): Array<string | undefined> {
  const known = profile?.observed.repoPaths[repoKey(url, path.posix.basename(meta.root))]?.path;
  return intoDest ? [intoDest, known] : [known];
}

/** A bundle based on a target commit that one of `roots` (where the work may be set up from) lacks: pack it again the old way. */
export function baseMissing(meta: PackMeta, commits: TargetCommits | null, roots: Array<string | undefined>): boolean {
  const base = meta.bundle?.from === 'target' ? meta.bundle.base : undefined;
  if (!base) return false;
  return roots.some((root) => !root || !(commits?.byRoot.get(root) ?? []).includes(base));
}
