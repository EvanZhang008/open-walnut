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
 * commit time, as chooseLww decides), except a file the rewrite removed, whose
 * removal stands: a replay never brings back a path the hub had before the
 * rewrite and the new chain lacks (a scrub must not be undone).
 * The old head stays on `pre-rewrite-backup` whatever happens here.
 */

import { mergeRecords } from './git-sync-records.js';

export interface GitStatusResult { code: number; stdout: string; stderr: string }
/** `timeout`: a longer budget for a step whose work scales with its bytes (hash-object); the runner keeps its own floor. */
export type GitStatusRunner = (args: string[], opts?: { env?: Record<string, string>; input?: string; timeout?: number }) => Promise<GitStatusResult>;

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
  /** Conflicted stores merged record by record (git-sync-records.ts): both sides kept. */
  keptMerged: string[];
  /** True when the commits were replayed as one (more than PER_COMMIT_REPLAY_MAX). */
  squashed: boolean;
  /** True when the replay ran file by file (a git without `merge-tree --merge-base`). */
  fileLevel: boolean;
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

/** stdout of a git command that must succeed; throws with git's own words otherwise. */
export async function must(run: GitStatusRunner, args: string[], opts?: { env?: Record<string, string>; input?: string }): Promise<string> {
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

/** A JSON store's own `lastUpdated` (epoch ms) in a blob (`"<mode> <oid>"`), or null: the clock LWW trusts first. */
export async function contentClock(run: GitStatusRunner, entry: string | undefined): Promise<number | null> {
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

/**
 * `tree` with each `<mode> <oid>\t<path>` line put in (mode 0 removes the path),
 * written through a temporary index: the object store only, never the working
 * tree or the repository's own index.
 */
export async function writeTreeEntries(run: GitStatusRunner, tree: string, lines: string[], indexFile: string): Promise<string> {
  const env = { GIT_INDEX_FILE: indexFile };
  await must(run, ['read-tree', tree], { env });
  if (lines.length) await must(run, ['update-index', '-z', '--index-info'], { env, input: lines.map((l) => `${l}\0`).join('') });
  return (await must(run, ['write-tree'], { env })).trim();
}

/** The index line that removes `file` (mode 0, the all-zero id of the repo's hash length). */
export function removalLine(file: string, oidLength: number): string {
  return `0 ${'0'.repeat(oidLength)}\t${file}`;
}

async function resolveConflicts(
  run: GitStatusRunner, mergedTree: string, files: string[],
  step: { base: string; onto: string; commit: string },
  indexFile: string, out: { keptLocal: string[]; keptRemote: string[]; keptRemoved: string[]; keptMerged: string[] },
): Promise<string> {
  const [local, upstream, base] = await Promise.all([
    blobEntries(run, step.commit, files), blobEntries(run, step.onto, files), blobEntries(run, step.base, files),
  ]);
  const lines: string[] = [];
  for (const file of files) {
    const mine = local.get(file);
    const theirs = upstream.get(file);
    const records = mine && theirs ? await mergeRecords(run, file, mine, theirs) : null;
    if (mine && !theirs && base.has(file)) {
      lines.push(removalLine(file, mergedTree.length));
      out.keptRemoved.push(file);
    } else if (records) {
      lines.push(`${records}\t${file}`);
      out.keptMerged.push(file);
    } else if (mine && theirs && !(await localIsNewer(run, file, mine, theirs, step))) {
      lines.push(`${theirs}\t${file}`);
      out.keptRemote.push(file);
    } else {
      lines.push(mine ? `${mine}\t${file}` : removalLine(file, mergedTree.length));
      out.keptLocal.push(file);
    }
  }
  return writeTreeEntries(run, mergedTree, lines, indexFile);
}

/**
 * The same replay step without `merge-tree --merge-base` (git before 2.40, Ubuntu
 * 22.04 ships 2.34): file by file in a temporary index. A file the step changed
 * that the new chain still holds as the base had it takes the step's version; a
 * file both changed is a conflict, handed back whole (no line-level merge, the
 * same per-file choice LWW makes on a real conflict).
 */
async function fileLevelStep(
  run: GitStatusRunner, step: { base: string; onto: string; commit: string }, indexFile: string,
): Promise<{ tree: string; conflicts: string[] }> {
  const changed = (await must(run, ['diff', '--name-only', '-z', '--no-renames', step.base, step.commit]))
    .split('\0').filter(Boolean);
  if (changed.length === 0) return { tree: (await must(run, ['rev-parse', `${step.onto}^{tree}`])).trim(), conflicts: [] };
  const [local, upstream, base] = await Promise.all([
    blobEntries(run, step.commit, changed), blobEntries(run, step.onto, changed), blobEntries(run, step.base, changed),
  ]);
  const lines: string[] = [];
  const conflicts: string[] = [];
  for (const file of changed) {
    const [mine, theirs, was] = [local.get(file), upstream.get(file), base.get(file)];
    if (theirs === was) lines.push(mine ? `${mine}\t${file}` : removalLine(file, step.onto.length));
    else if (theirs !== mine) conflicts.push(file);
  }
  return { tree: await writeTreeEntries(run, step.onto, lines, indexFile), conflicts };
}

export interface ReplayStep {
  /** The commit whose change the step applies: its own diff from `base`. */
  commit: string;
  base: string;
}

export interface ReplayOptions {
  indexFile: string;
  /** Start file by file (a git known to lack `merge-tree --merge-base`). */
  fileLevel?: boolean;
  /**
   * A step both sides changed: return the resolved tree. Absent, the replay
   * stops at that step and reports it, building nothing more.
   */
  resolve?: (tree: string, files: string[], step: ReplayStep & { onto: string }) => Promise<string>;
  /** A last word on each step's tree (the carry drops paths the rewrite removed). */
  finishTree?: (tree: string) => Promise<string>;
  /** A step's commit message; default: the original commit's own. */
  message?: (original: string) => string;
}

export interface ReplayResult {
  /** The last commit built, or the starting point when none was. */
  head: string;
  /** Commits built (a step whose change the base already held builds none). */
  built: number;
  /** The step whose conflict stopped the replay (only without `resolve`). */
  stoppedAt: ReplayStep | null;
  fileLevel: boolean;
}

/**
 * Replay each step's change onto `onto`, one commit per step, keeping the
 * original message, author and dates. A three-way `merge-tree` per step (base =
 * the step's own base, so exactly its change is applied), or file by file on a
 * git without `--merge-base`. Builds commits and trees only: refs, the index and
 * the working tree are the caller's to move. Shared by the rewrite carry and by
 * the pull's linear replay of local commits (git-sync-merge.ts).
 */
export async function replayCommits(
  run: GitStatusRunner, steps: ReplayStep[], onto: string, opts: ReplayOptions,
): Promise<ReplayResult> {
  let fileLevel = opts.fileLevel === true;
  let ontoTree = (await must(run, ['rev-parse', `${onto}^{tree}`])).trim();
  let built = 0;
  for (const step of steps) {
    const at = { ...step, onto };
    let tree: string;
    let conflicts: string[] = [];
    const merge = fileLevel ? null : await run([
      '-c', 'merge.renames=false', '-c', 'merge.directoryRenames=false',
      'merge-tree', '--write-tree', '-z', '--name-only', '--no-messages',
      `--merge-base=${step.base}`, onto, step.commit,
    ]);
    if (merge && (merge.code === 0 || merge.code === 1)) {
      const [treeField, ...rest] = merge.stdout.split('\0');
      tree = treeField.trim();
      if (merge.code === 1) conflicts = [...new Set(rest.filter(Boolean))];
    } else {
      // An older git refuses the options (usage error 129): the file-level step.
      fileLevel = true;
      ({ tree, conflicts } = await fileLevelStep(run, at, opts.indexFile));
    }
    if (conflicts.length > 0) {
      if (!opts.resolve) return { head: onto, built, stoppedAt: step, fileLevel };
      tree = await opts.resolve(tree, conflicts, at);
    }
    if (opts.finishTree) tree = await opts.finishTree(tree);
    if (tree === ontoTree) continue;
    const meta = await commitMeta(run, step.commit);
    const message = opts.message ? opts.message(meta.message) : meta.message;
    onto = (await must(run, ['commit-tree', tree, '-p', onto, '-F', '-'], { env: meta.env, input: message })).trim();
    ontoTree = tree;
    built++;
  }
  return { head: onto, built, stoppedAt: null, fileLevel };
}

/** Drop from `tree` every path in `removed` (files the rewrite took off the hub). */
async function stripRemoved(run: GitStatusRunner, tree: string, removed: string[], indexFile: string, out: { keptRemoved: string[] }): Promise<string> {
  if (removed.length === 0) return tree;
  const present = [...(await blobEntries(run, tree, removed)).keys()];
  if (present.length === 0) return tree;
  for (const f of present) if (!out.keptRemoved.includes(f)) out.keptRemoved.push(f);
  return writeTreeEntries(run, tree, present.map((f) => removalLine(f, tree.length)), indexFile);
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
 * Replay the local commits after the anchor onto the new chain (replayCommits,
 * conflicts resolved by the newer write). Builds commits and trees only: refs,
 * index and working tree are the caller's to move.
 */
export async function carryLocalCommits(
  run: GitStatusRunner, localHead: string, remoteRef: string, indexFile: string, published: string | null = null,
  opts: { fileLevel?: boolean } = {},
): Promise<CarryResult> {
  const fileLevel = opts.fileLevel === true;
  const [localChain, remoteChain] = await Promise.all([
    readFirstParentChain(run, localHead), readFirstParentChain(run, remoteRef),
  ]);
  let anchor = findRewriteAnchor(localChain, remoteChain);
  if (published && localChain.length > 0 && remoteChain.length > 0) {
    anchor = await publishedAnchor(run, localChain, anchor, published, remoteChain[0].hash);
  }
  const result: CarryResult = { head: null, anchor, replayed: 0, keptLocal: [], keptRemote: [], keptRemoved: [], keptMerged: [], squashed: false, fileLevel };
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

  const replay = await replayCommits(run, steps, anchor.remote, {
    indexFile,
    fileLevel,
    resolve: (tree, files, step) => resolveConflicts(run, tree, files, step, indexFile, result),
    finishTree: (tree) => stripRemoved(run, tree, removed, indexFile, result),
    message: result.squashed
      ? () => `replayed ${commits.length} local commits made after the upstream rewrite (the originals are on pre-rewrite-backup)\n`
      : undefined,
  });
  result.replayed = result.squashed ? (replay.built > 0 ? commits.length : 0) : replay.built;
  result.head = replay.built > 0 ? replay.head : null;
  result.fileLevel = replay.fileLevel;
  return result;
}
