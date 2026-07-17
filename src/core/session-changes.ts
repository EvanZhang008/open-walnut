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
  readSubagentContents,
  isSafeForProjectEncoding,
  remoteJsonlPath,
  extractCwdFromJsonlContent,
} from './session-file-reader.js';
import { parseBashFileOps } from './bash-file-ops.js';
import { log } from '../logging/index.js';

// ── Public types (shared shape with the frontend api wrapper) ──

/** A single file the session changed, with reconstructed before/after content. */
export interface SessionFileChange {
  /** Absolute path as recorded in the JSONL. */
  filePath: string;
  /** Path relative to its repo root (display). */
  relPath: string;
  /** Content when the session first touched the file (after reverse-applying ops). */
  before: string;
  /** Current content on disk (what the user sees now). */
  after: string;
  /** How the file was changed — 'added' (Write/touch/cp/`>` to a new/empty file),
   *  'deleted' (rm/`git rm`, or current content empty), 'renamed' (mv/`git mv`),
   *  or 'modified'. */
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** For a rename (mv/git mv), the repo-relative ORIGINAL path. Absent otherwise.
   *  `filePath`/`relPath` hold the destination; this is the source. */
  oldRelPath?: string;
  /** Number of distinct Edit/Write/MultiEdit + Bash file ops the session applied. */
  ops: number;
  /** True when before/after could not be fully reconstructed (e.g. an Edit's
   *  old_string no longer matches the current file because another process
   *  changed it). The diff still renders; this flags reduced fidelity. */
  partial: boolean;
}

/** A group of changed files sharing a repo root. */
export interface SessionRepoGroup {
  /** Absolute repo root (or best-effort common dir when no .git found). */
  repoRoot: string;
  /** Short label for the group header, e.g. "walnut", "vendor/lib (submodule)". */
  label: string;
  /** 'cwd' (the session's working dir repo), 'other' (a different repo), or
   *  'submodule' (a .git nested inside another repo). */
  kind: 'cwd' | 'other' | 'submodule';
  files: SessionFileChange[];
}

export interface SessionChangesResult {
  sessionId: string;
  groups: SessionRepoGroup[];
  /** Total changed files across all groups (after .claude filtering). */
  fileCount: number;
  /** True if any file was reconstructed only partially. */
  anyPartial: boolean;
}

// ── Internal: per-file accumulated ops ──

type FileOp =
  | { kind: 'edit'; oldString: string; newString: string; replaceAll: boolean }
  | { kind: 'write'; content: string }
  // Bash-derived path ops (no content payload — reconstructed from disk + git):
  | { kind: 'create' }
  | { kind: 'delete' }
  | { kind: 'rename'; from: string };

interface FileAccum {
  filePath: string;
  cwd?: string;
  /** Ops in chronological order (oldest first). */
  ops: FileOp[];
}

// ── JSONL line shape (only the fields we read) ──

