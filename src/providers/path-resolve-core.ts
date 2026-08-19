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
 *  L3 git          the git index, searched CHEAPEST-SCOPE-FIRST (see gitSearch).
 *                  Any depth, submodules included, .gitignore honored for free,
 *                  and an index lookup rather than a directory walk.
 *  L4 find         pruned `find` for untracked files and non-git trees. Matches
 *                  DIRECTORIES too — extensionless refs are often folders.
 *  L5 suffix retry the reference has extra leading segments that don't exist here
 *                  (`repo/src/x.ts` quoted from a different root). Drop leading
 *                  segments and re-run L3/L4 on the tail — but never so far that
 *                  the needle stops being specific (see MIN_NEEDLE_SEGMENTS).
 *  L6 ancestor     nothing matched: hand back the deepest ancestor that DOES exist,
 *                  flagged `degraded`, so the caller can show a usable directory
 *                  plus "couldn't find X" instead of a raw errno.
 *
 * Everything runs on the host that owns the files (in-process for the local host, in
 * the daemon for remote ones — per the repo's host-local design principle), so the
 * whole search is ONE round trip instead of ~2 RPCs per ancestor level.
 *
 * Self-contained on purpose (node builtins + two local modules): it is bundled as a
 * sidecar (`path-resolve-core.cjs`) for source-deployed daemons.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { resolveJsonlPathHostLocal } from './session-changes-core.js';
import { parsePathRef, isUnsafePathRef } from './path-ref-parse.js';

/** How the answer was found. Reported so logs and the UI can explain themselves. */
export type ResolveVia =
  | 'exact'
  | 'transcript'
  | 'walk-up'
  | 'git'
  | 'find'
  | 'case-insensitive'
  | 'ancestor'
  | 'none';

export interface ResolvePathOptions {
  /** What the model wrote. Absolute or relative, file or directory, and possibly
   *  decorated (`\`src/a.ts:42\``) — decoration is parsed off, not searched for. */
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
  /**
   * Skip the one scope whose cost scales with the repo's submodule count.
   *
   * Every layer except that scope answers in tens of milliseconds; the exhaustive
   * submodule traversal is what makes a genuine MISS take ~1.2s on a large
   * monorepo (measured: 2,606 submodules). A caller that is blocking a UI can set
   * this to get the fast answer, then re-ask without it if the result came back
   * `resolved: false` and it still cares.
   *
   * A `false` result from a fast pass therefore means "not found in the likely
   * places", not "does not exist" — which is why `exhaustive: false` is reported
   * back on the result, so a caller can tell the two apart.
   */
  fast?: boolean;
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
  /** Line the reference asked for (`file.ts:42`, `#L42`), when it carried one. */
  line?: number;
  /** Column, when the reference carried one (`file.ts:42:7`). */
  column?: number;
  /** End line for a range reference (`:10-20`). */
  endLine?: number;
  /**
   * false when a `fast` pass skipped the exhaustive submodule scope. On a
   * `resolved: false` result this is the difference between "not found in the
   * likely places" and "definitely not here" — a caller showing a
   * "couldn't find X" message should only claim the latter when this is true.
   */
  exhaustive?: boolean;
}

/** Directories never worth walking into during L4. */
const PRUNE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'target',
  'coverage', '.cache', 'vendor', '__pycache__', '.venv', 'venv',
  '.gradle', '.idea', 'Pods', '.terraform', '.tox', '.mypy_cache',
];

/** How many ancestors of cwd L2 tries, and how far up we look for a repo root. */
const MAX_UPWARD_LEVELS = 8;
/** `find` depth for L4. Deeper than a typical repo nests. */
const FIND_MAX_DEPTH = 6;
/** Cap on hits carried between layers so a bad needle can't blow up memory. */
const MAX_CANDIDATES = 50;
/**
 * Longest tail of a reference we search for. An absolute reference on a deep
 * monorepo path has ~15 suffixes, each costing a search per scope, so an unbounded
 * list spends the whole budget on long tails that cannot match and gives up before
 * reaching the short ones that do.
 */
