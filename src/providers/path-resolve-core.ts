/**
 * Host-local path resolution — turn "whatever the model wrote" into a real path.
 *
 * The problem this solves, in one line: a session's cwd is `A/`, the model writes
 * `1/2/3`, and the file actually lives at `A/B/C/1/2/3`. Clicking it must open the
 * file, not show `ENOENT: scandir`.
 *
 * Why a LAYERED resolver instead of one clever rule: the input is untrustworthy in
 * several independent ways, and each way has a different cheapest fix.
 *
 *  L0 exact        the path exists as written                    (free)
 *  L1 transcript   the session already Read/Edited this file, so its ABSOLUTE path
 *                  is sitting in the session JSONL. Cheapest accurate answer there
 *                  is: no filesystem search, and it reflects what the model meant
 *                  rather than what it typed. Also the only layer that can fix a
 *                  WRONG absolute path (a stale/hallucinated prefix).
 *  L2 walk-up      cwd/rel, then each ancestor      (the old resolver's only trick)
 *  L3 git          git ls-files --recurse-submodules with a wildcard-prefixed
 *                  pathspec, run from the OUTERMOST ancestor repo. Any depth,
 *                  submodules included, .gitignore honored for free, and it is a
 *                  single index lookup (milliseconds) rather than a directory walk.
 *  L4 find         pruned `find` for untracked files and non-git trees. Matches
 *                  DIRECTORIES too — extensionless refs are usually folders.
 *  L5 suffix retry the reference has extra leading segments that don't exist here
 *                  (`repo/src/x.ts` quoted from a different root). Drop leading
 *                  segments one at a time and re-run L3/L4 on the tail.
 *  L6 ancestor     nothing matched: hand back the deepest ancestor that DOES exist,
 *                  flagged `degraded`, so the caller can show a usable directory
 *                  plus "couldn't find X" instead of a raw errno.
 *
 * Everything runs on the host that owns the files (in-process for the local host, in
 * the daemon for remote ones — per the repo's host-local design principle), so the
 * whole search is ONE round trip instead of ~2 RPCs per ancestor level.
 *
 * Self-contained on purpose (node builtins + session-changes-core's JSONL locator):
 * it is bundled as a sidecar (`path-resolve-core.cjs`) for source-deployed daemons.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { resolveJsonlPathHostLocal } from './session-changes-core.js';

/** How the answer was found. Reported so logs and the UI can explain themselves. */
export type ResolveVia =
  | 'exact'
  | 'transcript'
  | 'walk-up'
  | 'git'
  | 'find'
  | 'ancestor'
  | 'none';

export interface ResolvePathOptions {
  /** What the model wrote. Absolute or relative, file or directory. */
  ref: string;
  /** Session cwd, when known — the anchor for every relative search. */
  cwd?: string;
  /** Session id — unlocks the transcript layer (L1), by far the best signal. */
  sessionId?: string;
  /** Claude home (default `$HOME/.claude`). Tests point this at a temp dir. */
  claudeHome?: string;
  /** Home dir for `~` expansion (default os.homedir()). */
  homeDir?: string;
  /** Total wall-clock budget for the whole search. */
  budgetMs?: number;
}

export interface ResolvePathResult {
  /** The best path we have. Always non-empty so a click always does something. */
  path: string;
  /** true = `path` exists and is what was asked for. */
  resolved: boolean;
  /** Which layer produced it. */
  via: ResolveVia;
  /** true = `path` is a usable STAND-IN (nearest existing ancestor), not the target. */
  degraded?: boolean;
  /** Echo of the original reference, for a "couldn't find X" message. */
  ref?: string;
  /** Other plausible hits, shallowest first (excludes `path`). Capped. */
  alternatives?: string[];
}

/** Directories never worth walking into during L4. */
const PRUNE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'target',
  'coverage', '.cache', 'vendor', '__pycache__', '.venv', 'venv',
  '.gradle', '.idea', 'Pods', '.terraform', '.tox', '.mypy_cache',
];