interface RawLine {
  type?: string;
  cwd?: string;
  message?: {
    content?: string | Array<{
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Extract file ops from one JSONL content string, appending to `fileMap`. */
function collectOpsFromJsonl(content: string, fileMap: Map<string, FileAccum>): void {
  for (const line of content.split('\n')) {
    if (!line) continue;
    let raw: RawLine;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (raw.type !== 'assistant') continue;
    const blocks = raw.message?.content;
    if (!Array.isArray(blocks)) continue;
    const lineCwd = typeof raw.cwd === 'string' ? raw.cwd : undefined;

    for (const block of blocks) {
      if (block.type !== 'tool_use' || !block.name) continue;
      const input = block.input;
      if (!input) continue;

      // Bash file ops (mv/git mv/rm/git rm/cp/touch/`>` redirection) — moves,
      // renames, deletes and shell-created files leave NO Edit/Write op, so parse
      // the recorded command string into structured create/delete/rename ops.
      if (block.name === 'Bash') {
        const command = typeof input.command === 'string' ? input.command : undefined;
        if (!command) continue;
        for (const op of parseBashFileOps(command, lineCwd)) {
          if (op.kind === 'rename' && op.from) {
            // A rename RETIRES the source path and carries its history to the dest:
            // migrate any prior ops (edits/create on the old path) onto the
            // destination accum, then drop the source so we don't show a phantom
            // "modified" for a file that no longer exists.
            const srcAccum = fileMap.get(op.from);
            const destAccum = fileMap.get(op.path) ?? { filePath: op.path, cwd: lineCwd, ops: [] };
            if (!destAccum.cwd && lineCwd) destAccum.cwd = lineCwd;
            if (srcAccum) {
              destAccum.ops.push(...srcAccum.ops);
              fileMap.delete(op.from);
            }
            destAccum.ops.push({ kind: 'rename', from: op.from });
            fileMap.set(op.path, destAccum);
            continue;
          }
          const accum = fileMap.get(op.path) ?? { filePath: op.path, cwd: lineCwd, ops: [] };
          if (!accum.cwd && lineCwd) accum.cwd = lineCwd;
          accum.ops.push(op.kind === 'delete' ? { kind: 'delete' } : { kind: 'create' });
          fileMap.set(op.path, accum);
        }
        continue;
      }

      if (!EDIT_TOOLS.has(block.name)) continue;
      const filePath = typeof input.file_path === 'string' ? input.file_path
        : typeof input.notebook_path === 'string' ? input.notebook_path
          : undefined;
      if (!filePath) continue;

      const accum = fileMap.get(filePath) ?? { filePath, cwd: lineCwd, ops: [] };
      if (!accum.cwd && lineCwd) accum.cwd = lineCwd;

      if (block.name === 'Write') {
        if (typeof input.content === 'string') {
          accum.ops.push({ kind: 'write', content: input.content });
        }
      } else if (block.name === 'Edit') {
        if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
          accum.ops.push({
            kind: 'edit',
            oldString: input.old_string,
            newString: input.new_string,
            replaceAll: input.replace_all === true,
          });
        }
      } else if (block.name === 'MultiEdit') {
        // MultiEdit applies edits[] in order.
        const edits = Array.isArray(input.edits) ? input.edits : [];
        for (const e of edits as Array<Record<string, unknown>>) {
          if (typeof e.old_string === 'string' && typeof e.new_string === 'string') {
            accum.ops.push({
              kind: 'edit',
              oldString: e.old_string,
              newString: e.new_string,
              replaceAll: e.replace_all === true,
            });
          }
        }
      } else if (block.name === 'NotebookEdit') {
        // Notebook cells: best-effort treat new_source as an edit onto old (often
        // only new_source is present → treated as additive content).
        const newSrc = typeof input.new_source === 'string' ? input.new_source : undefined;
        if (newSrc !== undefined) {
          accum.ops.push({ kind: 'edit', oldString: '', newString: newSrc, replaceAll: false });
        }
      }

      fileMap.set(filePath, accum);
    }
  }
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

// ── before reconstruction (reverse-apply ops onto current content) ──

/** Reverse one edit: turn newString back into oldString in `text`. */
function reverseEdit(text: string, op: { oldString: string; newString: string; replaceAll: boolean }): { text: string; ok: boolean } {
  if (op.newString === op.oldString) return { text, ok: true };
  // Empty newString (pure deletion-of-nothing / insertion): re-insert is ambiguous; skip.
  if (op.newString === '') return { text, ok: false };
  const idx = text.indexOf(op.newString);
  if (idx === -1) return { text, ok: false }; // current file no longer contains it
  if (op.replaceAll) {
    return { text: text.split(op.newString).join(op.oldString), ok: true };
  }
  // Replace the FIRST occurrence only (mirrors Edit semantics).
  return {
    text: text.slice(0, idx) + op.oldString + text.slice(idx + op.newString.length),
    ok: true,
  };
}

/**
 * Reconstruct {before, after, status, partial} for a file from its current
 * on-disk content + the chronological ops the session applied.
 *
 * @param current       Disk content of the file (the destination path for a
 *                       rename); null when the file no longer exists.
 * @param accum          The file's accumulated ops (oldest first).
 * @param deletedBefore  For a deleted file, its content at the git base (from
 *                       `git show HEAD:path`), so the diff can show what was
 *                       removed. null when unavailable (remote / no git / untracked).
 */
function reconstructFile(
  current: string | null,
  accum: FileAccum,
  deletedBefore?: string | null,
): Omit<SessionFileChange, 'filePath' | 'relPath' | 'oldRelPath'> & { renamedFrom?: string } {
  const ops = accum.ops;
  const lastOp = ops[ops.length - 1];
  let partial = false;

  // Find the last rename (its `from` is the display source). A later delete of a
  // renamed dest is handled by the delete branch below.
  let renamedFrom: string | undefined;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.kind === 'rename') { renamedFrom = op.from; break; }
  }

  // ── Deleted: the file's last op was a `rm`, or it's gone from disk. `after` is
  //    empty; `before` is the pre-delete content (git-show injected, else best-
  //    effort). Edits/renames before the delete are moot — the file is gone. ──
  if (lastOp?.kind === 'delete') {
    const before = deletedBefore ?? '';
    if (deletedBefore == null) partial = true; // couldn't recover the removed content
    return { before, after: '', status: 'deleted', ops: ops.length, partial };
  }

  // `after`: the current content. If the file was deleted on disk (read=null) but
  // the session's last op was a Write, fall back to that Write's content as the
  // best available "after". If null and last op was an edit, we can't show after.
  let after: string;
  if (current != null) {
    after = current;
  } else if (lastOp?.kind === 'write') {
    after = lastOp.content;
    partial = true;
  } else {
    after = '';
    partial = true;
  }

  // `before`: reverse-apply ops newest→oldest onto `after`. rename/create are
  // content-boundary markers, not text edits:
  //   - create: the file did not exist before this op → reset `before` to ''.
  //   - rename: content-preserving (bytes unchanged) → skip in text terms.
  let before = after;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.kind === 'write' || op.kind === 'create') {
      // A Write/create established the whole file. Everything before it is unknown
      // from `after` alone; reset `before` to '' and keep walking earlier ops
      // (edits to a pre-existing file, if any, reconstruct the original).
      before = '';
    } else if (op.kind === 'rename' || op.kind === 'delete') {
      // rename: bytes unchanged. delete here is not the last op (handled above) —
      // an intermediate delete+recreate; treat as a content boundary too.
      if (op.kind === 'delete') before = '';
    } else {
      const r = reverseEdit(before, op);
      before = r.text;
      if (!r.ok) partial = true;
    }
  }

  // Status. A rename is a rename even when the content is byte-identical (a pure
  // move) — it takes precedence over modified/added so the move is visible.
  let status: SessionFileChange['status'];
  if (renamedFrom !== undefined) status = 'renamed';
  else if (before === '' && after !== '') status = 'added';
  else if (after === '' && before !== '') status = 'deleted';
  else status = 'modified';

  return { before, after, status, ops: ops.length, partial, renamedFrom };
}