const MAX_NEEDLE_SEGMENTS = 5;
/**
 * Shortest tail we will accept as a MATCH — the guard against a confident wrong
 * answer, and the most important constant in this file.
 *
 * Retrying with fewer leading segments is what lets `repo/src/x.ts` find
 * `src/x.ts`. Taken to its limit it also lets `no/such/thing.ts` "find" an
 * unrelated `other/thing.ts`, and report `resolved: true` — a lie that is worse
 * than an error message, because the user opens the wrong file believing it is the
 * right one. So a multi-segment reference must keep at least a directory of
 * context. A reference that was ALWAYS just a bare filename (`Makefile`) is
 * exempt: there is no context to preserve, and matching the basename is exactly
 * what was asked for.
 */
const MIN_NEEDLE_SEGMENTS = 2;
/** Bytes of transcript tail scanned by L1. Recent turns are the relevant ones. */
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
/** Window the tail is read+scanned in. Bounded so neither the read nor the regex
 *  pass ever occupies the event loop for long (this resolver also runs INSIDE the
 *  walnut server for the local host, where one event loop serves every route). */
const TRANSCRIPT_WINDOW_BYTES = 1024 * 1024;
/** Cap on distinct absolute paths kept from the transcript. */
const TRANSCRIPT_MAX_PATHS = 4000;
/** Default total budget. Every layer re-checks it, so a slow host degrades. */
const DEFAULT_BUDGET_MS = 6_000;
/** Per-subprocess ceiling (git / find). Well under the total budget. */
const SUBPROCESS_TIMEOUT_MS = 4_000;
/** Concurrent `git ls-files` processes when fanning out over submodules. */
const SUBMODULE_FANOUT = 24;
/**
 * Submodules searched in the fan-out scopes. Above this the fan-out costs more
 * than `--recurse-submodules` would, so the last-resort scope is used instead.
 */
const MAX_FANOUT_SUBMODULES = 400;

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

/**
 * Resolve symlinks in a directory path, falling back to the input.
 *
 * Load-bearing for correctness, not tidiness: a session's cwd is often a symlink
 * (`~/work` → `/Volumes/…`, or a checkout linked into place). Searching from the
 * link and returning link-relative paths produced answers that were correct but
 * unstable — the same file got two different "absolute" paths depending on how the
 * session was started, which broke the Files panel's per-path memory. Resolve once
 * here so every layer speaks about the same real path.
 */
async function realDir(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

/** Run a subprocess, never throwing. Returns stdout ('' on any failure). */
function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd, args,
      { cwd, timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: 8 << 20, encoding: 'utf-8' },
      (_err, stdout) => resolve(stdout || ''),
    );
    child.on('error', () => resolve(''));
  });
}

/** Map over `items` with at most `limit` in flight. Preserves input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
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

/** Every git repo root at or above `dir`, OUTERMOST first. */
async function gitRoots(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const base of ancestors(dir)) {
    if (await exists(path.join(base, '.git'))) found.push(base);
  }
  return found.reverse();
}

/**
 * Rank hits: shallowest path wins, then shortest string, then lexicographic.
 *
 * `exactTail` breaks the remaining ties in favour of a path whose ending matches
 * the reference CHARACTER FOR CHARACTER. On a case-sensitive filesystem a
 * directory can hold both `Thing.ts` and `thing.ts`; both are equally shallow and
 * equally long, so without this the winner came down to string order and a request
 * for one could return the other.
 */
function rankHits(hits: string[], exactTail?: string): string[] {
  const seen = new Set<string>();
  const unique = hits.filter((h) => h && !seen.has(h) && (seen.add(h), true));
  const isExact = (p: string) =>
    exactTail !== undefined && (p === exactTail || p.endsWith('/' + exactTail)) ? 0 : 1;
  return unique
    .sort((a, b) =>
      isExact(a) - isExact(b)
      || a.split('/').length - b.split('/').length
      || a.length - b.length
      || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_CANDIDATES);
}

/** Keep paths that ARE `needle` or end with `/needle`. */
function matchingSuffix(paths: string[], needle: string): string[] {
  const suffix = '/' + needle;
  return paths.filter((p) => p === needle || p.endsWith(suffix));
}

/** Case-insensitive variant of the above, for the fallback pass. */
function matchingSuffixCI(paths: string[], needle: string): string[] {
  const lower = needle.toLowerCase();
  const suffix = '/' + lower;
  return paths.filter((p) => {
    const pl = p.toLowerCase();
    return pl === lower || pl.endsWith(suffix);
  });
}

