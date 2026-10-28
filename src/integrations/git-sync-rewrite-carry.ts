/**
 * Carry this box's local commits across an upstream history rewrite.
 *
 * When the hub's main is rewritten (compaction squashes old history, a path
 * scrub rewrites it), git-sync adopts the new chain instead of merging the old
 * one back in. Adopting by `reset --hard` alone dropped every local commit made
 * after the point the rewrite was cut from: 2026-10-28, a compaction cut from the
 * 06:57:48 auto-save landed on the hub at 07:27, and the Mac's three commits from
 * 07:23 to 07:27 (triggers, boards, notifications, conversations) left its
 * working tree; only the backup ref still held them.
 *
 * Ancestry cannot say which local commits are newer than the rewrite (the new
 * chain shares none, or only the part before a scrub), so this matches commits
 * by what a rewrite keeps:
 *
 *   1. tree: compaction keeps every recent commit's tree byte for byte;
 *   2. author date + subject: a path scrub keeps both while changing the tree;
 *   3. time, when neither matches: local commits whose committer time is after
 *      the newest commit on the new chain are the ones it cannot hold.
 *
 * A local commit the hub already had before the rewrite is never carried
 * (see publishedAnchor).
 *
 * The newest local commit that matches is the anchor. Every first-parent commit
 * after it is replayed onto the matching new-chain commit with a three-way
 * `merge-tree` (base = the commit's own parent, so exactly its change is
 * applied), keeping its message, author and dates. A conflict is a file both
 * sides changed: the newer write wins (the store's own `lastUpdated`, else
 * commit time, as lwwMerge decides), except a file the rewrite removed, whose
 * removal stands: a replay never brings back a path the hub had before the
 * rewrite and the new chain lacks (a scrub must not be undone).
 * The old head stays on `pre-rewrite-backup` whatever happens here.
 */

export interface GitStatusResult { code: number; stdout: string; stderr: string }
export type GitStatusRunner = (args: string[], opts?: { env?: Record<string, string>; input?: string }) => Promise<GitStatusResult>;

export interface ChainCommit {
  hash: string;
  tree: string;
  authorAt: number;
  committerAt: number;
  subject: string;
}

export interface RewriteAnchor {
  /** The newest local commit whose state the new chain already holds. */
  local: string;
  /** The new-chain commit it corresponds to: the replay starts there. */
  remote: string;
  by: 'tree' | 'author-date' | 'time' | 'published';
}

export interface CarryResult {
  /** The replayed head, or null when nothing local needed carrying. */
  head: string | null;
  anchor: RewriteAnchor | null;
  replayed: number;
  /** Conflicted paths where the local (newer) version was kept. */
  keptLocal: string[];
  /** Conflicted paths where the new chain's version was newer and kept. */
  keptRemote: string[];
  /** Conflicted paths the rewrite removed and the local side had changed: left removed. */
  keptRemoved: string[];
  /** True when the commits were replayed as one (more than PER_COMMIT_REPLAY_MAX). */
  squashed: boolean;
}

/** How far back each chain is read for a match. A rewrite is cut minutes to hours before it lands. */
export const REWRITE_SCAN_DEPTH = 5000;
/** Beyond this many local commits the replay is one commit (each original stays on the backup ref). */
export const PER_COMMIT_REPLAY_MAX = 500;

const SEP = '\x1f';