// ── repo grouping ──

/** Find the nearest ancestor dir containing a `.git` entry (file or dir). Async,
 *  bounded walk. Returns null if none found before the filesystem root. */
async function findGitRoot(startDir: string, reader: { readFile: (p: string) => Promise<string | null>; listDir: (p: string) => Promise<string[]> }, isRemote: boolean): Promise<string | null> {
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

/** Decide the group label + kind for a repo root relative to the session cwd. */
function groupMeta(repoRoot: string, sessionCwd: string | undefined, cwdRepoRoot: string | null): { label: string; kind: SessionRepoGroup['kind'] } {
  const name = path.basename(repoRoot) || repoRoot;
  if (cwdRepoRoot && repoRoot === cwdRepoRoot) {
    return { label: name, kind: 'cwd' };
  }
  // A repo nested INSIDE the cwd repo root is a submodule.
  if (cwdRepoRoot && repoRoot.startsWith(cwdRepoRoot + path.sep)) {
    const rel = path.relative(cwdRepoRoot, repoRoot);
    return { label: `${rel} (submodule)`, kind: 'submodule' };
  }
  return { label: name, kind: 'other' };
}

// ── bookkeeping / agent-memory filtering ──

/** True if a path is Claude/Walnut bookkeeping (plans + Claude Code's per-project
 *  memory dir) — agent scratch, not project code under review. */
function isBookkeepingPath(filePath: string): boolean {
  return /(^|\/)\.claude\/(plans|projects)\//.test(filePath);
}

/**
 * True if a path is an AGENT MEMORY STORE entry — the butler's (or a subagent's)
 * persistent memory, not project code. The Changed view is for reviewing code a
 * session wrote; an agent distilling notes into its own MEMORY.md is noise.
 *
 * Walnut's memory store lives at `<WALNUT_HOME>/memory/` with a fixed layout
 * (projects/ agents/ repos/ daily/ topics/ compaction/ sessions/ vault/
 * knowledge/ + index.md / working-memory.md), plus the global `<WALNUT_HOME>/
 * MEMORY.md`. WALNUT_HOME differs per environment (`~/.open-walnut` locally,
 * `/tmp/walnut-test-*` in tests, the REMOTE host's home for cloud sessions), so
 * we match the STRUCTURE — a `memory/` segment followed by a store subdir or a
 * canonical memory file — never a fixed prefix. This deliberately does NOT match
 * source files that merely contain "memory" in their name (e.g.
 * `src/core/memory-search.ts`, `web/src/components/memory/Panel.tsx`,
 * `src/core/working-memory.ts`): those live under `src/`/`web/`, not under a
 * `memory/` store dir, and aren't `.md`. Claude Code's per-project memory
 * (`.claude/projects/<enc>/memory/MEMORY.md`) is already handled by
 * isBookkeepingPath; the bare-`MEMORY.md` rule here additionally catches the
 * all-caps agent-memory convention wherever it sits. */
function isAgentMemoryPath(filePath: string): boolean {
  return (
    /(^|\/)memory\/(projects|agents|repos|daily|topics|compaction|sessions|vault|knowledge)\//.test(filePath)
    || /(^|\/)memory\/(index|working-memory)\.md$/.test(filePath)
    || /(^|\/)MEMORY\.md$/.test(filePath)
  );
}

/** Paths excluded from the Changed view entirely (agent scratch / memory, not
 *  reviewable code). A group made only of these is dropped. Exported so the git
 *  comparison path (session-git-diff.ts, scope=all) applies the IDENTICAL filter
 *  — otherwise switching to "All in repo" would re-surface the memory files this
 *  hides in the default session scope. */
export function isExcludedPath(filePath: string): boolean {
  return isBookkeepingPath(filePath) || isAgentMemoryPath(filePath);
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
  /** Git-root lookups persist across recomputes — repo roots don't move, and
   *  re-walking them is listDir-per-level over the tunnel for remote sessions. */
  gitRootByDir: Map<string, string | null>;
  /** Absolute JSONL path resolved via fs.find, for sessions whose cwd is
   *  unknown or too long for our path encoding (Claude Code hashes >200-char
   *  encodings). Without this, such sessions could never stat → never cache →
   *  full re-read on EVERY request (the 46s Changed-tab pain). */
  resolvedPath?: string;
}
const changesCache = new Map<string, CacheEntry>();
const MAX_CACHE = 30;

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
  return changesCache.get(key);
}