/**
 * Progressively shorter tails of a reference: `a/b/c` → [`a/b/c`, `b/c`].
 *
 * Bounded at BOTH ends. The upper bound (MAX_NEEDLE_SEGMENTS) keeps a deep
 * absolute path from spending the budget on tails that cannot match. The lower
 * bound (MIN_NEEDLE_SEGMENTS) is what stops a confident wrong answer: without it,
 * `no/such/thing.ts` degrades to the bare needle `thing.ts` and cheerfully returns
 * an unrelated file. A reference that is a bare filename to begin with has no
 * context to keep, so it is allowed as-is.
 */
function suffixNeedles(rel: string): string[] {
  const all = rel.split('/').filter(Boolean);
  const segs = all.slice(-MAX_NEEDLE_SEGMENTS);
  const floor = Math.min(MIN_NEEDLE_SEGMENTS, all.length);
  const out: string[] = [];
  for (let i = 0; i <= segs.length - floor; i++) out.push(segs.slice(i).join('/'));
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

// ── L3: the git index, cheapest scope first ──

/**
 * Submodule paths declared in a repo's `.gitmodules`, repo-relative.
 *
 * Read as TEXT rather than via `git submodule status`: the file is a few hundred
 * KB even for thousands of entries and parsing it costs ~2ms, while the git command
 * stats every submodule and costs seconds at that scale.
 */
async function declaredSubmodules(root: string): Promise<string[]> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(root, '.gitmodules'), 'utf-8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** Pathspecs that match `needle` as a file, or as a directory's contents. */
function pathspecsFor(needles: string[], wantDir: boolean): string[] {
  const out: string[] = [];
  for (const n of needles) {
    if (wantDir) out.push(`*/${n}/*`, `${n}/*`);
    // A needle with no extension may still be a FILE (Makefile, LICENSE), so the
    // file patterns are always included — an extra pathspec is free, a missed file
    // is a bug.
    out.push(`*/${n}`, n);
  }
  return out;
}

/** Group repo-relative hits by which needle they satisfy, as absolute paths. */
function groupByNeedle(
  rels: string[],
  needles: string[],
  base: string,
  wantDir: boolean,
): Map<string, string[]> {
  const byNeedle = new Map<string, string[]>();
  for (const needle of needles) {
    const hits: string[] = [];
    // Direct file matches always count, even for an extensionless needle.
    for (const r of matchingSuffix(rels, needle)) hits.push(path.join(base, r));
    if (wantDir) {
      // Cut each file path back to the directory whose tail is the needle.
      const suffix = '/' + needle + '/';
      for (const rel of rels) {
        const at = ('/' + rel).indexOf(suffix);
        if (at === -1) continue;
        hits.push(path.join(base, ('/' + rel).slice(1, at + suffix.length - 1)));
      }
    }
    if (hits.length) byNeedle.set(needle, hits);
  }
  return byNeedle;
}

/**
 * Search a repo's index for every needle, CHEAPEST SCOPE FIRST.
 *
 * `git ls-files --recurse-submodules` is the complete answer and the obvious one,
 * but its cost is proportional to the submodule COUNT, not to how likely each one
 * is to hold the file. Measured on a real monorepo of 27,827 tracked files and
 * 2,606 initialized submodules: the recursive call takes **1.24s**, while the same
 * pathspec against the superproject index alone takes **45ms** (27x), and a
 * parallel fan-out over just the submodules under cwd takes **20ms** (60x).
 *
 * The ordering exploits the fact that a path the model mentioned is almost always
 * in the subtree the session is working in:
 *
 *   scope 1  the superproject index         ~45ms   (no submodule traversal at all)
 *   scope 2  submodules UNDER cwd           ~20ms   (parallel, no recursion each)
 *   scope 3  submodules under cwd's parent  ~95ms   (the sibling-component case)
 *   scope 4  --recurse-submodules          ~1240ms  (last resort, complete)
 *
 * Each scope returns as soon as it has a hit, so the common case pays 20-45ms and
 * the complete-but-slow scope is reached only when the file genuinely lives
 * somewhere unrelated to the session. A repo with no submodules has exactly one
 * scope and is unaffected.
 */
async function gitSearchScoped(
  root: string,
  needles: string[],
  wantDir: boolean,
  cwd: string | undefined,
  outOfTime: () => boolean,
  fast: boolean,
): Promise<Map<string, string[]>> {
  const specs = pathspecsFor(needles, wantDir);
  const empty = new Map<string, string[]>();

  // ── scope 1: the superproject index, no submodule traversal ──
  const own = await run('git', ['ls-files', '-z', '--', ...specs], root);
  const ownRels = own.split('\0').filter(Boolean);
  if (ownRels.length) {
    const g = groupByNeedle(ownRels, needles, root, wantDir);
    if (g.size) return g;
  }
  if (outOfTime()) return empty;

  const subs = await declaredSubmodules(root);
  if (subs.length === 0) return empty; // no submodules: scope 1 was complete

  /** Fan out over a set of submodules, each a plain (non-recursive) ls-files. */
  const fanOut = async (paths: string[]): Promise<Map<string, string[]>> => {
    if (paths.length === 0 || paths.length > MAX_FANOUT_SUBMODULES) return empty;
    const results = await mapLimit(paths, SUBMODULE_FANOUT, async (rel) => {
      if (outOfTime()) return [] as string[];
      const abs = path.join(root, rel);
      const out = await run('git', ['ls-files', '-z', '--', ...specs], abs);
      return out.split('\0').filter(Boolean).map((r) => path.join(rel, r));
    });
    const flat = results.flat();
    return flat.length ? groupByNeedle(flat, needles, root, wantDir) : empty;
  };

  // ── scopes 2 and 3: submodules under cwd, then under cwd's parent ──
  // Prefix-filtered against the DECLARED paths, which is pure string work.
  if (cwd && cwd.startsWith(root)) {
    const relCwd = cwd.slice(root.length).replace(/^\/+/, '');
    const scopes = relCwd ? [relCwd, path.dirname(relCwd)] : [];
    for (const scope of scopes) {
      if (outOfTime()) return empty;
      if (!scope || scope === '.') continue;
      const inScope = subs.filter((s) => s === scope || s.startsWith(scope + '/'));
      const g = await fanOut(inScope);
      if (g.size) return g;
    }
  }
  if (outOfTime()) return empty;

  // ── scope 4: everything. Complete, and the only scope whose cost scales with
  // the submodule count — which is why it is last.
  //
  // There is deliberately NO cheap pre-check here. The obvious one (ask the
  // superproject index whether the basename exists anywhere, and skip this scope
  // if not) was measured and does not work: a superproject index contains
  // submodule GITLINKS, not submodule CONTENTS, so it answers "no" for every file
  // that lives in a submodule — which is exactly the case this scope exists to
  // catch. Measured on the same repo: 38ms for the superproject question, 1030ms
  // for the real one, and the cheap answer was wrong.
  //
  // So confirming a reference is genuinely absent costs one full traversal. That
  // is the honest price of a definite "no", and it is only paid on the miss path;
  // every hit returns from an earlier scope in tens of milliseconds. A caller that
  // is blocking a UI opts out with `fast` and re-asks later if it still cares.
  if (fast) return empty;
  const all = await run('git', ['ls-files', '--recurse-submodules', '-z', '--', ...specs], root);
  const allRels = all.split('\0').filter(Boolean);
  return allRels.length ? groupByNeedle(allRels, needles, root, wantDir) : empty;
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
    '-o', '-iname', baseName, '-print',
  ]);
  return out.split('\n').filter(Boolean);
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
 * Throws only on input that must not be searched at all (a `..` segment, shell
 * metacharacters, NUL, empty, or absurdly long).
 */
