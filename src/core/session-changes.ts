/**
 * Session Changes — detect the files a single session changed, with before/after
 * content for a GitHub-style diff view.
 *
 * ## Why JSONL, not git
 * `git status` cannot attribute a change to a session: when many agents run in the
 * same repo concurrently, the working tree mixes everyone's edits. A session's own
 * JSONL is per-session isolated and records exactly which files IT touched and how.
 * So the JSONL is the ONLY authoritative source here.
 *
 * ## How before/after is reconstructed (no git, no diff library here)
 * Every Edit records `old_string`+`new_string`; Write records full `content`;
 * MultiEdit records `edits[]`. We replay these ops per file:
 *   - `after`  = the file's CURRENT content on disk (read via the same local/remote
 *                reader the Messages tab uses) — i.e. what the user sees now.
 *   - `before` = `after` with every recorded op REVERSE-applied, newest→oldest, so
 *                it reflects the file as it was when this session first touched it.
 * Reverse-applying onto the real current file keeps full surrounding context and
 * real line numbers, and behaves identically for local and remote sessions because
 * it's all string manipulation on bytes we already fetch. The actual unified-diff
 * synthesis + rendering happens on the FRONTEND (diff + react-diff-view); the
 * backend ships only {before, after} strings.
 *
 * ## Coverage
 * - Main-session edits (canonical JSONL) AND subagent edits (separate subagent
 *   JSONL files — confirmed: subagents that edit write Edit/Write into their own
 *   agent-*.jsonl, NOT inline under parent_tool_use_id).
 * - Cross-repo: a single session can edit files in several repos / submodules.
 *   We group by repo root derived from each file's path + the line's `cwd`.
 * - `.claude` filter: files whose ONLY changes are under .claude/plans or
 *   .claude/projects (Claude/Walnut bookkeeping) are excluded; other .claude
 *   files (settings/skills/commands/hooks) are kept.
 *
 * Performance: live parse (~31ms typical, ~64ms worst measured) + an mtime cache
 * keyed on the canonical JSONL — no background job, no DB.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readSessionJsonlContent,
  isSafeForProjectEncoding,
  remoteJsonlPath,
  resolveSubagentDir,
  extractCwdFromJsonlContent,
} from './session-file-reader.js';
import {
  collectOpsFromJsonl,
  mergeFileMapInto,
  reconstructFile,
  isExcludedPath,
  groupMeta,
  type FileAccum,
  type SessionFileChange,
  type SessionRepoGroup,
  type SessionChangesResult,
} from '../providers/session-changes-core.js';
import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';

// The compute PRIMITIVES (op parse, reverse-apply reconstruction, grouping
// policy) live in providers/session-changes-core.ts, shared verbatim with the
// daemon's host-local pipeline (`changes.compute`) so both paths produce
// identical results. This module owns the SERVER-side concerns: reader-based
// remote I/O (the fallback for daemons without changes-v1), the mtime +
// incremental cache, SWR, and disk snapshots.
export { isExcludedPath } from '../providers/session-changes-core.js';
export type { SessionFileChange, SessionRepoGroup, SessionChangesResult } from '../providers/session-changes-core.js';

// ── Subagent per-file parse cache ──
//
// A whale session's subagents/ dir can dwarf the main JSONL (observed: 9.8MB
// main vs 59MB across 91 agent-*.jsonl). Re-reading ALL of it on every Changed
// tab open was the dominant cost (~15-30s over the tunnel). A finished
// subagent's JSONL never changes, so: list the dir with per-file sizes
// (fs.ls detail:true), re-read ONLY files whose size changed (live agents) or
// that are new, and re-merge cached parsed ops for the rest. Reads run in a
// small parallel pool (the old loop was strictly serial).

interface SubagentCacheEntry {
  size: number;
  fileMap: Map<string, FileAccum>;
}

const SUBAGENT_READ_PARALLELISM = 4;

/** Step-3 current-content reads (one fs.read RPC each). Bounded: an unbounded
 *  Promise.all on a cold whale queued 500-1000 reads on one daemon WS and blew
 *  the 30s per-command timeout for the tail — silent empty records. 16 keeps
 *  the pipe busy without starving the timeout. */
const CONTENT_READ_PARALLELISM = 16;

/** Minimal reader surface (structural — the real DaemonFileReader satisfies it). */
interface SubagentReader {
  listDirDetailed(p: string): Promise<Array<{ name: string; type: string; size?: number }>>;
  readFile(p: string): Promise<string | null>;
}

/**
 * Collect subagent ops into `fileMap`, maintaining `subCache` (mutated in
 * place). Returns the resolved subagents dir (reused across recomputes) plus
 * the file paths whose ops came from NEWLY-READ subagent JSONLs this round —
 * the incremental content-reuse path treats only those as changed.
 */
async function collectSubagentOpsCached(
  reader: SubagentReader,
  sessionId: string,
  effectiveCwd: string | undefined,
  host: string,
  subCache: Map<string, SubagentCacheEntry>,
  subDirCached: string | null | undefined,
  fileMap: Map<string, FileAccum>,
): Promise<{ subDir: string | null; newPaths: Set<string> }> {
  const newPaths = new Set<string>();
  const subDir = subDirCached ?? await resolveSubagentDir(sessionId, effectiveCwd, host);
  if (!subDir) return { subDir: null, newPaths };

  let entries: Array<{ name: string; type: string; size?: number }>;
  try {
    entries = await reader.listDirDetailed(subDir);
  } catch {
    return { subDir, newPaths }; // dir unreadable this round — keep cache for next time
  }
  const jsonls = entries.filter(
    (e) => e.type === 'file' && e.name.startsWith('agent-') && e.name.endsWith('.jsonl'),
  );

  // Drop cache entries for files that vanished from disk.
  const names = new Set(jsonls.map((e) => e.name));
  for (const k of [...subCache.keys()]) {
    if (!names.has(k)) subCache.delete(k);
  }

  // Re-read only new/changed files. size undefined (old daemon without
  // detail support) is stored as -1 → never matches → re-read every time
  // (the pre-cache behavior, so old daemons see no regression).
  const toRead = jsonls.filter((e) => {
    const c = subCache.get(e.name);
    return !(c && typeof e.size === 'number' && c.size === e.size);
  });

  let next = 0;
  const freshlyRead = new Set<string>();
  const worker = async (): Promise<void> => {
    while (next < toRead.length) {
      const e = toRead[next++]!;
      try {
        const content = await reader.readFile(`${subDir}/${e.name}`);
        if (content == null) { subCache.delete(e.name); continue; }
        const parsed = new Map<string, FileAccum>();
        collectOpsFromJsonl(content, parsed);
        subCache.set(e.name, { size: typeof e.size === 'number' ? e.size : -1, fileMap: parsed });
        freshlyRead.add(e.name);
      } catch {
        // skip unreadable file — matches old skip-on-error behavior
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SUBAGENT_READ_PARALLELISM, toRead.length) }, worker),
  );

  // Merge in stable name order so the result is deterministic across cache
  // hits/misses (cross-subagent op order was never chronological anyway).
  for (const name of [...names].sort()) {
    const c = subCache.get(name);
    if (!c) continue;
    mergeFileMapInto(c.fileMap, fileMap);
    if (freshlyRead.has(name)) {
      for (const p of c.fileMap.keys()) newPaths.add(p);
    }
  }
  return { subDir, newPaths };
}