/** How many ancestors of cwd L2 tries, and how far up we look for a repo root. */
const MAX_UPWARD_LEVELS = 8;
/** `find` depth for L4. Deeper than the old 4 — monorepo paths are long. */
const FIND_MAX_DEPTH = 6;
/** Cap on hits carried between layers so a bad needle can't blow up memory. */
const MAX_CANDIDATES = 50;
/** Longest tail of a reference we search for. See suffixNeedles: an unbounded
 *  suffix list burns the time budget on tails that cannot match. */
const MAX_NEEDLE_SEGMENTS = 5;
/** Bytes of transcript tail scanned by L1. Recent turns are the relevant ones. */
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
/** Window the tail is read+scanned in. Bounded so neither the read nor the regex
 *  pass ever occupies the event loop for long (this resolver also runs INSIDE the
 *  walnut server for the local host, where one event loop serves every route). */
const TRANSCRIPT_WINDOW_BYTES = 1024 * 1024;
/** Cap on distinct absolute paths kept from the transcript. Well above the number
 *  of files any single conversation touches; stops a pathological log from growing
 *  the set without bound. */
const TRANSCRIPT_MAX_PATHS = 4000;
/** Default total budget. Every layer re-checks it, so a slow host degrades. */
const DEFAULT_BUDGET_MS = 6_000;
/** Per-subprocess ceiling (git / find). Well under the total budget. */
const SUBPROCESS_TIMEOUT_MS = 4_000;

/** Reject input that could escape the sandbox or reach a shell. Mirrors the HTTP
 *  edges' guards, repeated here because the daemon accepts this over RPC too. */