export async function resolvePathHostLocal(opts: ResolvePathOptions): Promise<ResolvePathResult> {
  const homeDir = opts.homeDir ?? os.homedir();
  const claudeHome = opts.claudeHome ?? path.join(homeDir, '.claude');
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const outOfTime = () => Date.now() >= deadline;
  const fast = opts.fast === true;
  // Stamped on every result: a `fast` pass never reaches the exhaustive scope, so
  // its negatives are weaker than a full pass's.
  const exh = fast ? { exhaustive: false } : { exhaustive: true };

  const rawRef = typeof opts.ref === 'string' ? opts.ref : '';
  // Parse decoration off BEFORE the safety check: a reference wrapped in backticks
  // or carrying `:42` is ordinary input, and rejecting it as unsafe (or searching
  // for the decorated string) was a whole family of misses.
  const parsed = parsePathRef(rawRef);
  if (isUnsafePathRef(parsed.path)) throw new Error('Invalid path');
  const pos = {
    ...(parsed.line !== undefined ? { line: parsed.line } : {}),
    ...(parsed.column !== undefined ? { column: parsed.column } : {}),
    ...(parsed.endLine !== undefined ? { endLine: parsed.endLine } : {}),
  };

  const ref = normalize(parsed.path, homeDir);
  const rawCwd = opts.cwd && !isUnsafePathRef(opts.cwd) ? normalize(opts.cwd, homeDir) : undefined;
  // Resolve the cwd's symlinks ONCE: every layer then produces stable real paths.
  const cwd = rawCwd ? await realDir(rawCwd) : undefined;

  // L0 — it exists exactly as written.
  const isAbs = ref.startsWith('/');
  const asWritten = isAbs ? ref : cwd ? path.join(cwd, ref.replace(/^\.\//, '')) : null;
  if (asWritten && await exists(asWritten)) {
    return { path: await realDir(asWritten), resolved: true, via: 'exact', ...pos, ...exh };
  }

  // Needles to search for, longest (most specific) tail first. For an absolute
  // ref we search by its tail too — a wrong PREFIX is the common failure, and the
  // last few segments are almost always right.
  const relRef = (isAbs ? ref.replace(/^\/+/, '') : ref.replace(/^\.\//, '')).replace(/\/+$/, '');
  const needles = suffixNeedles(relRef);
  const leaf = relRef.split('/').pop() ?? relRef;
  // An extensionless leaf is USUALLY a directory, so directory pathspecs are added
  // — but file pathspecs are always included too (Makefile, LICENSE, Dockerfile).
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
    return {
      path: p, resolved: true, via, ...pos, ...exh,
      ...(alternatives.length ? { alternatives } : {}),
    };
  };

  // L1 — the transcript. Best signal available: the session already opened this
  // file, so its real absolute path is recorded. Free relative to a disk search.
  let transcript: string[] = [];
  if (opts.sessionId && !outOfTime()) {
    transcript = await transcriptPaths(opts.sessionId, cwd, claudeHome, deadline);
    for (const needle of needles) {
      const hits = matchingSuffix(transcript, needle);
      for (const hit of hits) {
        if (outOfTime()) break;
        if (await exists(hit)) return done(hit, 'transcript', hits);
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

  // L3 — the git index, cheapest scope first. One search per repo root covers
  // EVERY needle; the needle order then decides which hit wins, most specific
  // first. Dropping leading segments (L5) is just the later entries of `needles`.
  const searchRoots = cwd ? await gitRoots(cwd) : [];
  const fsRoot = searchRoots[searchRoots.length - 1] ?? cwd;
  for (const root of searchRoots) {
    if (outOfTime()) break;
    const byNeedle = await gitSearchScoped(root, needles, wantDir, cwd, outOfTime, fast);
    for (const needle of needles) {
      const hits = rankHits(byNeedle.get(needle) ?? [], needle);
      for (const hit of hits) {
        if (outOfTime()) break;
        if (await exists(hit)) return done(hit, 'git', hits);
      }
    }
  }

  // L4 — `find`, for what git cannot see: untracked files and non-git trees.
  // `-iname` makes this pass case-insensitive on the basename, so it doubles as
  // the recovery path for a mis-cased leaf.
  if (fsRoot && !outOfTime()) {
    for (const needle of needles) {
      if (outOfTime()) break;
      const raw = await findSearch(fsRoot, needle);
      // Exact-case suffix first: if both a correctly-cased and a differently-cased
      // file exist, the one the reference actually names must win.
      for (const hit of rankHits(matchingSuffix(raw, needle), needle)) {
        if (await exists(hit)) return done(hit, 'find', raw);
      }
      for (const hit of rankHits(matchingSuffixCI(raw, needle), needle)) {
        if (await exists(hit)) return done(hit, 'case-insensitive', raw);
      }
    }
  }

  // L4b — a mis-cased path the transcript knows about. Cheap (already in memory)
  // and it covers the case-only mismatch on a DIRECTORY segment, which `-iname`
  // (basename-only) cannot.
  if (transcript.length && !outOfTime()) {
    for (const needle of needles) {
      for (const hit of matchingSuffixCI(transcript, needle)) {
        if (outOfTime()) break;
        if (await exists(hit)) return done(hit, 'case-insensitive', []);
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
      ...pos,
      ...exh,
      ...(alternatives.length ? { alternatives } : {}),
    };
  }
  return { path: fallback, resolved: false, via: 'none', ref: rawRef, ...pos, ...exh };
}
