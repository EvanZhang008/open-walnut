/**
 * What the target of a task move already holds of a repository, so the move bundles only the
 * commits it lacks ('task-move-base-v1').
 *
 * 2026-11-12: a move from this Mac shipped 2,240 commits of the shared main (hours at the paced
 * upload rate) to a dev host whose checkout already held all but a few: the bundle's base came from
 * the remote, and this Mac's main reaches no remote as the same commits (a land pushes
 * tree-identical ones). Now the copies on the target the work may be set up from are named first
 * (a copy it returns into, and the target's known checkout of the repository, whatever its folder
 * is called there), their daemon names the commits near each HEAD, the source's pack bases the
 * bundle on the newest of them its HEAD builds on, and only a base one of those copies lacks
 * (the target is asked) packs again the old way.
 */
import path from 'node:path';
import type { HostProfile } from '../hosts/host-profile.js';
import { repoKey } from '../hosts/host-profile.js';
import type { PackOptions, PackReply } from './daemon-transfer-client.js';
import { log } from '../../logging/index.js';
import { interruptedByShutdown } from '../server-stopping.js';

type Client = typeof import('./daemon-transfer-client.js');

/**
 * The copies on the target the work may be set up from: a copy it returns into, and always the
 * fallback when that copy refuses it (changed since): the target's known checkout of the repository
 * (cloneFrom, keyed by its URL, so its folder may have another name there), or none (a clone of the
 * remote, which holds no commit only the target has).
 */
export function setUpFrom(repo: { root: string; url?: string }, profile: HostProfile | null, intoDest?: string): Array<string | undefined> {
  const known = profile?.observed.repoPaths[repoKey(repo.url, path.posix.basename(repo.root))]?.path;
  return intoDest ? [intoDest, known] : [known];
}

export interface AgainstTarget {
  client: Client;
  sourceHost: string;
  targetHost: string;
  /** setUpFrom: every one must be a copy on the target, or the pack is the old way. */
  roots: Array<string | undefined>;
  /** Where a second pack (the old way) goes. */
  againDir: () => string;
}

/**
 * Pack `opts` on the source with the commits the set-up copies on the target hold as `haves`; the
 * old way (a base on the remote) when there is no such copy, a daemon on either side is older, or a
 * copy lacks the base the pack chose.
 */
export async function packAgainstTarget(t: AgainstTarget, opts: PackOptions): Promise<PackReply> {
  const roots = t.roots.every((r): r is string => !!r) ? [...new Set(t.roots as string[])] : [];
  const near = roots.length && await t.client.hostHasMoveBase(t.sourceHost).catch(() => false) ? await ask(t, roots) : null;
  const haves = [...new Set((near ?? []).flatMap((r) => r.commits))].slice(0, 64);
  if (!haves.length) return t.client.packWorkspace(t.sourceHost, opts);
  const pack = await t.client.packWorkspace(t.sourceHost, { ...opts, haves });
  const base = pack.meta.bundle?.from === 'target' ? pack.meta.bundle.base : undefined;
  if (!base) return pack;
  // A base a copy named itself is there; else the target says whether each copy holds it.
  const named = roots.every((r) => near!.find((x) => x.root === r)?.commits.includes(base));
  const held = named || (await ask(t, roots, base))?.every((x) => x.holds === true) === true;
  if (held) return pack;
  log.session.info('task move: a copy on the target lacks the base the pack chose; packing again on the remote', { host: t.targetHost, base });
  return t.client.packWorkspace(t.sourceHost, { ...opts, outDir: t.againDir() });
}

/** The target's answer for `roots`, best effort: null loses only a better base. */
async function ask(t: AgainstTarget, roots: string[], contains?: string) {
  try {
    return await t.client.recentCommits(t.targetHost, roots, contains);
  } catch (err) {
    if (interruptedByShutdown(err)) throw err;
    log.session.info('task move: the target did not say which commits it holds; the bundle is based on the remote', { host: t.targetHost, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