function cacheSet(key: string, entry: CacheEntry): void {
  changesCache.delete(key);
  changesCache.set(key, entry);
  if (changesCache.size > MAX_CACHE) {
    const oldest = changesCache.keys().next().value;
    if (oldest) changesCache.delete(oldest);
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

async function computeSessionChangesInner(
  key: string,
  sessionId: string,
  cwd?: string,
  host?: string,
  outputFile?: string,
  opts?: { noCache?: boolean },
): Promise<SessionChangesResult> {
  const t0 = Date.now();

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
        // before trusting the append-only assumption.
        const range = await withTimeout(reader.readFileRange(jsonlPath, prior.lastLineStart));
        if (range !== null) {
          const nl = range.content.indexOf('\n');
          const firstLine = nl === -1 ? range.content : range.content.slice(0, nl);
          if (nl !== -1 && lineMatches(firstLine, prior.lastLineCheck)) {
            const appended = range.content.slice(nl + 1);
            const { complete, tail } = splitCompleteLines(appended);
            if (complete) {
              collectOpsFromJsonl(complete, prior.mainFileMap);
              const lastLine = lastLineOf(complete);
              prior.lastLineStart = prior.parsedBytes + Buffer.byteLength(complete, 'utf-8')
                - Buffer.byteLength(lastLine, 'utf-8') - 1;
              prior.lastLineCheck = lineCheckOf(lastLine);
              prior.parsedBytes += Buffer.byteLength(complete, 'utf-8');
            }
            inc = prior;
            fileMap = cloneFileMap(prior.mainFileMap);
            if (tail) collectOpsFromJsonl(tail, fileMap);
            effectiveCwd = prior.effectiveCwd ?? cwd;
            parseMode = 'incremental';
          }
          // Verification failed (rewrite, e.g. /compact) → fall through to full.
        }
      }
      if (fileMap === null) {
        // Full parse that ESTABLISHES incremental state. Read the raw file via
        // readFileRange(0) — byte-exact chunked transfer — so parsedBytes is a
        // true file byte offset (readSessionJsonlContent may append synthetic
        // stream events, which would corrupt byte accounting).
        const range = await withTimeout(reader.readFileRange(jsonlPath, 0));
        if (range !== null) {
          const { complete, tail } = splitCompleteLines(range.content);
          const mainFileMap = new Map<string, FileAccum>();
          collectOpsFromJsonl(complete, mainFileMap);
          effectiveCwd = extractCwdFromJsonlContent(range.content) ?? cwd;
          const lastLine = complete ? lastLineOf(complete) : '';
          const parsedBytes = Buffer.byteLength(complete, 'utf-8');
          inc = {
            parsedBytes,
            lastLineStart: complete ? parsedBytes - Buffer.byteLength(lastLine, 'utf-8') - 1 : 0,
            lastLineCheck: complete ? lineCheckOf(lastLine) : null,
            mainFileMap,
            effectiveCwd,
          };
          fileMap = cloneFileMap(mainFileMap);
          if (tail) collectOpsFromJsonl(tail, fileMap);
          parseMode = 'full';
        }
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
  try {
    const subContents = await readSubagentContents(sessionId, effectiveCwd, host);
    for (const [, content] of subContents) {
      collectOpsFromJsonl(content, fileMap);
    }
  } catch (err) {
    log.session.debug('session-changes: subagent read failed', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    });
  }

  // Git-root walk cache persists across recomputes (roots don't move; remote
  // walks are listDir-per-level RPCs). Kept even when fileMap is empty.
  const gitRootByDir = cached?.gitRootByDir ?? new Map<string, string | null>();

  if (fileMap.size === 0) {
    const empty: SessionChangesResult = { sessionId, groups: [], fileCount: 0, anyPartial: false };
    if (mtimeMs !== undefined) cacheSet(key, { mtimeMs, result: empty, inc, gitRootByDir, resolvedPath });
    return empty;
  }

  // 3. Read current content for each file (after) + reconstruct before.
  //    (createFileReader returns a DaemonFileReader for the same host — reuse ours.)
  const isRemote = !!host;

  // Resolve a per-file change record. For a DELETED file (last op = rm/git rm),
  // recover the removed content from git so the diff shows what was lost: local
  // sessions run `git show HEAD:<relpath>` in-process; remote sessions can't
  // (no per-file SSH), so the delete still shows with an empty before + partial.
  const changesByPath = new Map<string, SessionFileChange>();
  await Promise.all(
    [...fileMap.values()].map(async (accum) => {
      let current: string | null = null;
      try {
        current = await reader.readFile(accum.filePath);
      } catch {
        current = null;
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
    }),
  );

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
  for (const accum of fileMap.values()) {
    const change = changesByPath.get(accum.filePath);
    if (!change) continue;
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
    if (change.before === change.after && !change.partial && !structural) continue;
    const { root, orphan } = await resolveRepoRoot(accum.filePath, accum.cwd);
    // Skip stray out-of-repo scratch files (see resolveRepoRoot) so the set
    // matches the git modes, which can never show a non-repo file.
    if (orphan) continue;
    change.relPath = path.relative(root, accum.filePath) || path.basename(accum.filePath);
    // Convert an absolute rename source to a repo-relative display path (fall back
    // to a basename if it lived outside this root).
    if (change.oldRelPath) {
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
    group.files = group.files.filter((f) => !isExcludedPath(f.filePath));
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

  if (mtimeMs !== undefined) cacheSet(key, { mtimeMs, result, inc, gitRootByDir, resolvedPath });
  log.session.info('session-changes computed', {
    sessionId, host: host ?? '__local__', parseMode, fileCount, durationMs: Date.now() - t0,
  });
  return result;
}