export async function readFirstParentChain(run: GitStatusRunner, ref: string, depth = REWRITE_SCAN_DEPTH): Promise<ChainCommit[]> {
  const r = await run(['log', '--first-parent', `-n${depth}`, `--format=%H${SEP}%T${SEP}%at${SEP}%ct${SEP}%s`, ref]);
  if (r.code !== 0) throw new Error(`git log ${ref} failed: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const [hash, tree, at, ct, ...subject] = line.split(SEP);
    return { hash, tree, authorAt: Number(at), committerAt: Number(ct), subject: subject.join(SEP) };
  });
}

/** Both chains newest first. Pure, so every matching rule is pinned without a repo. */
export function findRewriteAnchor(local: ChainCommit[], remote: ChainCommit[]): RewriteAnchor | null {
  if (local.length === 0 || remote.length === 0) return null;
  const byTree = new Map<string, string>();
  const byStamp = new Map<string, string>();
  for (const c of remote) {
    if (!byTree.has(c.tree)) byTree.set(c.tree, c.hash);
    const stamp = `${c.authorAt}${SEP}${c.subject}`;
    if (!byStamp.has(stamp)) byStamp.set(stamp, c.hash);
  }
  for (const c of local) {
    const sameTree = byTree.get(c.tree);
    if (sameTree) return { local: c.hash, remote: sameTree, by: 'tree' };
    const sameStamp = byStamp.get(`${c.authorAt}${SEP}${c.subject}`);
    if (sameStamp) return { local: c.hash, remote: sameStamp, by: 'author-date' };
  }
  const newestRemote = Math.max(...remote.map((c) => c.committerAt));
  const base = local.find((c) => c.committerAt <= newestRemote);
  return base ? { local: base.hash, remote: remote[0].hash, by: 'time' } : null;
}

/**
 * A commit the hub held before the rewrite (an ancestor of where origin stood
 * before this fetch) was seen by whoever rewrote it, so it is never replayed,
 * even when no rewritten commit matches it: replaying it would put back the
 * very content a scrub took out. The newest such commit newer than the match
 * (or the only anchor, when nothing matched) is replayed onto the new chain's tip.
 */
async function publishedAnchor(
  run: GitStatusRunner, local: ChainCommit[], anchor: RewriteAnchor | null, published: string, remoteTip: string,
): Promise<RewriteAnchor | null> {
  // The local first-parent commits the hub never had, newest first: the first
  // chain commit missing from this list is the newest one it did have.
  const r = await run(['rev-list', '--first-parent', `-n${local.length}`, local[0].hash, '--not', published]);
  if (r.code !== 0) return anchor;
  const unpublished = new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
  for (const c of local) {
    if (c.hash === anchor?.local) return anchor;
    if (!unpublished.has(c.hash)) return { local: c.hash, remote: remoteTip, by: 'published' };
  }
  return anchor;
}

async function must(run: GitStatusRunner, args: string[], opts?: { env?: Record<string, string>; input?: string }): Promise<string> {
  const r = await run(args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout;
}

/** `path -> "<mode> <oid>"` for the blobs at `paths` in `commit`. */
async function blobEntries(run: GitStatusRunner, commit: string, paths: string[]): Promise<Map<string, string>> {
  const out = await must(run, ['--literal-pathspecs', 'ls-tree', '-z', '-r', '--full-tree', commit, '--', ...paths]);
  const entries = new Map<string, string>();
  for (const rec of out.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    if (type === 'blob') entries.set(rec.slice(tab + 1), `${mode} ${oid}`);
  }
  return entries;
}

/** A JSON store's own `lastUpdated` (epoch ms) in a blob, or null: the clock lwwMerge trusts first. */
async function contentClock(run: GitStatusRunner, entry: string | undefined): Promise<number | null> {
  const oid = entry?.split(' ')[1];
  if (!oid) return null;
  const size = Number((await run(['cat-file', '-s', oid])).stdout.trim());
  if (!Number.isFinite(size) || size > 8 * 1024 * 1024) return null;
  try {
    const parsed = JSON.parse((await run(['cat-file', 'blob', oid])).stdout) as { lastUpdated?: unknown };
    const ms = typeof parsed?.lastUpdated === 'string' ? Date.parse(parsed.lastUpdated) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Whether the local version of a conflicted file is the newer write: the store's
 * own `lastUpdated` when both sides carry one, else the replayed commit's time
 * against the newest commit that touched the file on the new chain. A tie goes
 * to the local side, the write being carried.
 */
async function localIsNewer(run: GitStatusRunner, file: string, mine: string, theirs: string, step: { onto: string; commit: string }): Promise<boolean> {
  const [a, b] = await Promise.all([contentClock(run, mine), contentClock(run, theirs)]);
  if (a !== null && b !== null && a !== b) return a > b;
  const localAt = Number((await run(['log', '-1', '--format=%ct', step.commit])).stdout.trim() || '0');
  const remoteAt = Number((await run(['--literal-pathspecs', 'log', '-1', '--format=%ct', step.onto, '--', file])).stdout.trim() || '0');
  return localAt >= remoteAt;
}

async function resolveConflicts(
  run: GitStatusRunner, mergedTree: string, files: string[],
  step: { base: string; onto: string; commit: string },
  indexFile: string, out: { keptLocal: string[]; keptRemote: string[]; keptRemoved: string[] },
): Promise<string> {
  const env = { GIT_INDEX_FILE: indexFile };
  await must(run, ['read-tree', mergedTree], { env });
  const [local, upstream, base] = await Promise.all([
    blobEntries(run, step.commit, files), blobEntries(run, step.onto, files), blobEntries(run, step.base, files),
  ]);
  const zero = '0'.repeat(mergedTree.length);
  const removal = (file: string) => `0 ${zero}\t${file}`;
  const lines: string[] = [];
  for (const file of files) {
    const mine = local.get(file);
    const theirs = upstream.get(file);
    if (mine && !theirs && base.has(file)) {
      lines.push(removal(file));
      out.keptRemoved.push(file);
    } else if (mine && theirs && !(await localIsNewer(run, file, mine, theirs, step))) {
      lines.push(`${theirs}\t${file}`);
      out.keptRemote.push(file);
    } else {
      lines.push(mine ? `${mine}\t${file}` : removal(file));
      out.keptLocal.push(file);
    }
  }
  await must(run, ['update-index', '-z', '--index-info'], { env, input: lines.map((l) => `${l}\0`).join('') });
  return (await must(run, ['write-tree'], { env })).trim();
}

/** Drop from `tree` every path in `removed` (files the rewrite took off the hub). */
async function stripRemoved(run: GitStatusRunner, tree: string, removed: string[], indexFile: string, out: { keptRemoved: string[] }): Promise<string> {
  if (removed.length === 0) return tree;
  const present = [...(await blobEntries(run, tree, removed)).keys()];
  if (present.length === 0) return tree;
  const env = { GIT_INDEX_FILE: indexFile };
  await must(run, ['read-tree', tree], { env });
  const zero = '0'.repeat(tree.length);
  await must(run, ['update-index', '-z', '--index-info'], { env, input: present.map((f) => `0 ${zero}\t${f}\0`).join('') });
  for (const f of present) if (!out.keptRemoved.includes(f)) out.keptRemoved.push(f);
  return (await must(run, ['write-tree'], { env })).trim();
}

/** The original commit's identity and dates, so a replayed commit reads as the write it was. */
async function commitMeta(run: GitStatusRunner, commit: string): Promise<{ env: Record<string, string>; message: string }> {
  const raw = await must(run, ['log', '-1', `--format=%an${SEP}%ae${SEP}%ad${SEP}%cn${SEP}%ce${SEP}%cd${SEP}%B`, '--date=raw', commit]);
  const [an, ae, ad, cn, ce, cd, ...body] = raw.split(SEP);
  return {
    env: {
      GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad,
      GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd,
    },
    message: body.join(SEP),
  };
}

/**
 * Replay the local commits after the anchor onto the new chain. Builds commits
 * and trees only: refs, index and working tree are the caller's to move.
 */
export async function carryLocalCommits(
  run: GitStatusRunner, localHead: string, remoteRef: string, indexFile: string, published: string | null = null,
): Promise<CarryResult> {
  const [localChain, remoteChain] = await Promise.all([
    readFirstParentChain(run, localHead), readFirstParentChain(run, remoteRef),
  ]);
  let anchor = findRewriteAnchor(localChain, remoteChain);
  if (published && localChain.length > 0 && remoteChain.length > 0) {
    anchor = await publishedAnchor(run, localChain, anchor, published, remoteChain[0].hash);
  }
  const result: CarryResult = { head: null, anchor, replayed: 0, keptLocal: [], keptRemote: [], keptRemoved: [], squashed: false };
  if (!anchor || anchor.local === localHead) return result;

  const commits = (await must(run, ['rev-list', '--first-parent', '--reverse', `${anchor.local}..${localHead}`]))
    .split('\n').map((l) => l.trim()).filter(Boolean);
  if (commits.length === 0) return result;
  result.squashed = commits.length > PER_COMMIT_REPLAY_MAX;
  const steps = result.squashed
    ? [{ base: anchor.local, commit: localHead }]
    : commits.map((commit, i) => ({ base: i === 0 ? anchor.local : commits[i - 1], commit }));

  // Files the hub had before the rewrite and the new chain lacks: a replayed
  // step never brings one back, not even as a clean add (a merge commit that
  // pulled the file in before a scrub, say).
  const removed = published
    ? (await must(run, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=D', published, remoteChain[0].hash]))
      .split('\0').filter(Boolean)
    : [];

  let onto = anchor.remote;
  for (const step of steps) {
    const merge = await run([
      '-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false',
      'merge-tree', '--write-tree', '-z', '--name-only', '--no-messages',
      `--merge-base=${step.base}`, onto, step.commit,
    ]);
    if (merge.code !== 0 && merge.code !== 1) {
      throw new Error(`merge-tree failed (${merge.code}): ${merge.stderr.trim().slice(0, 400)}`);
    }
    const [treeField, ...rest] = merge.stdout.split('\0');
    let tree = treeField.trim();
    if (merge.code === 1) {
      const files = [...new Set(rest.filter(Boolean))];
      tree = await resolveConflicts(run, tree, files, { ...step, onto }, indexFile, result);
    }
    tree = await stripRemoved(run, tree, removed, indexFile, result);
    if (tree === (await must(run, ['rev-parse', `${onto}^{tree}`])).trim()) continue;
    const meta = await commitMeta(run, step.commit);
    const message = result.squashed
      ? `replayed ${commits.length} local commits made after the upstream rewrite (the originals are on pre-rewrite-backup)\n`
      : meta.message;
    onto = (await must(run, ['commit-tree', tree, '-p', onto, '-F', '-'], { env: meta.env, input: message })).trim();
    result.replayed += result.squashed ? commits.length : 1;
  }
  result.head = result.replayed > 0 ? onto : null;
  return result;
}