const execFileAsync = promisify(execFile);

/**
 * Recover a deleted file's last-committed content via `git show HEAD:<relpath>`,
 * for LOCAL sessions only (git + the repo are on this host). Returns null when the
 * file wasn't tracked (untracked delete), isn't in a git repo, or git fails — the
 * caller then shows the delete with an empty `before` and marks it partial.
 */
async function readDeletedBeforeLocal(absPath: string): Promise<string | null> {
  try {
    const dir = path.dirname(absPath);
    const root = await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 10_000 });
    const repoRoot = root.stdout.trim();
    if (!repoRoot) return null;
    // git returns the canonical (realpath'd) root, but `absPath` may still carry a
    // symlinked prefix (e.g. macOS /var → /private/var), which would make
    // path.relative produce a spurious `../..`. Canonicalize the containing dir
    // (the file itself is gone, so realpath the parent) before computing rel.
    let realDir = dir;
    try { realDir = await fsp.realpath(dir); } catch { /* dir also gone — use as-is */ }
    const rel = path.relative(repoRoot, path.join(realDir, path.basename(absPath)));
    if (!rel || rel.startsWith('..')) return null;
    const show = await execFileAsync('git', ['-C', repoRoot, 'show', `HEAD:${rel}`], {
      timeout: 10_000, maxBuffer: 64 * 1024 * 1024,
    });
    return show.stdout;
  } catch {
    return null; // untracked / not a repo / git error
  }
}

// ── repo grouping ──

/** Find the nearest ancestor dir containing a `.git` entry (file or dir). Async,
 *  bounded walk. Returns null if none found before the filesystem root. */