function isUnsafeRef(ref: string): boolean {
  return ref.length === 0 || ref.length > 4096 || ref.includes('..') || /[;&|`$(){}!<>\n\r]/.test(ref);
}

/** Expand a leading `~` and strip trailing slashes. */
function normalize(p: string, homeDir: string): string {
  let out = p.trim();
  if (out === '~' || out.startsWith('~/')) out = homeDir + out.slice(1);
  out = out.replace(/\/+$/, '');
  return out || '/';
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Run a subprocess, never throwing. Returns stdout ('' on any failure). */
function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd, args,
      { cwd, timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: 4 << 20, encoding: 'utf-8' },
      (_err, stdout) => resolve(stdout || ''),
    );
    child.on('error', () => resolve(''));
  });
}

/** Ordered bases to try: cwd, then each ancestor, stopping at the filesystem root. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = dir.replace(/\/+$/, '') || '/';
  for (let i = 0; i <= MAX_UPWARD_LEVELS; i++) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/**
 * Every git repo root at or above `dir`, OUTERMOST first.
 *
 * Outermost-first matters: `git ls-files --recurse-submodules` searches DOWN into
 * submodules, so starting at the superproject covers the submodule too, while
 * starting inside the submodule can never see a sibling one. A monorepo of
 * submodules is exactly the case that used to fail.
 */
async function gitRoots(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const base of ancestors(dir)) {
    if (await exists(path.join(base, '.git'))) found.push(base);
  }
  return found.reverse();
}

/** Rank hits: shallowest path wins, then shortest string. Deterministic. */
function rankHits(hits: string[]): string[] {
  const seen = new Set<string>();
  const unique = hits.filter((h) => h && !seen.has(h) && (seen.add(h), true));
  return unique
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
    .slice(0, MAX_CANDIDATES);
}

/** Keep paths that ARE `needle` or end with `/needle`. */
function matchingSuffix(paths: string[], needle: string): string[] {
  const suffix = '/' + needle;
  return paths.filter((p) => p === needle || p.endsWith(suffix));
}

/**
 * Progressively shorter tails of a reference: `a/b/c` → [`a/b/c`, `b/c`, `c`].
 *
 * Only the LAST `MAX_NEEDLE_SEGMENTS` segments are considered. That bound is
 * load-bearing, not a nicety: an absolute reference on a deep monorepo path has
 * ~15 suffixes, each costing a search per repo root, so an unbounded list spent
 * the entire time budget on long tails that can never match and gave up before
 * reaching the short ones that do. Four segments already identify a file far more
 * specifically than any real repo needs.
 */
function suffixNeedles(rel: string): string[] {
  const all = rel.split('/').filter(Boolean);
  const segs = all.slice(-MAX_NEEDLE_SEGMENTS);
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) out.push(segs.slice(i).join('/'));
  return out;
}

// ── L1: the session transcript ──

/** Absolute POSIX paths, as they appear in JSONL (JSON-escaped or bare). */
const ABS_PATH_IN_JSONL = /\/(?:[\w@.+\-]+\/)+[\w@.+\-]+/g;

/**
 * Absolute paths this session actually touched, most recent first.
 *
 * Reads only the TAIL of the transcript: it is the part that mentions what the
 * conversation is currently about, and a whale JSONL must never be materialized
 * whole (that is its own class of incident here). The tail is read in 1MB windows
 * with an explicit yield between them, so this never occupies the event loop for
 * long even when it runs in-process on the walnut server.
 *
 * Windows are scanned NEWEST-first and results kept in first-seen order, so the
 * most recently mentioned path for a given suffix wins.
 */
async function transcriptPaths(
  sessionId: string,
  cwd: string | undefined,
  claudeHome: string,
  deadline: number,
): Promise<string[]> {
  const jsonlPath = await resolveJsonlPathHostLocal(sessionId, cwd, claudeHome);
  if (!jsonlPath) return [];
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(jsonlPath, 'r');
  } catch {
    return [];
  }
  try {
    const st = await fh.stat();
    const tailStart = Math.max(0, st.size - TRANSCRIPT_TAIL_BYTES);
    if (st.size - tailStart <= 0) return [];

    const seen = new Set<string>();
    const out: string[] = [];
    const buf = Buffer.alloc(TRANSCRIPT_WINDOW_BYTES);
    // Walk windows from the END of the file backwards.
    let winEnd = st.size;
    while (winEnd > tailStart && out.length < TRANSCRIPT_MAX_PATHS) {
      if (Date.now() >= deadline) break;
      const winStart = Math.max(tailStart, winEnd - TRANSCRIPT_WINDOW_BYTES);
      const len = winEnd - winStart;
      const { bytesRead } = await fh.read(buf, 0, len, winStart);
      if (bytesRead <= 0) break;
      // A path may straddle a window boundary; the loss is one candidate out of
      // thousands and the next window usually mentions it again, so we accept it
      // rather than carrying a buffer (this is a hint layer, not a source of truth).
      const text = buf.subarray(0, bytesRead).toString('utf-8');
      const hits = text.match(ABS_PATH_IN_JSONL) ?? [];
      // Within a window, later mentions are more recent → walk it backwards too.
      for (let i = hits.length - 1; i >= 0 && out.length < TRANSCRIPT_MAX_PATHS; i--) {
        const p = hits[i]!;
        if (seen.has(p)) continue;
        seen.add(p);
        out.push(p);
      }
      winEnd = winStart;
      // Explicit yield: fh.read can complete synchronously from the page cache.
      await new Promise<void>((r) => setImmediate(r));
    }
    return out;
  } catch {
    return [];
  } finally {
    await fh.close().catch(() => { /* already gone */ });
  }
}

// ── L3: the git index ──

/**
 * Search a repo's index (and its submodules') for every needle at once.
 *
 * ALL needles go into ONE `ls-files` call: git takes many pathspecs, and one
 * process handling six patterns costs the same as one handling one, while a call
 * per needle per repo root is what made this slow enough to hit the time budget
 * on a remote monorepo. Results are grouped BY NEEDLE so the caller can still
 * prefer the most specific match.
 *
 * Directory refs are matched by finding the FILES under them and cutting each hit
 * back to the directory: `ls-files` lists files only, but a directory containing
 * tracked files is exactly a directory that exists.
 */
async function gitSearch(
  root: string,
  needles: string[],
  wantDir: boolean,
): Promise<Map<string, string[]>> {
  const pathspec: string[] = [];
  for (const n of needles) {
    if (wantDir) pathspec.push(`*/${n}/*`, `${n}/*`);
    else pathspec.push(`*/${n}`, n);
  }
  const out = await run('git', [
    'ls-files', '--recurse-submodules', '-z', '--', ...pathspec,
  ], root);
  const rels = out.split('\0').filter(Boolean);
  const byNeedle = new Map<string, string[]>();
  if (rels.length === 0) return byNeedle;

  for (const needle of needles) {
    const hits: string[] = [];
    if (!wantDir) {
      for (const r of matchingSuffix(rels, needle)) hits.push(path.join(root, r));
    } else {
      const suffix = '/' + needle + '/';
      for (const rel of rels) {
        const at = ('/' + rel).indexOf(suffix);
        if (at === -1) continue;
        hits.push(path.join(root, ('/' + rel).slice(1, at + suffix.length - 1)));
      }
    }
    if (hits.length) byNeedle.set(needle, hits);
  }
  return byNeedle;
}

// ── L4: a pruned filesystem walk ──

/**
 * One `find` for a basename, pruning heavy directories, matching files AND dirs.
 *
 * `find` in a subprocess rather than an in-process walk on purpose: the server
 * wraps fs/promises for log forwarding, which makes a many-directory BFS take
 * >10s in-process while native `find` returns in milliseconds.
 */
async function findSearch(root: string, needle: string): Promise<string[]> {
  const baseName = needle.split('/').pop() ?? needle;
  const pruneArgs: string[] = [];
  for (const d of PRUNE_DIRS) pruneArgs.push('-name', d, '-prune', '-o');
  const out = await run('find', [
    root, '-maxdepth', String(FIND_MAX_DEPTH),
    '(', ...pruneArgs.slice(0, -1), ')',
    '-o', '-name', baseName, '-print',
  ]);
  return matchingSuffix(out.split('\n').filter(Boolean), needle);
}

// ── L6: give back something usable ──

/** Deepest existing ancestor of `p` (walks up until something exists). */
async function nearestExistingAncestor(p: string): Promise<string | null> {
  let cur = path.dirname(p.replace(/\/+$/, ''));
  for (let i = 0; i < 32; i++) {
    if (await exists(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return (await exists(cur)) ? cur : null;
    cur = parent;
  }
  return null;
}

// ── The resolver ──

/**
 * Resolve `ref` to a real path on THIS host. Never throws for a merely
 * unresolvable path: it degrades to the nearest existing ancestor so a click
 * always lands somewhere, with `resolved:false` telling the caller to say so.
 *
 * Throws only on input that must not be searched at all (traversal / metachars).
 */
export async function resolvePathHostLocal(opts: ResolvePathOptions): Promise<ResolvePathResult> {
  const homeDir = opts.homeDir ?? os.homedir();
  const claudeHome = opts.claudeHome ?? path.join(homeDir, '.claude');
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const outOfTime = () => Date.now() >= deadline;

  const rawRef = typeof opts.ref === 'string' ? opts.ref : '';
  if (isUnsafeRef(rawRef)) throw new Error('Invalid path');
  const ref = normalize(rawRef, homeDir);
  const cwd = opts.cwd && !isUnsafeRef(opts.cwd) ? normalize(opts.cwd, homeDir) : undefined;

  // L0 — it exists exactly as written.
  const isAbs = ref.startsWith('/');
  const asWritten = isAbs ? ref : cwd ? path.join(cwd, ref.replace(/^\.\//, '')) : null;
  if (asWritten && await exists(asWritten)) {
    return { path: asWritten, resolved: true, via: 'exact' };
  }

  // Needles to search for, longest (most specific) tail first. For an absolute
  // ref we search by its tail too — a wrong PREFIX is the common failure, and the
  // last few segments are almost always right.
  const relRef = (isAbs ? ref.replace(/^\/+/, '') : ref.replace(/^\.\//, '')).replace(/\/+$/, '');
  const needles = suffixNeedles(relRef);
  const leaf = relRef.split('/').pop() ?? relRef;
  // Extensionless leaf ⇒ almost certainly a directory. `find`/`ls-files` need to
  // know which, and guessing wrong just costs one empty result set.
  const wantDir = !leaf.includes('.');

  const alternatives: string[] = [];
  const remember = (hits: string[], chosen: string) => {
    for (const h of hits) {
      if (h !== chosen && alternatives.length < MAX_CANDIDATES && !alternatives.includes(h)) {
        alternatives.push(h);
      }
    }
  };
  const done = (p: string, via: ResolveVia, hits: string[] = []): ResolvePathResult => {
    remember(hits, p);
    return { path: p, resolved: true, via, ...(alternatives.length ? { alternatives } : {}) };
  };

  // L1 — the transcript. Best signal available: the session already opened this
  // file, so its real absolute path is recorded. Free relative to a disk search.
  if (opts.sessionId && !outOfTime()) {
    const seen = await transcriptPaths(opts.sessionId, cwd, claudeHome, deadline);
    if (seen.length > 0) {
      for (const needle of needles) {
        const hits = matchingSuffix(seen, needle);
        for (const hit of hits) {
          if (outOfTime()) break;
          if (await exists(hit)) return done(hit, 'transcript', hits);
        }
      }
    }
  }

  // L2 — walk up from cwd. Cheap, and the right answer whenever the model quoted
  // a path relative to the repo root while cwd sat in a subdirectory.
  if (cwd && !outOfTime()) {
    for (const base of ancestors(cwd)) {
      if (outOfTime()) break;
      const candidate = path.join(base, relRef);
      if (await exists(candidate)) return done(candidate, 'walk-up');
    }
  }

  // L3 + L4 — search DOWN. One git call per repo root covers EVERY needle; the
  // needle order then decides which hit wins, longest (most specific) first.
  // Dropping leading segments (L5) is just the later entries of `needles`.
  const searchRoots = cwd ? await gitRoots(cwd) : [];
  const fsRoot = searchRoots[searchRoots.length - 1] ?? cwd;
  for (const root of searchRoots) {
    if (outOfTime()) break;
    const byNeedle = await gitSearch(root, needles, wantDir);
    for (const needle of needles) {
      const hits = rankHits(byNeedle.get(needle) ?? []);
      for (const hit of hits) {
        if (outOfTime()) break;
        if (await exists(hit)) return done(hit, 'git', hits);
      }
    }
  }
  // `find` only after every git attempt: it is the slower, less precise layer, and
  // its job is the cases git cannot see (untracked files, non-git trees).
  if (fsRoot) {
    for (const needle of needles) {
      if (outOfTime()) break;
      const hits = rankHits(await findSearch(fsRoot, needle));
      for (const hit of hits) {
        if (await exists(hit)) return done(hit, 'find', hits);
      }
    }
  }

  // L6 — nothing matched. Hand back the deepest ancestor that exists so the
  // caller can show a real directory plus "couldn't find <ref>", never an errno.
  const fallback = asWritten ?? ref;
  const ancestor = await nearestExistingAncestor(fallback);
  if (ancestor) {
    return {
      path: ancestor,
      resolved: false,
      via: 'ancestor',
      degraded: true,
      ref: rawRef,
      ...(alternatives.length ? { alternatives } : {}),
    };
  }
  return { path: fallback, resolved: false, via: 'none', ref: rawRef };
}