export async function findGitRoot(startDir: string, reader: { readFile: (p: string) => Promise<string | null>; listDir: (p: string) => Promise<string[]> }, isRemote: boolean): Promise<string | null> {
  let dir = startDir;
  // Bound the walk to avoid pathological deep paths.
  for (let i = 0; i < 40; i++) {
    if (!dir || dir === '/' || dir === '.') break;
    // A repo root has a `.git` entry. For local we can stat; for remote we listDir
    // the parent once and check membership (cheaper than per-path stat RPCs).
    if (isRemote) {
      const entries = await reader.listDir(dir);
      if (entries.includes('.git')) return dir;
    } else {
      try {
        await fsp.access(path.join(dir, '.git'));
        return dir;
      } catch {
        // not a repo root — keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── mtime cache + incremental parse state ──

/** Incremental-parse state: the main JSONL is append-only, so we remember the
 *  byte offset of the last fully-parsed line and, on the next request, read +
 *  parse only the appended bytes (DaemonFileReader.readFileRange handles the
 *  chunked remote transfer). `mainFileMap` holds ONLY main-JSONL ops from
 *  complete (newline-terminated) lines — never subagent ops or a trailing
 *  partial line, which are re-added per request on a clone.
 *
 *  Rewrite safety (the JSONL is *usually* append-only, but /compact rewrites
 *  it): a shrink (size < parsedBytes) invalidates outright, and a same-or-grown
 *  rewrite is caught by re-reading from `lastLineStart` (a known line boundary,
 *  so utf-8 decoding can't split a char) and verifying the first line still
 *  matches `lastLineCheck`. Mismatch → full re-parse. */
interface IncrementalState {
  /** Byte offset just past the last parsed '\n' (never mid-line). */
  parsedBytes: number;
  /** Byte offset of the START of the last parsed line (re-read for verification). */
  lastLineStart: number;
  /** Cheap identity check of the last parsed line (null when nothing parsed yet). */
  lastLineCheck: { len: number; head: string; tail: string } | null;
  mainFileMap: Map<string, FileAccum>;
  effectiveCwd?: string;
}

function lineCheckOf(line: string): { len: number; head: string; tail: string } {
  return { len: line.length, head: line.slice(0, 64), tail: line.slice(-64) };
}

function lineMatches(line: string, check: { len: number; head: string; tail: string }): boolean {
  return line.length === check.len && line.slice(0, 64) === check.head && line.slice(-64) === check.tail;
}

interface CacheEntry {
  mtimeMs: number;
  result: SessionChangesResult;
  inc?: IncrementalState;
  /** Per-subagent-file parsed ops, keyed by filename, size-validated. Finished
   *  subagent JSONLs never change, so cache hits skip the read entirely — this
   *  is what killed the 59MB-per-open subagent re-read on whale sessions. */
  subCache?: Map<string, SubagentCacheEntry>;
  /** Paths evaluated last compute but DROPPED from the result (clean no-op /
   *  orphan scratch file / excluded). With unchanged ops the verdict holds, so
   *  incremental recomputes skip them without re-reading content — a whale's
   *  hundreds of /tmp scratch files otherwise re-read on every mtime bump. */
  droppedPaths?: Set<string>;
  /** Resolved subagents/ dir (an fs.find for hashed-cwd sessions — cache it). */
  subDir?: string | null;
  /** Git-root lookups persist across recomputes — repo roots don't move, and
   *  re-walking them is listDir-per-level over the tunnel for remote sessions. */
  gitRootByDir: Map<string, string | null>;
  /** Absolute JSONL path resolved via fs.find, for sessions whose cwd is
   *  unknown or too long for our path encoding (Claude Code hashes >200-char
   *  encodings). Without this, such sessions could never stat → never cache →
   *  full re-read on EVERY request (the 46s Changed-tab pain). */
  resolvedPath?: string;
  /** Paths whose content read FAILED (transport error, not ENOENT) last
   *  compute — their records carry empty content, so the reuse path must
   *  re-read them instead of perpetuating the poisoned record. */
  failedPaths?: Set<string>;
  /** True when this entry came from the daemon's changes.compute — the result
   *  is LIGHT (no before/after; per-file content rides changes.file), so peek
   *  must not serve file content from it. mtimeMs/resolvedPath are the daemon-
   *  reported JSONL stat, so the SWR freshness probe works unchanged. */
  daemonBacked?: boolean;
  /** Chars accounted against the cache byte budget, frozen at insert time.
   *  Stored (not recomputed on delete) because `inc.mainFileMap` grows in place
   *  between recomputes — recomputing at delete would drift cacheChars negative. */
  chars?: number;
}
const changesCache = new Map<string, CacheEntry>();
const MAX_CACHE = 30;
// Byte budget across all entries. Entry count alone is not a bound: each entry
// retains full before+after content for every changed file PLUS the incremental
// mainFileMap's op payloads (Edit old/new, Write content) — a whale session can
// hold the same text 3-4×. 30 such entries once contributed hundreds of MB of
// retained heap and multi-second major-GC pauses (the "Quick Session not
// loading" incident). Newest entry is exempt so a single whale still caches
// (its incremental state is what makes Changed-tab polls cheap).
// 64 Mi-chars ≈ 128 MB retained (UTF-16) — same figure as session-history.ts
// but an INDEPENDENT pool with its own budget; tune each on its own evidence.
const MAX_CACHE_CHARS = 64 * 1024 * 1024;
/** Live budget — only tests override it (so eviction tests don't have to
 *  allocate real multi-hundred-MB strings and OOM parallel vitest workers). */
let maxCacheChars = MAX_CACHE_CHARS;
let cacheChars = 0;

/** Approx retained chars of one fileMap's op payloads. */
function fileMapChars(fileMap: Map<string, FileAccum>): number {
  let n = 0;
  for (const accum of fileMap.values()) {
    for (const op of accum.ops) {
      if (op.kind === 'edit') n += op.oldString.length + op.newString.length;
      else if (op.kind === 'write') n += op.content.length;
    }
  }
  return n;
}

/** Approx retained chars of an entry: file before/after + incremental op
 *  payloads + cached subagent op payloads. */
function entryChars(entry: CacheEntry): number {
  let n = 0;
  for (const group of entry.result.groups) {
    for (const f of group.files) n += f.before.length + f.after.length;
  }
  if (entry.inc) n += fileMapChars(entry.inc.mainFileMap);
  if (entry.subCache) {
    for (const c of entry.subCache.values()) n += fileMapChars(c.fileMap);
  }
  return n;
}

/** Shallow-clone a fileMap: new accums + new ops arrays, shared (immutable) op
 *  objects. The cached map must stay main-JSONL-only; per-request additions
 *  (subagent ops, trailing partial line) go onto the clone. */
function cloneFileMap(src: Map<string, FileAccum>): Map<string, FileAccum> {
  const out = new Map<string, FileAccum>();
  for (const [k, v] of src) out.set(k, { ...v, ops: [...v.ops] });
  return out;
}

function cacheKey(sessionId: string, host?: string): string {
  return host ? `${sessionId}@${host}` : sessionId;
}

function cacheGet(key: string): CacheEntry | undefined {
  const entry = changesCache.get(key);
  if (entry) {
    changesCache.delete(key);
    changesCache.set(key, entry);
  }
  return entry;
}

function cacheDelete(key: string): void {
  const prev = changesCache.get(key);
  if (prev) {
    cacheChars -= prev.chars ?? 0;
    changesCache.delete(key);
  }
}

/** Test-only: byte-budget accounting + eviction are otherwise unobservable. */
export function _changesCacheStateForTesting(): { size: number; chars: number; keys: string[] } {
  return { size: changesCache.size, chars: cacheChars, keys: [...changesCache.keys()] };
}
export function _changesCacheSetForTesting(key: string, entry: CacheEntry): void {
  cacheSet(key, entry);
}
export function _changesCacheGetForTesting(key: string): CacheEntry | undefined {
  return cacheGet(key);
}
export function _resetChangesCacheForTesting(): void {
  changesCache.clear();
  cacheChars = 0;
  maxCacheChars = MAX_CACHE_CHARS;
}
/** Test-only: shrink the byte budget so eviction tests use KB-scale strings
 *  instead of allocating real 20-200MB payloads (OOM risk in parallel workers). */
export function _setChangesCacheBudgetForTesting(chars: number): void {
  maxCacheChars = chars;
}

function cacheSet(key: string, entry: CacheEntry): void {
  cacheDelete(key);
  entry.chars = entryChars(entry);
  changesCache.set(key, entry);
  cacheChars += entry.chars;
  // Evict LRU until BOTH bounds hold; the just-inserted entry is exempt.
  for (const oldest of changesCache.keys()) {
    if (changesCache.size <= MAX_CACHE && cacheChars <= maxCacheChars) break;
    if (oldest === key) continue;
    cacheDelete(oldest);
  }
}

/** Re-sync one LIVE entry's chars after its `inc.mainFileMap` grew in place
 *  mid-recompute. Without this, a throw before the request's final cacheSet
 *  leaves the entry under-accounted against MAX_CACHE_CHARS indefinitely.
 *  No-op if the entry was concurrently evicted (its chars left the budget
 *  with it — re-accounting then would corrupt cacheChars). */
function cacheReaccount(key: string, entry: CacheEntry): void {
  if (changesCache.get(key) !== entry) return;
  cacheChars -= entry.chars ?? 0;
  entry.chars = entryChars(entry);
  cacheChars += entry.chars;
  for (const oldest of changesCache.keys()) {
    if (cacheChars <= maxCacheChars) break;
    if (oldest === key) continue;
    cacheDelete(oldest);
  }
}

/** Split JSONL content at the last newline: `complete` (newline-terminated,
 *  safe to parse + byte-account) vs `tail` (a possibly-partial final line that
 *  is parsed per-request but never enters the incremental state). */
function splitCompleteLines(content: string): { complete: string; tail: string } {
  const lastNl = content.lastIndexOf('\n');
  if (lastNl === -1) return { complete: '', tail: content };
  return { complete: content.slice(0, lastNl + 1), tail: content.slice(lastNl + 1) };
}

/** Text of the final line in a newline-terminated block (without its '\n'). */
function lastLineOf(complete: string): string {
  const withoutFinal = complete.slice(0, -1);
  return withoutFinal.slice(withoutFinal.lastIndexOf('\n') + 1);
}

// ── Streaming full parse (bounded memory) ──

function isByteCeilingError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('byte ceiling');
}

/** Reader surface for the streaming parse (DaemonFileReader satisfies it). */
interface RangeByteReader {
  readRangeBytes(p: string, start: number, length: number): Promise<{ buf: Buffer; fileSize: number; eof: boolean } | null>;
}

const STREAM_WINDOW = 1024 * 1024;

/**
 * Stream-parse an ENTIRE JSONL into `fileMap` in bounded windows, never
 * materializing the file as one string. Whale transcripts legitimately exceed
 * the whole-file read ceiling (34MB+ observed) — a readFileRange(0) full read
 * REJECTS them, which used to make the Changed tab fail outright for such
 * sessions. Windows are newline-aligned before decoding (a '\n' is one byte in
 * UTF-8, so complete blocks are always decode-safe); the carry — bytes after
 * the last newline seen — rides to the next window. Peak memory ≈ one window
 * + the longest line, regardless of file size.
 *
 * Returns byte-exact incremental anchors (same semantics the readFileRange(0)
 * path produced): `parsedBytes`/`lastLineStart` are true file byte offsets.
 * `headBlock` is the first decoded block (for extractCwdFromJsonlContent —
 * cwd is on the first user line). Returns null on ENOENT.
 */
async function streamParseJsonlFull(
  reader: RangeByteReader,
  jsonlPath: string,
  fileMap: Map<string, FileAccum>,
  deadlineMs: number,
): Promise<{ parsedBytes: number; lastLineStart: number; lastLine: string; tail: string; headBlock: string } | null> {
  let offset = 0;                 // next file byte to request
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0); // bytes after the last '\n' seen so far
  let carryStartAbs = 0;          // absolute file offset where `carry` begins
  let lastLine = '';
  let lastLineStart = 0;
  let headBlock = '';
  for (;;) {
    if (Date.now() > deadlineMs) throw new Error('Session file stream-parse timeout');
    const res = await reader.readRangeBytes(jsonlPath, offset, STREAM_WINDOW);
    if (res === null) return null; // ENOENT
    if (res.buf.length > 0) {
      const buf = carry.length ? Buffer.concat([carry, res.buf]) : res.buf;
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl !== -1) {
        const completeBytes = lastNl + 1;
        const text = buf.subarray(0, completeBytes).toString('utf-8');
        collectOpsFromJsonl(text, fileMap);
        if (!headBlock) headBlock = text;
        // The block starts right after a '\n' (or at byte 0), so its last line
        // is fully contained in `text` — the carry never holds a newline.
        lastLine = lastLineOf(text);
        lastLineStart = carryStartAbs + completeBytes - Buffer.byteLength(lastLine, 'utf-8') - 1;
        // Copy the remainder so the big window buffer can be freed.
        carry = Buffer.from(buf.subarray(completeBytes));
        carryStartAbs += completeBytes;
      } else {
        carry = buf;
      }
      offset += res.buf.length;
    }
    if (res.eof) break;
  }
  // carryStartAbs = offset just past the last '\n' = the parsed-bytes anchor.
  return { parsedBytes: carryStartAbs, lastLineStart, lastLine, tail: carry.toString('utf-8'), headBlock };
}

// ── Disk snapshot (light result) — instant list across server restarts ──
//
// The in-memory cache dies with the process; a whale session's first Changed
// open after a deploy paid the full 20-40s again. We persist a LIGHT result
// (paths/status/ops only — before/after stripped, so a 551-file whale is
// ~100KB) and serve it instantly with stale+light flags while the real
// recompute runs. Never a source of truth — purely a first-paint accelerator.

function snapshotPath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._@-]/g, '-');
  return path.join(WALNUT_HOME, 'cache', 'session-changes', `${safe}.json`);
}

function toLightResult(result: SessionChangesResult): SessionChangesResult {
  return {
    ...result,
    groups: result.groups.map((g) => ({
      ...g,
      files: g.files.map((f) => ({ ...f, before: '', after: '' })),
    })),
  };
}

async function writeDiskSnapshot(key: string, result: SessionChangesResult): Promise<void> {
  try {
    const p = snapshotPath(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    // Same-dir tmp + rename: atomic on POSIX, avoids EXDEV.
    const tmp = `${p}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(toLightResult(result)), 'utf-8');
    await fsp.rename(tmp, p);
  } catch { /* best-effort — never fail the request over a snapshot */ }
}

async function readDiskSnapshot(key: string): Promise<SessionChangesResult | null> {
  try {
    const raw = await fsp.readFile(snapshotPath(key), 'utf-8');
    const parsed = JSON.parse(raw) as SessionChangesResult;
    if (!Array.isArray(parsed.groups)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Stale-while-revalidate wrapper: return SOMETHING paintable immediately.
 *  1. In-memory cache, file mtime UNCHANGED → the result is CURRENT: serve it
 *     with no flags (this is what lets the frontend's convergence POLL stop).
 *  2. In-memory cache, mtime moved/unknown → serve it (stale:true) +
 *     background recompute.
 *  3. Disk snapshot → serve it (stale:true, light:true) + background recompute.
 *  4. Nothing       → block on the normal compute (cold first open).
 * The background kick is DEDUPED against the in-flight chain: the frontend
 * polls this endpoint every few seconds while stale, and each poll must not
 * queue another whale recompute behind the running one.
 */
export async function computeSessionChangesSwr(
  sessionId: string,
  cwd?: string,
  host?: string,
  outputFile?: string,
): Promise<SessionChangesResult> {
  const key = cacheKey(sessionId, host);
  const kickRefresh = (): void => {
    if (inflightByKey.has(key)) return; // a compute is already running/queued
    void computeSessionChanges(sessionId, cwd, host, outputFile).catch(() => { /* logged inside */ });
  };
  const entry = cacheGet(key);
  if (entry) {
    // Freshness probe (one fs.stat): mtime unchanged → the cached result IS
    // current (same check as the compute's fast-path), so don't mark it stale.
    try {
      const jsonlPath = entry.resolvedPath
        ?? (cwd && isSafeForProjectEncoding(cwd) ? remoteJsonlPath(sessionId, cwd) : null);
      if (jsonlPath) {
        const { DaemonFileReader } = await import('./daemon-file-reader.js');
        const st = await new DaemonFileReader(host ?? '__local__').stat(jsonlPath);
        if (st && st.mtimeMs === entry.mtimeMs) return entry.result;
      }
    } catch { /* stat failed — treat as stale */ }
    kickRefresh();
    return { ...entry.result, stale: true, refreshing: true };
  }
  const disk = await readDiskSnapshot(key);
  if (disk && disk.sessionId === sessionId) {
    kickRefresh();
    return { ...disk, stale: true, refreshing: true, light: true };
  }
  return computeSessionChanges(sessionId, cwd, host, outputFile);
}

/**
 * Non-blocking peek at ONE file's change record from the in-memory cache,
 * even when the cache is outdated (mtime moved). Serves the Changed tab's
 * per-file diff while a background recompute holds the in-flight chain —
 * without this, a click lands BEHIND a 20-40s whale recompute (observed 31s).
 * Returns null when the session/file isn't cached; caller falls back to the
 * blocking compute.
 */
export function peekSessionFileChange(
  sessionId: string,
  host: string | undefined,
  filePath: string,
): { repoRoot: string; file: SessionFileChange } | null {
  const entry = cacheGet(cacheKey(sessionId, host));
  if (!entry) return null;
  // Daemon-backed entries are LIGHT (no before/after) — serving one here would
  // paint an empty diff. Return null so the caller fetches via changes.file.
  if (entry.daemonBacked) return null;
  for (const group of entry.result.groups) {
    const file = group.files.find((f) => f.filePath === filePath);
    if (file) return { repoRoot: group.repoRoot, file };
  }
  return null;
}

// ── Main entry ──

/**
 * Compute the set of files a session changed, with reconstructed before/after.
 *
 * @param sessionId  Claude session id.
 * @param cwd        Session working directory (for path encoding + repo grouping).
 * @param host       SSH host alias for remote sessions; undefined for local.
 * @param outputFile Optional output-file fallback (same as readSessionHistory).
 */
export async function computeSessionChanges(
  sessionId: string,
  cwd?: string,
  host?: string,
  outputFile?: string,
  opts?: { noCache?: boolean },
): Promise<SessionChangesResult> {
  // Serialize per session key. The Changed tab and the Files panel's
  // quick-access fetch fire CONCURRENTLY for the same session; two overlapping
  // computes would both consume the same incremental state and double-merge
  // the appended ops (a duplicated Edit reverse-applies twice → wrong before).
  // The follower re-checks the mtime cache, so it's a cheap cache hit.
  const key = cacheKey(sessionId, host);
  const prev = inflightByKey.get(key) ?? Promise.resolve();
  const run = prev
    .catch(() => { /* prior failure doesn't gate us */ })
    .then(() => computeSessionChangesInner(key, sessionId, cwd, host, outputFile, opts));
  inflightByKey.set(key, run);
  void run.finally(() => {
    if (inflightByKey.get(key) === run) inflightByKey.delete(key);
  }).catch(() => { /* observed by the caller */ });
  return run;
}

const inflightByKey = new Map<string, Promise<SessionChangesResult>>();

/** True while a compute for this session is running/queued (SWR kick + the
 *  background pre-warmer use this to avoid queuing duplicate work). */
export function hasInflightSessionChanges(sessionId: string, host?: string): boolean {
  return inflightByKey.has(cacheKey(sessionId, host));
}

// ── Daemon-side compute (capability 'changes-v1') ──
// Design-principle path (AGENTS.md): the daemon parses the session's JSONLs +
// reads file contents ON ITS OWN HOST; only the LIGHT list crosses the tunnel,
// and per-file diffs ride changes.file on selection. The reader-based pipeline
// below remains as the fallback for daemons without the capability (source
// deploys, old binaries) — results are identical (same core module).

const CHANGES_RPC_TIMEOUT_MS = 120_000;

/** The daemon connection for a host IF it's already connected and speaks
 *  changes-v1. Never dials: a cold dial belongs to the reader path's laziness,
 *  and a disconnected host should fall back, not block. */
async function changesCapableConnection(host: string | undefined): Promise<import('../providers/daemon-connection.js').DaemonConnection | null> {
  try {
    const { getConnectedDaemonConnection } = await import('../providers/daemon-connection.js');
    const conn = getConnectedDaemonConnection(host ?? '__local__');
    if (conn && conn.hasCapability('changes-v1')) return conn;
  } catch { /* provider layer unavailable (tests) */ }
  return null;
}

/** Fetch the light list from the daemon. Returns null when the daemon can't
 *  serve it (no capability / no session file / RPC failure) — caller falls
 *  back to the reader-based compute. */
async function computeViaDaemon(
  sessionId: string,
  cwd: string | undefined,
  host: string | undefined,
  refresh: boolean,
): Promise<{ result: SessionChangesResult; mtimeMs: number; jsonlPath: string } | null> {
  const conn = await changesCapableConnection(host);
  if (!conn) return null;
  const res = await conn.send('changes.compute', {
    sid: sessionId, ...(cwd ? { cwd } : {}), ...(refresh ? { refresh: true } : {}),
  }, CHANGES_RPC_TIMEOUT_MS);
  if (!res.ok || res.found !== true || !res.result) return null;
  const result = res.result as SessionChangesResult;
  if (!Array.isArray(result.groups)) return null;
  return {
    result,
    mtimeMs: typeof res.mtimeMs === 'number' ? res.mtimeMs : -1,
    jsonlPath: typeof res.jsonlPath === 'string' ? res.jsonlPath : '',
  };
}

/** One file's full record from the daemon (blocking, but host-local so fast). */
export async function fetchSessionFileChangeViaDaemon(
  sessionId: string,
  cwd: string | undefined,
  host: string | undefined,
  filePath: string,
): Promise<{ repoRoot: string; file: SessionFileChange } | null> {
  const conn = await changesCapableConnection(host);
  if (!conn) return null;
  const res = await conn.send('changes.file', {
    sid: sessionId, path: filePath, ...(cwd ? { cwd } : {}),
  }, CHANGES_RPC_TIMEOUT_MS);
  if (!res.ok || res.found !== true || !res.file) return null;
  return { repoRoot: res.repoRoot as string, file: res.file as SessionFileChange };
}

async function computeSessionChangesInner(
  key: string,
  sessionId: string,
  cwd?: string,
  host?: string,
  outputFile?: string,
  opts?: { noCache?: boolean },
): Promise<SessionChangesResult> {
  const t0 = Date.now();

  // Daemon-side compute first (both hosts and __local__ run a daemon). The
  // daemon result is LIGHT (no before/after) — cached + snapshotted like any
  // result; per-file content loads through changes.file on selection. noCache
  // (?refresh=1) also goes through: the daemon's own mtime check handles it.
  try {
    const daemonResult = await computeViaDaemon(sessionId, cwd, host, opts?.noCache === true);
    if (daemonResult) {
      const light: SessionChangesResult = { ...daemonResult.result, light: true };
      // The daemon reports the JSONL's real (mtimeMs, jsonlPath) so the SWR
      // freshness probe works unchanged: probe stats the same file the daemon
      // keyed its cache on. daemonBacked marks the entry as content-light.
      cacheSet(key, {
        mtimeMs: daemonResult.mtimeMs, result: light,
        gitRootByDir: new Map(),
        resolvedPath: daemonResult.jsonlPath || undefined,
        daemonBacked: true,
      });
      void writeDiskSnapshot(key, light);
      log.session.info('session-changes computed', {
        sessionId, host: host ?? '__local__', parseMode: 'daemon', fileCount: light.fileCount,
        durationMs: Date.now() - t0,
      });
      return light;
    }
  } catch (err) {
    log.session.debug('session-changes: daemon compute failed — falling back to reader path', {
      sessionId, host: host ?? '__local__', error: err instanceof Error ? err.message : String(err),
    });
  }

  // mtime fast-path + incremental parse. The canonical JSONL is append-only, so:
  //   mtime unchanged            → cached result verbatim.
  //   mtime changed, size grew   → read + parse ONLY the appended bytes
  //                                (fs.readRange from the cached byte offset),
  //                                merged into the cached main-JSONL op map.
  //   size shrank (/compact) or  → full read + full parse, state rebuilt.
  //   no prior state / ?refresh=1
  // DAEMON-UNIFORM: both local (__local__) and remote go through the daemon's
  // fs.stat / fs.readRange. cwd known + safe → exact tilde path; else skip the
  // cache + incremental entirely (a find just to stat isn't worth it).
  let mtimeMs: number | undefined;
  let statSize: number | undefined;
  const { DaemonFileReader } = await import('./daemon-file-reader.js');
  const reader = new DaemonFileReader(host ?? '__local__');
  // The cache is consulted even under ?refresh=1 for its resolvedPath (a find
  // result — refresh means "re-read the data", not "forget where the file is");
  // the cached RESULT is only served when noCache is off.
  const cachedEntry = cacheGet(key);
  const cached = opts?.noCache ? undefined : cachedEntry;

  // Resolve the JSONL path. cwd known + safe → exact tilde path. Otherwise
  // (cwd unknown, or its encoding exceeds 200 chars → Claude Code hashes it and
  // our computed path would be wrong) resolve the ABSOLUTE path once via
  // fs.find and keep it in the cache — without this, such sessions can never
  // stat → never cache → full multi-MB re-read on every request.
  let jsonlPath = cwd && isSafeForProjectEncoding(cwd) ? remoteJsonlPath(sessionId, cwd) : null;
  let resolvedPath = cachedEntry?.resolvedPath;
  if (!jsonlPath) {
    if (!resolvedPath) {
      try {
        resolvedPath = (await reader.findSessionPath(sessionId)) ?? undefined;
      } catch {
        // find failed — legacy full read below.
      }
    }
    if (resolvedPath) jsonlPath = resolvedPath;
  }

  if (jsonlPath) {
    try {
      const statResult = await reader.stat(jsonlPath);
      if (statResult) {
        mtimeMs = statResult.mtimeMs;
        statSize = statResult.size;
        if (cached && cached.mtimeMs === mtimeMs) return cached.result;
      } else if (resolvedPath && jsonlPath === resolvedPath) {
        // The cached find result went stale (file moved/deleted) — drop it.
        resolvedPath = undefined;
        jsonlPath = null;
      }
    } catch {
      // stat failed (transport / old daemon) — proceed with full read.
    }
  }

  // 1. Main-session JSONL ops. Incremental when possible; else full read.
  //    `fileMap` is the per-request map: cached main ops (cloned) + appended
  //    ops + trailing-partial-line ops + subagent ops. The cache's own
  //    `mainFileMap` only ever accumulates complete main-JSONL lines.
  let fileMap: Map<string, FileAccum> | null = null;
  let inc: IncrementalState | undefined;
  let effectiveCwd = cwd;
  let parseMode: 'incremental' | 'full' | 'legacy' = 'legacy';
  // Paths whose ops CHANGED this round (new main-JSONL ops / newly-read
  // subagent files). null = unknown → treat every file as changed (full/legacy
  // parse). Incremental recomputes use it to reuse the cached before/after for
  // untouched files instead of re-reading every file's current content — the
  // dominant recompute cost for LIVE whale sessions (mtime moves every turn,
  // and each recompute paid 100-1200 content reads over the daemon RPC).
  let changedPaths: Set<string> | null = null;
  const READ_TIMEOUT = host ? 120_000 : 30_000;
  const withTimeout = <T>(p: Promise<T>): Promise<T> => Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Session file read timeout (${READ_TIMEOUT / 1000}s)`)), READ_TIMEOUT)),
  ]);

  if (jsonlPath && statSize !== undefined) {
    try {
      const prior = cached?.inc;
      if (prior && prior.lastLineCheck && statSize >= prior.parsedBytes) {
        // Incremental: re-read from the START of the last parsed line (a known
        // line boundary — utf-8 safe) so we can verify it's byte-identical
        // before trusting the append-only assumption. A ceiling rejection here
        // (>32MB appended since last parse — possible after a long-idle cache
        // entry survives while the session keeps running) must NOT bail to the
        // legacy whole-file read (which re-throws the ceiling): fall through to
        // the streaming full parse instead.
        let range: { content: string; fileSize: number } | null = null;
        try {
          range = await withTimeout(reader.readFileRange(jsonlPath, prior.lastLineStart));
        } catch (err) {
          if (!isByteCeilingError(err)) throw err;
        }
        if (range !== null) {
          const nl = range.content.indexOf('\n');
          const firstLine = nl === -1 ? range.content : range.content.slice(0, nl);
          if (nl !== -1 && lineMatches(firstLine, prior.lastLineCheck)) {
            const appended = range.content.slice(nl + 1);
            const { complete, tail } = splitCompleteLines(appended);
            changedPaths = new Set<string>();
            if (complete) {
              // Double-parse the (small) appended block: once into a throwaway
              // map purely to learn WHICH paths got new ops, once into the
              // cached map with unchanged merge semantics.
              const tempNew = new Map<string, FileAccum>();
              collectOpsFromJsonl(complete, tempNew);
              for (const [p, a] of tempNew) {
                changedPaths.add(p);
                for (const op of a.ops) if (op.kind === 'rename') changedPaths.add(op.from);
              }
              collectOpsFromJsonl(complete, prior.mainFileMap);
              const lastLine = lastLineOf(complete);
              prior.lastLineStart = prior.parsedBytes + Buffer.byteLength(complete, 'utf-8')
                - Buffer.byteLength(lastLine, 'utf-8') - 1;
              prior.lastLineCheck = lineCheckOf(lastLine);
              prior.parsedBytes += Buffer.byteLength(complete, 'utf-8');
              // The cached entry just grew IN PLACE while it stays live in the
              // cache. Re-account immediately: a throw later in this request
              // (subagent/current-file reads) skips the final cacheSet, and a
              // stale `chars` would under-count this entry against the byte
              // budget for as long as it lives.
              if (cached) cacheReaccount(key, cached);
            }
            inc = prior;
            fileMap = cloneFileMap(prior.mainFileMap);
            if (tail) {
              // Trailing partial line: parse into the clone AND mark its paths
              // changed (its ops are per-request, never cached).
              const tempTail = new Map<string, FileAccum>();
              collectOpsFromJsonl(tail, tempTail);
              for (const p of tempTail.keys()) changedPaths.add(p);
              collectOpsFromJsonl(tail, fileMap);
            }
            effectiveCwd = prior.effectiveCwd ?? cwd;
            parseMode = 'incremental';
          }
          // Verification failed (rewrite, e.g. /compact) → fall through to full.
        }
      }
      if (fileMap === null) {
        // Full parse that ESTABLISHES incremental state — STREAMED in bounded
        // windows (readRangeBytes), never the file as one string: whale
        // transcripts exceed the whole-file read ceiling (34MB+ observed), and
        // the old readFileRange(0) read was REJECTED for them, failing the tab
        // outright. parsedBytes/lastLineStart stay true file byte offsets
        // (readSessionJsonlContent may append synthetic stream events, which
        // would corrupt byte accounting — another reason to read raw).
        const mainFileMap = new Map<string, FileAccum>();
        const streamed = await streamParseJsonlFull(
          reader, jsonlPath, mainFileMap, Date.now() + READ_TIMEOUT,
        );
        if (streamed !== null) {
          effectiveCwd = extractCwdFromJsonlContent(streamed.headBlock) ?? cwd;
          inc = {
            parsedBytes: streamed.parsedBytes,
            lastLineStart: streamed.lastLineStart,
            lastLineCheck: streamed.parsedBytes > 0 ? lineCheckOf(streamed.lastLine) : null,
            mainFileMap,
            effectiveCwd,
          };
          fileMap = cloneFileMap(mainFileMap);
          if (streamed.tail) collectOpsFromJsonl(streamed.tail, fileMap);
          parseMode = 'full';
        }
        // streamed === null (ENOENT) → fileMap stays null → legacy fallbacks.
      }
    } catch (err) {
      log.session.debug('session-changes: incremental read failed, falling back to legacy', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
      fileMap = null;
      inc = undefined;
    }
  }

  // Legacy path: cwd unknown/unsafe, stat failed, or the direct read failed —
  // full read through readSessionJsonlContent (glob/find/stream fallbacks).
  if (fileMap === null) {
    fileMap = new Map<string, FileAccum>();
    const main = await readSessionJsonlContent(sessionId, cwd, host, outputFile);
    if (main) collectOpsFromJsonl(main.content, fileMap);
    // foundCwd from JSONL beats a possibly-stale param cwd.
    effectiveCwd = main?.foundCwd ?? cwd;
    parseMode = 'legacy';
  }

  // 2. Subagent JSONLs — subagents that edit write into their own files.
  //    Per-file size-keyed cache: only new/grown files are re-read (finished
  //    subagents never change), reads run in a small parallel pool.
  //    `cached` (not `cachedEntry`): ?refresh=1 must re-read subagent DATA too.
  //    subDir: when the main JSONL path is known, the subagents dir is ALWAYS
  //    its sibling — derive it (never stale). The cached value only serves the
  //    legacy path (no jsonlPath), where deriving would cost another fs.find.
  const subCache = cached?.subCache ?? new Map<string, SubagentCacheEntry>();
  let subDir = jsonlPath
    ? jsonlPath.replace(/\.jsonl$/, '') + '/subagents'
    : cachedEntry?.subDir;
  // The subCache is keyed by FILENAME — valid only within one subagents dir.
  // If the dir moved (session re-keyed to a different cwd), same-named files
  // with identical sizes would false-hit; drop the cache.
  if (cached?.subDir && subDir && cached.subDir !== subDir) subCache.clear();
  try {
    const subResult = await collectSubagentOpsCached(
      reader, sessionId, effectiveCwd, host ?? '__local__', subCache, subDir, fileMap,
    );
    subDir = subResult.subDir;
    if (changedPaths) for (const p of subResult.newPaths) changedPaths.add(p);
  } catch (err) {
    // Unknown what changed in subagents — disable content reuse this round.
    changedPaths = null;
    log.session.debug('session-changes: subagent read failed', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
  // subCache grew IN PLACE on a live entry (same hazard as inc.mainFileMap):
  // re-account now so a throw before the final cacheSet can't leave the entry
  // under-counted against the byte budget.
  if (cached) cacheReaccount(key, cached);

  // Git-root walk cache persists across recomputes (roots don't move; remote
  // walks are listDir-per-level RPCs). Kept even when fileMap is empty.
  const gitRootByDir = cached?.gitRootByDir ?? new Map<string, string | null>();

  if (fileMap.size === 0) {
    const empty: SessionChangesResult = { sessionId, groups: [], fileCount: 0, anyPartial: false };
    if (mtimeMs !== undefined) cacheSet(key, { mtimeMs, result: empty, inc, subCache, subDir, gitRootByDir, resolvedPath });
    return empty;
  }

  // 3. Read current content for each file (after) + reconstruct before.
  //    (createFileReader returns a DaemonFileReader for the same host — reuse ours.)
  const isRemote = !!host;

  // Resolve a per-file change record. For a DELETED file (last op = rm/git rm),
  // recover the removed content from git so the diff shows what was lost: local
  // sessions run `git show HEAD:<relpath>` in-process; remote sessions can't
  // (no per-file SSH), so the delete still shows with an empty before + partial.
  //
  // Content-read reuse: on an incremental recompute (`changedPaths` known), a
  // file whose ops did NOT change this round reuses the cached record verbatim
  // instead of re-reading its content — this was the dominant recompute cost
  // for live whale sessions (100-1200 reader.readFile RPCs per mtime bump,
  // 30s+ observed). Trade-off: an out-of-band disk edit to an untouched file
  // shows stale until the next full parse or ?refresh=1 — acceptable for a
  // view scoped to what THE SESSION changed.
  const priorChanges = new Map<string, SessionFileChange>();
  if (changedPaths && cached) {
    for (const g of cached.result.groups) {
      for (const f of g.files) priorChanges.set(f.filePath, f);
    }
  }
  let reusedRecords = 0;
  const changesByPath = new Map<string, SessionFileChange>();
  // Reads run in a BOUNDED pool, not one Promise.all over every file: a cold
  // whale fires 500-1000 concurrent fs.read RPCs down ONE daemon WS, and the
  // queue pushes tail commands past the 30s command timeout — those files came
  // back as silent empty/partial records ("nothing changed" in the UI).
  const failedPaths = new Set<string>();
  const readEntries = [...fileMap.values()];
  let nextRead = 0;
  const tRead = Date.now();
  const readWorker = async (): Promise<void> => {
    while (nextRead < readEntries.length) {
      const accum = readEntries[nextRead++]!;
      if (changedPaths && !changedPaths.has(accum.filePath)
          && !cached?.failedPaths?.has(accum.filePath)) {
        const prior = priorChanges.get(accum.filePath);
        if (prior) {
          reusedRecords++;
          changesByPath.set(accum.filePath, { ...prior, relPath: accum.filePath });
          continue;
        }
        // Dropped last time (clean no-op / orphan / excluded) with unchanged
        // ops → same verdict; skip without a read. No record in changesByPath
        // = the grouping loop drops it again.
        if (cached?.droppedPaths?.has(accum.filePath)) {
          reusedRecords++;
          continue;
        }
        // Genuinely unknown (first sight without ops change is rare — e.g.
        // cache built by an older build) — fall through to a real read.
      }
      let current: string | null = null;
      try {
        current = await reader.readFile(accum.filePath);
      } catch {
        // Transport failure (NOT ENOENT — that's a null return). The record
        // below carries empty content + partial; remember the path so the
        // next recompute RE-READS it instead of reusing the poisoned record.
        current = null;
        failedPaths.add(accum.filePath);
      }
      const isDeleted = accum.ops[accum.ops.length - 1]?.kind === 'delete';
      const deletedBefore = isDeleted && !isRemote
        ? await readDeletedBeforeLocal(accum.filePath)
        : null;
      const { renamedFrom, ...recon } = reconstructFile(current, accum, deletedBefore);
      const change: SessionFileChange = { filePath: accum.filePath, relPath: accum.filePath, ...recon };
      // renamedFrom is absolute here; converted to a repo-relative oldRelPath once
      // the repo root is known (grouping step below).
      if (renamedFrom !== undefined) change.oldRelPath = renamedFrom;
      changesByPath.set(accum.filePath, change);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONTENT_READ_PARALLELISM, readEntries.length) }, readWorker),
  );
  const readMs = Date.now() - tRead;

  // 4. Group by repo root.
  //    Resolve the cwd repo root once (anchors cwd/submodule classification).
  const cwdRepoRoot = effectiveCwd ? await findGitRoot(effectiveCwd, reader, isRemote) : null;

  // True if `child` is `ancestor` or lives inside it (so a relPath against
  // `ancestor` won't need to escape with `../`).
  const isUnder = (child: string, ancestor: string): boolean =>
    child === ancestor || child.startsWith(ancestor + path.sep);

  // Resolve repo root per file (cache the raw git-root lookup by directory to
  // limit walks). The fallback when there's no .git must NEVER anchor a file to a
  // repo it doesn't live under — doing so produced display paths like
  // `../../../../../tmp/foo` for scratch files the session wrote outside its repo.
  // So: prefer the file's own git root; else the cwd repo root / recorded cwd ONLY
  // if the file is actually under it; else the file's own directory.
  //
  // `orphan` flags that last case (no git repo AND not under the session's cwd) —
  // a stray scratch file the session wrote elsewhere on disk (e.g. /tmp). The git
  // comparison modes can't diff such a file (it's in no repo), so to keep every
  // mode showing the SAME set ("doesn't matter which we choose"), we drop orphans.
  // (gitRootByDir is hoisted above and persisted in the cache across recomputes.)
  const resolveRepoRoot = async (filePath: string, fileCwd?: string): Promise<{ root: string; orphan: boolean }> => {
    const dir = path.dirname(filePath);
    let gitRoot: string | null;
    if (gitRootByDir.has(dir)) {
      gitRoot = gitRootByDir.get(dir)!;
    } else {
      gitRoot = await findGitRoot(dir, reader, isRemote);
      gitRootByDir.set(dir, gitRoot);
    }
    if (gitRoot) return { root: gitRoot, orphan: false };
    if (cwdRepoRoot && isUnder(filePath, cwdRepoRoot)) return { root: cwdRepoRoot, orphan: false };
    if (effectiveCwd && isUnder(filePath, effectiveCwd)) return { root: effectiveCwd, orphan: false };
    if (fileCwd && isUnder(filePath, fileCwd)) return { root: fileCwd, orphan: false };
    return { root: dir, orphan: true };
  };

  const groupsByRoot = new Map<string, SessionRepoGroup>();
  // Paths that get no record in the final result — persisted so incremental
  // recomputes can skip re-evaluating them while their ops are unchanged.
  const droppedPaths = new Set<string>(cached?.droppedPaths ?? []);
  for (const accum of fileMap.values()) {
    const change = changesByPath.get(accum.filePath);
    if (!change) continue; // reused drop verdict (or read raced a delete)
    // Drop CLEAN net no-op edits: the session touched the file but reconstruction
    // (which succeeded — not partial) shows no actual change, e.g. edited then
    // reverted to the same bytes. An empty diff is noise, and it's exactly why the
    // default mode listed files the git modes — which only surface real changes —
    // did not. We keep `partial` no-ops: there before===after only because
    // reconstruction couldn't compute a real before (the file changed on disk
    // after the edit), so it IS a real change, just not perfectly reconstructable.
    // EXCEPT renames/deletes: a pure move has before===after content but is still
    // a real structural change the user wants to see.
    const structural = change.status === 'renamed' || change.status === 'deleted';
    if (change.before === change.after && !change.partial && !structural) {
      droppedPaths.add(accum.filePath);
      continue;
    }
    const { root, orphan } = await resolveRepoRoot(accum.filePath, accum.cwd);
    // Skip stray out-of-repo scratch files (see resolveRepoRoot) so the set
    // matches the git modes, which can never show a non-repo file.
    if (orphan) { droppedPaths.add(accum.filePath); continue; }
    // Shown this round → not dropped (ops may have re-materialized a diff).
    droppedPaths.delete(accum.filePath);
    change.relPath = path.relative(root, accum.filePath) || path.basename(accum.filePath);
    // Convert an absolute rename source to a repo-relative display path (fall back
    // to a basename if it lived outside this root). A REUSED prior record's
    // oldRelPath is already repo-relative — converting again would mangle it.
    if (change.oldRelPath && path.isAbsolute(change.oldRelPath)) {
      const relOld = path.relative(root, change.oldRelPath);
      change.oldRelPath = relOld && !relOld.startsWith('..') ? relOld : path.basename(change.oldRelPath);
    }

    let group = groupsByRoot.get(root);
    if (!group) {
      const meta = groupMeta(root, effectiveCwd, cwdRepoRoot);
      group = { repoRoot: root, label: meta.label, kind: meta.kind, files: [] };
      groupsByRoot.set(root, group);
    }
    group.files.push(change);
  }

  // 5. Filtering: drop bookkeeping (plans / Claude per-project memory) AND agent
  //    memory-store entries (the butler's or a subagent's MEMORY.md / notes) —
  //    they're agent scratch, not reviewable code. A whole group made only of
  //    these is dropped in step 6. Other .claude files (settings/skills/...) stay.
  for (const group of groupsByRoot.values()) {
    group.files = group.files.filter((f) => {
      if (isExcludedPath(f.filePath)) { droppedPaths.add(f.filePath); return false; }
      return true;
    });
  }

  // 6. Order: cwd group first, then submodules, then other repos; files sorted by relPath.
  const kindOrder: Record<SessionRepoGroup['kind'], number> = { cwd: 0, submodule: 1, other: 2 };
  const groups = [...groupsByRoot.values()]
    .filter((g) => g.files.length > 0)
    .sort((a, b) => (kindOrder[a.kind] - kindOrder[b.kind]) || a.label.localeCompare(b.label));
  for (const g of groups) {
    g.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  const fileCount = groups.reduce((n, g) => n + g.files.length, 0);
  const anyPartial = groups.some((g) => g.files.some((f) => f.partial));
  const result: SessionChangesResult = { sessionId, groups, fileCount, anyPartial };

  if (mtimeMs !== undefined) {
    cacheSet(key, {
      mtimeMs, result, inc, subCache, subDir, droppedPaths, gitRootByDir, resolvedPath,
      ...(failedPaths.size ? { failedPaths } : {}),
    });
  }
  void writeDiskSnapshot(key, result);
  log.session.info('session-changes computed', {
    sessionId, host: host ?? '__local__', parseMode, fileCount, reusedRecords,
    readMs, failedReads: failedPaths.size, durationMs: Date.now() - t0,
  });
  return result;
}
