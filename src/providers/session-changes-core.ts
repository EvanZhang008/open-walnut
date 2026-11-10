/**
 * Session Changes CORE — the pure compute for "which files did this session
 * change, with reconstructed before/after", shared by BOTH sides:
 *
 *   - the walnut SERVER (src/core/session-changes.ts) imports the leaf
 *     functions for its reader-based pipeline (the fallback path for hosts
 *     whose daemon predates `changes-v1`), and
 *   - the DAEMON binary (daemon-standalone.ts) imports the whole host-local
 *     pipeline (`computeHostLocalChanges`) so each host parses ITS OWN session
 *     JSONLs and reads ITS OWN files — only the light result crosses the
 *     tunnel. See AGENTS.md "Design Principle: host-local work belongs to the
 *     DAEMON".
 *
 * Like git-diff-core.ts, this module must stay dependency-lean (node builtins
 * + bash-file-ops only) so bun can bundle it into the daemon binary. No
 * logging imports — callers log around it. daemon-source.ts (the embedded-
 * string twin) does not copy this pipeline: it require()s the bundled sidecar
 * `changes-core.cjs` (scripts/build-daemon.sh) and advertises 'changes-v1' only
 * when that loads, so both twins run this exact code.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseBashFileOps } from '../core/bash-file-ops.js';
import { restoreArchivedAt } from './transcript-archive.js';

// ── Public result types (the wire + frontend shape) ──

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
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** For a rename (mv/git mv), the repo-relative ORIGINAL path. */
  oldRelPath?: string;
  /** Number of distinct ops the session applied to this file. */
  ops: number;
  /** True when before/after could not be fully reconstructed. */
  partial: boolean;
  /** Lines added and removed between before and after (a light list keeps
   *  them, so a phone's list can show "+12 -3" without the content). Absent
   *  when the record carried no content to count. */
  additions?: number;
  deletions?: number;
}

/** A group of changed files sharing a repo root. */
export interface SessionRepoGroup {
  repoRoot: string;
  label: string;
  kind: 'cwd' | 'other' | 'submodule';
  files: SessionFileChange[];
}

export interface SessionChangesResult {
  sessionId: string;
  groups: SessionRepoGroup[];
  fileCount: number;
  anyPartial: boolean;
  /** SWR markers (server-side wrapper): served from cache, recompute running. */
  stale?: boolean;
  refreshing?: boolean;
  /** True when before/after content is absent (light list — diffs load per file). */
  light?: boolean;
}

// ── Per-file accumulated ops ──

// `failed`: the CLI answered this tool call with an error (`is_error: true`), so
// the edit never reached the file. The Changed view's reconstruction ignores the
// flag; per-hunk attribution (git-commit-core.ts) skips such ops, because a
// failed edit whose new text happens to exist in the file would otherwise claim
// someone else's lines.
export type FileOp =
  | { kind: 'edit'; oldString: string; newString: string; replaceAll: boolean; toolUseId?: string; failed?: boolean }
  // `original`: the file as it was before this Write, when the CLI recorded one
  // (its tool result is `type: 'update'` with `originalFile`). Absent = a create.
  | { kind: 'write'; content: string; toolUseId?: string; original?: string; failed?: boolean }
  | { kind: 'create' }
  // A shell command rewrote the file in place (`sed -i`, `>>`, a formatter): what it wrote is unknown.
  | { kind: 'modify' }
  | { kind: 'delete' }
  | { kind: 'rename'; from: string };

export interface FileAccum {
  filePath: string;
  cwd?: string;
  /** Ops in chronological order (oldest first). */
  ops: FileOp[];
}

interface RawLine {
  type?: string;
  cwd?: string;
  message?: {
    content?: string | Array<{
      type?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      is_error?: boolean;
    }>;
  };
  toolUseResult?: unknown;
}

/**
 * Mark the edit/write ops whose tool call the CLI answered with an error. The
 * error arrives on a later user line (possibly a later parse chunk), so the op
 * is found by its tool_use id across the map. Ops are replaced, not mutated (a
 * cloned map shares op objects with the cached one it came from).
 */
function markFailedOps(raw: RawLine, fileMap: Map<string, FileAccum>): void {
  const blocks = raw.message?.content;
  if (!Array.isArray(blocks)) return;
  let failed: Set<string> | null = null;
  for (const b of blocks) {
    if (b.type === 'tool_result' && b.is_error === true && b.tool_use_id) (failed ??= new Set()).add(b.tool_use_id);
  }
  if (!failed) return;
  for (const accum of fileMap.values()) {
    for (let i = accum.ops.length - 1; i >= 0; i--) {
      const op = accum.ops[i]!;
      if ((op.kind === 'edit' || op.kind === 'write') && op.toolUseId && failed.has(op.toolUseId) && !op.failed) {
        accum.ops[i] = { ...op, failed: true };
      }
    }
  }
}

/**
 * A Write over an existing file: the CLI answers it with `toolUseResult`
 * `{ type: 'update', filePath, originalFile }` on the user line that carries the
 * tool_result. Attach that original to the matching write op so `before` is the
 * real old file, not an empty one. A create (`type: 'create'`) or an older
 * transcript without the field leaves the op as a create. Returns the path it
 * changed, if any. The op is replaced, not mutated: a cloned map shares op
 * objects with the cached one it came from.
 */
function attachWriteOriginal(raw: RawLine, fileMap: Map<string, FileAccum>): string | null {
  const r = raw.toolUseResult as { type?: unknown; filePath?: unknown; originalFile?: unknown } | null;
  if (!r || typeof r !== 'object' || r.type !== 'update') return null;
  if (typeof r.filePath !== 'string' || typeof r.originalFile !== 'string') return null;
  const blocks = raw.message?.content;
  if (!Array.isArray(blocks)) return null;
  const ids = new Set(blocks.filter((b) => b.type === 'tool_result' && b.tool_use_id).map((b) => b.tool_use_id!));
  const ops = fileMap.get(r.filePath)?.ops;
  if (!ops || ids.size === 0) return null;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    if (op.kind === 'write' && op.toolUseId && ids.has(op.toolUseId)) {
      ops[i] = { ...op, original: r.originalFile };
      return r.filePath;
    }
  }
  return null;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Extract file ops from one JSONL content string, appending to `fileMap`.
 * Returns the paths whose EARLIER Write op learned its original file here (its
 * tool result can land in a later chunk than the tool_use).
 */
export function collectOpsFromJsonl(content: string, fileMap: Map<string, FileAccum>): Set<string> {
  const originalsAttached = new Set<string>();
  for (const line of content.split('\n')) {
    if (!line) continue;
    let raw: RawLine;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (raw.type === 'user') {
      const attached = attachWriteOriginal(raw, fileMap);
      if (attached) originalsAttached.add(attached);
      markFailedOps(raw, fileMap);
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
          accum.ops.push(op.kind === 'delete' ? { kind: 'delete' } : op.kind === 'modify' ? { kind: 'modify' } : { kind: 'create' });
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
          accum.ops.push({ kind: 'write', content: input.content, toolUseId: block.id });
        }
      } else if (block.name === 'Edit') {
        if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
          accum.ops.push({
            kind: 'edit',
            oldString: input.old_string,
            newString: input.new_string,
            replaceAll: input.replace_all === true,
            ...(block.id ? { toolUseId: block.id } : {}),
          });
        }
      } else if (block.name === 'MultiEdit') {
        // MultiEdit applies edits[] in order (and fails as one call).
        const edits = Array.isArray(input.edits) ? input.edits : [];
        for (const e of edits as Array<Record<string, unknown>>) {
          if (typeof e.old_string === 'string' && typeof e.new_string === 'string') {
            accum.ops.push({
              kind: 'edit',
              oldString: e.old_string,
              newString: e.new_string,
              replaceAll: e.replace_all === true,
              ...(block.id ? { toolUseId: block.id } : {}),
            });
          }
        }
      } else if (block.name === 'NotebookEdit') {
        // Notebook cells: best-effort treat new_source as an edit onto old.
        const newSrc = typeof input.new_source === 'string' ? input.new_source : undefined;
        if (newSrc !== undefined) {
          accum.ops.push({ kind: 'edit', oldString: '', newString: newSrc, replaceAll: false, ...(block.id ? { toolUseId: block.id } : {}) });
        }
      }

      fileMap.set(filePath, accum);
    }
  }
  return originalsAttached;
}

/**
 * Merge one parsed fileMap into another, replaying ops in order. Rename ops
 * re-run their migration against the DESTINATION map (mirrors the sequential
 * semantics of parsing all content into one shared map): a rename in subagent B
 * still migrates ops subagent A accumulated on the old path.
 */
export function mergeFileMapInto(src: Map<string, FileAccum>, dest: Map<string, FileAccum>): void {
  for (const [filePath, accum] of src) {
    for (const op of accum.ops) {
      if (op.kind === 'rename') {
        const srcAccum = dest.get(op.from);
        const destAccum = dest.get(filePath) ?? { filePath, cwd: accum.cwd, ops: [] };
        if (!destAccum.cwd && accum.cwd) destAccum.cwd = accum.cwd;
        if (srcAccum && srcAccum !== destAccum) {
          destAccum.ops.push(...srcAccum.ops);
          dest.delete(op.from);
        }
        destAccum.ops.push(op);
        dest.set(filePath, destAccum);
      } else {
        const destAccum = dest.get(filePath) ?? { filePath, cwd: accum.cwd, ops: [] };
        if (!destAccum.cwd && accum.cwd) destAccum.cwd = accum.cwd;
        destAccum.ops.push(op);
        dest.set(filePath, destAccum);
      }
    }
  }
}

// ── before reconstruction (reverse-apply ops onto current content) ──

/** Reverse one edit: turn newString back into oldString in `text`. */
export function reverseEdit(
  text: string,
  op: { oldString: string; newString: string; replaceAll: boolean },
): { text: string; ok: boolean } {
  if (op.newString === op.oldString) return { text, ok: true };
  if (op.newString === '') return { text, ok: false };
  const idx = text.indexOf(op.newString);
  if (idx === -1) return { text, ok: false }; // current file no longer contains it
  if (op.replaceAll) {
    return { text: text.split(op.newString).join(op.oldString), ok: true };
  }
  return {
    text: text.slice(0, idx) + op.oldString + text.slice(idx + op.newString.length),
    ok: true,
  };
}

/**
 * Reconstruct {before, after, status, partial} for a file from its current
 * on-disk content + the chronological ops the session applied.
 */
export function reconstructFile(
  current: string | null,
  accum: FileAccum,
  deletedBefore?: string | null,
): Omit<SessionFileChange, 'filePath' | 'relPath' | 'oldRelPath'> & { renamedFrom?: string } {
  const ops = accum.ops;
  // Only in-place shell writes: the file at HEAD (`deletedBefore`, read the same way;
  // for a renamed file, at its first name) is the best start there is.
  if (ops.length > 0 && ops.every((op) => op.kind === 'modify')) {
    const head = deletedBefore ?? null;
    // Nothing on disk and nothing at HEAD (a phantom), or a file that still equals HEAD: no change.
    if (current === head || (current === null && head === null)) return { before: current ?? '', after: current ?? '', status: 'modified', ops: ops.length, partial: false };
    // Gone, or unreadable: listed, never a clean no-op (the next read decides).
    if (current === null) return { before: head ?? '', after: '', status: 'deleted', ops: ops.length, partial: true };
    return { before: head ?? '', after: current, status: head === null ? 'added' : 'modified', ops: ops.length, partial: true };
  }
  const lastOp = ops[ops.length - 1];
  let partial = false;

  let renamedFrom: string | undefined;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    if (op.kind === 'rename') { renamedFrom = op.from; break; }
  }

  // Deleted: `after` is empty; `before` is the pre-delete content (git-show
  // injected when available). Edits/renames before the delete are moot.
  if (lastOp?.kind === 'delete') {
    const before = deletedBefore ?? '';
    if (deletedBefore == null) partial = true;
    return { before, after: '', status: 'deleted', ops: ops.length, partial };
  }

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
  // content-boundary markers, not text edits. A Write over an existing file
  // restores the file it replaced; older ops then reverse onto that.
  let before = after;
  // Past an in-place shell rewrite the text is unknown: edits older than it cannot be
  // reversed, until an older Write or create pins the content again.
  let opaque = false;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    if (op.kind === 'write') {
      before = op.original ?? '';
      opaque = false;
    } else if (op.kind === 'create') {
      before = '';
      opaque = false;
    } else if (op.kind === 'modify') {
      opaque = true;
    } else if (op.kind === 'rename' || op.kind === 'delete') {
      if (op.kind === 'delete') { before = ''; opaque = false; }
    } else if (!opaque) {
      const r = reverseEdit(before, op);
      before = r.text;
      if (!r.ok) partial = true;
    }
  }
  // Nothing older pinned it: start from HEAD.
  if (opaque) { before = deletedBefore ?? ''; partial = true; }

  let status: SessionFileChange['status'];
  if (renamedFrom !== undefined) status = 'renamed';
  else if (before === '' && after !== '') status = 'added';
  else if (after === '' && before !== '') status = 'deleted';
  else status = 'modified';

  return { before, after, status, ops: ops.length, partial, renamedFrom };
}

/**
 * Where to read HEAD for a file a shell command rewrote in place: its first name (the
 * oldest rename's source), else its own path. null when no op rewrote it in place.
 */
export function headPathForModify(accum: FileAccum): string | null {
  if (!accum.ops.some((op) => op.kind === 'modify')) return null;
  const first = accum.ops.find((op): op is Extract<FileOp, { kind: 'rename' }> => op.kind === 'rename');
  return first ? first.from : accum.filePath;
}

// ── path filtering + repo grouping ──

/** Claude/Walnut bookkeeping (plans + Claude Code's per-project memory dir). */
function isBookkeepingPath(filePath: string): boolean {
  return /(^|\/)\.claude\/(plans|projects)\//.test(filePath);
}

/** Agent MEMORY STORE entries (Personal AI/subagent persistent memory, not code). */
function isAgentMemoryPath(filePath: string): boolean {
  return (
    /(^|\/)memory\/(projects|agents|repos|daily|topics|compaction|sessions|vault|knowledge)\//.test(filePath)
    || /(^|\/)memory\/(index|working-memory)\.md$/.test(filePath)
    || /(^|\/)MEMORY\.md$/.test(filePath)
  );
}

/** Paths excluded from the Changed view entirely (agent scratch, not code). */
export function isExcludedPath(filePath: string): boolean {
  return isBookkeepingPath(filePath) || isAgentMemoryPath(filePath);
}

/** Decide the group label + kind for a repo root relative to the session cwd. */
export function groupMeta(
  repoRoot: string,
  sessionCwd: string | undefined,
  cwdRepoRoot: string | null,
): { label: string; kind: SessionRepoGroup['kind'] } {
  const name = path.basename(repoRoot) || repoRoot;
  if (cwdRepoRoot && repoRoot === cwdRepoRoot) {
    return { label: name, kind: 'cwd' };
  }
  if (cwdRepoRoot && repoRoot.startsWith(cwdRepoRoot + path.sep)) {
    const rel = path.relative(cwdRepoRoot, repoRoot);
    return { label: `${rel} (submodule)`, kind: 'submodule' };
  }
  return { label: name, kind: 'other' };
}

// ── canonical JSONL path helpers (host-local) ──

/** Claude Code's project-dir encoding of a cwd. */
export function encodeProjectPathCore(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** True if Claude Code would encode this cwd without the >200-char hash form. */
export function isSafeForProjectEncodingCore(cwd: string): boolean {
  return encodeProjectPathCore(cwd).length <= 200;
}

/** cwd from the first user line of JSONL content (Claude Code writes it there). */
export function extractCwdFromJsonl(content: string): string | undefined {
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; cwd?: string };
      if ((entry.type === 'user' || entry.type === 'human') && entry.cwd) return entry.cwd;
    } catch { /* skip unparsable line */ }
  }
  return undefined;
}

// ── Host-local full pipeline (runs INSIDE the daemon) ──

export interface HostLocalComputeOptions {
  sessionId: string;
  /** Session cwd when known — resolves the canonical JSONL path directly. */
  cwd?: string;
  /** Claude home (default `$HOME/.claude`). Tests point this at a temp dir. */
  claudeHome?: string;
  /** Caller-owned caches, reused across recomputes for the same session. */
  subCache?: Map<string, { size: number; fileMap: Map<string, FileAccum> }>;
  gitRootByDir?: Map<string, string | null>;
  /** Caller-owned holder for where the main transcript parse stopped, so the
   *  next compute reads only what was appended since (see MainParseState). */
  mainParse?: { state?: MainParseState };
  /** Abort if the whole compute exceeds this (default 100s). */
  deadlineMs?: number;
  /** The previous compute's `changesMemo` for this session: files whose ops,
   *  on-disk stat and HEAD content did not change reuse their reconstruction. */
  changesMemo?: HostLocalChangesMemo;
}

export interface HostLocalComputeOutput {
  result: SessionChangesResult;
  /** The merged op map — kept by the daemon to serve per-file requests. */
  fileMap: Map<string, FileAccum>;
  effectiveCwd?: string;
  jsonlPath: string;
  mtimeMs: number;
  size: number;
  /** How the main transcript was read: continued from the caller's
   *  MainParseState, and how many bytes this compute read. */
  parseStats: { resumed: boolean; readBytes: number };
  /** Pass back as `changesMemo` on the next compute of this session. */
  changesMemo: HostLocalChangesMemo;
  computeStats: HostLocalComputeStats;
}

const STREAM_WINDOW = 1024 * 1024;
const CONTENT_READ_PARALLELISM = 8;
/** Transcript text folded between two yields of the parse. */
const PARSE_PIECE_CHARS = 128 * 1024;
const TAIL_HASH_BYTES = 4096;
/** Past this a file is listed without content: no text diff of it is readable. */
export const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
/** git's heuristic: a NUL byte in the first 8000 bytes means binary. */
const BINARY_PROBE_BYTES = 8000;

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

/**
 * A file too large or binary to diff as text: listed without content, marked
 * partial so the empty pair is not dropped as a no-op (the diff pane shows "No
 * textual diff"). Status follows the ops, as reconstructFile would.
 */
function contentlessChange(accum: FileAccum): SessionFileChange {
  let renamedFrom: string | undefined;
  for (let i = accum.ops.length - 1; i >= 0; i--) {
    const op = accum.ops[i]!;
    if (op.kind === 'rename') { renamedFrom = op.from; break; }
  }
  // The OLDEST content boundary decides: a create, or a Write with no recorded original.
  const first = accum.ops.find((op) => op.kind === 'write' || op.kind === 'create');
  const added = !!first && !(first.kind === 'write' && first.original !== undefined);
  const change: SessionFileChange = {
    filePath: accum.filePath,
    relPath: accum.filePath,
    before: '',
    after: '',
    status: renamedFrom !== undefined ? 'renamed' : added ? 'added' : 'modified',
    ops: accum.ops.length,
    partial: true,
  };
  if (renamedFrom !== undefined) change.oldRelPath = renamedFrom;
  return change;
}

/**
 * Where a main-transcript parse stopped, so the next compute continues from
 * there. The transcript is append-only and collectOpsFromJsonl is an in-order
 * fold over lines, so continuing from the end of the last complete line gives
 * exactly the full parse's ops. Why: every append changes the transcript's
 * mtime, so each compute of a live session re-read the whole file; on
 * 2026-09-29 a 907 MB transcript was re-parsed every ~5 minutes, 11-35 s each,
 * with the daemon's heap spiking to 8 GB (13.7 GB peak footprint).
 */
export interface MainParseState {
  /** dev:ino:birthtime of the transcript: the same file, not a recreated one. */
  epoch: string;
  /** Bytes consumed: just past the last complete line. */
  offset: number;
  /** Hash of the bytes just before `offset`; any rewrite there starts over. */
  tail: string;
  headBlock: string;
  /** Ops of the complete lines before `offset`. Never merged into: merges and
   *  the trailing partial line go to a copy (cloneFileMap). */
  fileMap: Map<string, FileAccum>;
}

const epochOf = (st: fs.Stats): string => `${st.dev}:${st.ino}:${Math.floor(st.birthtimeMs)}`;

async function tailHashAt(fh: fsp.FileHandle, offset: number): Promise<string> {
  const len = Math.min(TAIL_HASH_BYTES, offset);
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, offset - len + got);
    if (bytesRead <= 0) break;
    got += bytesRead;
  }
  return createHash('sha1').update(buf.subarray(0, got)).digest('hex') + ':' + got;
}

/** Copy a fileMap so ops pushed into the copy never reach the original. */
export function cloneFileMap(src: Map<string, FileAccum>): Map<string, FileAccum> {
  const out = new Map<string, FileAccum>();
  for (const [key, accum] of src) out.set(key, { filePath: accum.filePath, cwd: accum.cwd, ops: accum.ops.slice() });
  return out;
}

/** Resolve the canonical JSONL path for a session on THIS host. */
export async function resolveJsonlPathHostLocal(
  sessionId: string,
  cwd: string | undefined,
  claudeHome: string,
): Promise<string | null> {
  if (cwd && isSafeForProjectEncodingCore(cwd)) {
    const p = path.join(claudeHome, 'projects', encodeProjectPathCore(cwd), `${sessionId}.jsonl`);
    try { await fsp.access(p); return p; } catch { /* fall through to scan */ }
  }
  // Scan project dirs for <sid>.jsonl (hashed-cwd sessions / unknown cwd).
  const projectsDir = path.join(claudeHome, 'projects');
  let dirs: string[];
  // Sorted: the first dir holding the sid wins, and bun lists in file system order.
  try { dirs = (await fsp.readdir(projectsDir)).sort(); } catch { return null; }
  for (const d of dirs) {
    const candidate = path.join(projectsDir, d, `${sessionId}.jsonl`);
    try { await fsp.access(candidate); return candidate; } catch { /* keep scanning */ }
  }
  // An archived session (transcript-archive.ts) comes back plain.
  for (const d of dirs) {
    if (await restoreArchivedAt(path.join(projectsDir, d), sessionId)) return path.join(projectsDir, d, `${sessionId}.jsonl`);
  }
  return null;
}

/**
 * Parse a transcript's complete lines into a fileMap: from `resume` when it
 * still describes this file, otherwise from byte 0. Reads in 1MB
 * newline-aligned windows (never the whole file as one string) and yields the
 * event loop between windows so the daemon's session I/O never starves. The
 * trailing partial line (a write in progress, or a last line without its
 * newline) is returned, not parsed, so the returned state covers exactly the
 * bytes before `offset`. `headBlock` is the first decoded block (for cwd
 * extraction).
 */
async function streamParseHostLocal(
  jsonlPath: string,
  deadlineMs: number,
  resume?: MainParseState,
): Promise<MainParseState & { trailing: string; resumed: boolean; readFrom: number } | null> {
  let fh: fsp.FileHandle;
  try { fh = await fsp.open(jsonlPath, 'r'); } catch { return null; }
  try {
    const st = await fh.stat();
    const epoch = epochOf(st);
    const resumed = !!resume && resume.epoch === epoch && st.size >= resume.offset
      && await tailHashAt(fh, resume.offset) === resume.tail;
    const fileMap = resumed ? cloneFileMap(resume!.fileMap) : new Map<string, FileAccum>();
    let headBlock = resumed ? resume!.headBlock : '';
    let consumed = resumed ? resume!.offset : 0;
    const readFrom = consumed;
    let carry = Buffer.alloc(0);
    const win = Buffer.alloc(STREAM_WINDOW);
    let offset = consumed;
    for (;;) {
      if (Date.now() > deadlineMs) throw new Error('changes: stream-parse deadline exceeded');
      const { bytesRead } = await fh.read(win, 0, STREAM_WINDOW, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const buf = carry.length ? Buffer.concat([carry, win.subarray(0, bytesRead)]) : Buffer.from(win.subarray(0, bytesRead));
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl !== -1) {
        const text = buf.subarray(0, lastNl + 1).toString('utf-8');
        // Fold in line-aligned pieces with a yield between: one 1 MB window of
        // JSON lines can hold the loop for tens of ms on a loaded host.
        for (let i = 0; i < text.length;) {
          const cut = i + PARSE_PIECE_CHARS >= text.length ? -1 : text.indexOf('\n', i + PARSE_PIECE_CHARS);
          const end = cut === -1 ? text.length : cut + 1;
          collectOpsFromJsonl(i === 0 && end === text.length ? text : text.slice(i, end), fileMap);
          i = end;
          if (i < text.length) await new Promise<void>((r) => setImmediate(r));
        }
        if (!headBlock) headBlock = text;
        carry = Buffer.from(buf.subarray(lastNl + 1));
        consumed = offset - carry.length;
      } else {
        carry = buf;
      }
      // Explicit yield: fh.read can complete synchronously from page cache.
      await new Promise<void>((r) => setImmediate(r));
    }
    const tail = await tailHashAt(fh, consumed);
    return { epoch, offset: consumed, tail, headBlock, fileMap, trailing: carry.toString('utf-8'), resumed, readFrom };
  } finally {
    await fh.close().catch(() => { /* already closed */ });
  }
}

// ── Post-parse phase: event-loop slicing, batched git, per-file memo ──
//
// Why (2026-11-08): one live session with 711 changed files took 18 to 21 s on
// EVERY recompute, even when the parse was resumed and read 200 KB, and the
// daemon's loop starved meanwhile (a session start waited 17 s behind it). Each
// file a shell command rewrote in place reads its HEAD content, which cost two
// git spawns per file (rev-parse + show: 1,400 spawns), and every file was read
// and reconstructed again on every compute. Now: one git toplevel lookup per
// directory (kept across computes), one HEAD lookup per repo, all HEAD contents
// of a repo in one `cat-file --batch`, and a file whose ops, on-disk stat and
// HEAD content are unchanged reuses its last reconstruction.

/** Longest stretch of synchronous work before the post-parse phase yields. */
const SLICE_MS = 20;
const GIT_TIMEOUT_MS = 10_000;
/** `git show` ran with a 64 MB maxBuffer: a larger blob read as "not in HEAD". */
const GIT_SHOW_MAX_BYTES = 64 * 1024 * 1024;
const CAT_FILE_CHUNK = 500;

/** Yields to the event loop once `sliceMs` of work has run since the last yield. */
function createSlicer(sliceMs = SLICE_MS): () => Promise<void> {
  let since = Date.now();
  return async () => {
    if (Date.now() - since < sliceMs) return;
    await new Promise<void>((r) => setImmediate(r));
    since = Date.now();
  };
}

async function eachPooled<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** Per-file reconstruction kept from the last compute (see HostLocalChangesMemo). */
interface FileMemo {
  /** The op objects it was built from: ops are replaced, never mutated, so identity is the key. */
  ops: FileOp[];
  /** Stat signature of the file on disk when it was read. */
  sig: string;
  deletedBefore: string | null;
  /** Listed without content (too large or binary): HEAD content plays no part. */
  contentless: boolean;
  /** Pristine change (relPath = filePath, absolute oldRelPath); null = not listed. */
  change: SessionFileChange | null;
}

/**
 * What lets a recompute redo only the files that changed. Returned by every
 * compute and passed back in by the caller; a compute never mutates the memo it
 * was given (it builds a new one), so a compute that fails part-way leaves the
 * last good memo intact.
 */
export interface HostLocalChangesMemo {
  files: Map<string, FileMemo>;
  /** `git rev-parse --show-toplevel` per directory (successful answers only). */
  topByDir: Map<string, string>;
  /** `${toplevel}\0${HEAD sha}\0${rel}` → that blob's content (null = not in that commit). */
  headBlobs: Map<string, string | null>;
}

export interface HostLocalComputeStats {
  /** Files listed or considered after filtering (not excluded, not orphan). */
  files: number;
  /** Files read from disk and reconstructed by this compute. */
  reconstructed: number;
  /** Files whose last reconstruction was reused. */
  reused: number;
  gitSpawns: number;
}

const statSig = (st: fs.Stats): string =>
  `${st.isFile() ? 'f' : st.isDirectory() ? 'd' : 'o'}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}:${st.dev}`;

function sameOps(a: readonly FileOp[], b: readonly FileOp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

type GitRun = (args: string[], cwd: string, input?: string, maxBuffer?: number) => Promise<{ stdout: Buffer; code: number }>;

function makeGitRun(stats: HostLocalComputeStats): GitRun {
  return (args, cwd, input, maxBuffer = GIT_SHOW_MAX_BYTES) => new Promise((resolve) => {
    stats.gitSpawns++;
    const done = (code: number, stdout?: Buffer | string) =>
      resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''), code });
    try {
      const child = execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: 'buffer' },
        (err, stdout) => done(err ? 1 : 0, stdout));
      if (input !== undefined && child.stdin) {
        child.stdin.on('error', () => { /* git exited early: its exit code says so */ });
        child.stdin.end(input);
      }
    } catch { done(1); }
  });
}

/** The exact old per-file read, for the names a batch cannot carry (a tree, a newline in the name). */
async function gitShowHead(git: GitRun, top: string, rel: string): Promise<string | null> {
  const show = await git(['show', `HEAD:${rel}`], top);
  return show.code === 0 ? show.stdout.toString('utf-8') : null;
}

const OBJECT_INFO = /^[0-9a-f]{40,64} (\S+) (\d+)$/;

/**
 * HEAD content of many files of one repo in two spawns: `cat-file --batch-check`
 * for type and size, then `--batch` for the blobs. Same answers as the old
 * `git show HEAD:<rel>` per file: a missing path is null, a tree or gitlink goes
 * to `git show` itself, a blob over git show's old buffer is null. `transient`
 * marks answers that came from a failed git run, which are not kept.
 */
async function readHeadBlobs(
  git: GitRun,
  top: string,
  sha: string,
  rels: string[],
  slice: () => Promise<void>,
): Promise<Map<string, { value: string | null; transient: boolean }>> {
  const out = new Map<string, { value: string | null; transient: boolean }>();
  // The old read, one file at a time: for what a batch cannot carry, and for a
  // batch that failed (a loaded host can time one out where single reads pass).
  const oneByOne = async (list: string[]): Promise<void> => {
    for (const rel of list) {
      const value = await gitShowHead(git, top, rel);
      out.set(rel, { value, transient: value === null });
    }
  };
  const batchable: string[] = [];
  const odd: string[] = [];
  for (const rel of rels) (rel.includes('\n') || rel.includes('\r') ? odd : batchable).push(rel);
  await oneByOne(odd);
  for (let i = 0; i < batchable.length; i += CAT_FILE_CHUNK) {
    const chunk = batchable.slice(i, i + CAT_FILE_CHUNK);
    const input = chunk.map((rel) => `${sha}:${rel}`).join('\n') + '\n';
    const check = await git(['cat-file', '--batch-check'], top, input, 16 * 1024 * 1024);
    const lines = check.stdout.toString('utf-8').split('\n');
    if (check.code !== 0 || lines.length < chunk.length) { await oneByOne(chunk); continue; }
    const blobs: Array<{ rel: string; size: number }> = [];
    const other: string[] = [];
    for (let k = 0; k < chunk.length; k++) {
      const rel = chunk[k]!;
      const m = OBJECT_INFO.exec(lines[k]!);
      if (!m) out.set(rel, { value: null, transient: false }); // missing / ambiguous
      else if (m[1] !== 'blob') other.push(rel); // a tree or a gitlink: git show answers those itself
      else if (Number(m[2]) > GIT_SHOW_MAX_BYTES) out.set(rel, { value: null, transient: false });
      else blobs.push({ rel, size: Number(m[2]) });
    }
    await oneByOne(other);
    // One `--batch` run per ~64 MB of blobs, so a run never buffers more than
    // about what the old per-file read held at once.
    for (let b = 0; b < blobs.length;) {
      const run: typeof blobs = [];
      let bytes = 0;
      while (b < blobs.length && (run.length === 0 || bytes + blobs[b]!.size <= GIT_SHOW_MAX_BYTES)) {
        bytes += blobs[b]!.size;
        run.push(blobs[b++]!);
      }
      const maxBuffer = bytes + run.length * 200 + 1024 * 1024;
      const batch = await git(['cat-file', '--batch'], top, run.map((x) => `${sha}:${x.rel}`).join('\n') + '\n', maxBuffer);
      if (batch.code !== 0) { await oneByOne(run.map((x) => x.rel)); continue; }
      const buf = batch.stdout;
      let pos = 0;
      const failed: string[] = [];
      for (const x of run) {
        await slice();
        const nl = pos < buf.length ? buf.indexOf(0x0a, pos) : -1;
        const m = nl === -1 ? null : OBJECT_INFO.exec(buf.subarray(pos, nl).toString('utf-8'));
        if (!m || m[1] !== 'blob' || nl + 1 + Number(m[2]) > buf.length) {
          failed.push(x.rel);
          pos = buf.length;
          continue;
        }
        const size = Number(m[2]);
        out.set(x.rel, { value: buf.subarray(nl + 1, nl + 1 + size).toString('utf-8'), transient: false });
        pos = nl + 1 + size + 1;
      }
      await oneByOne(failed);
    }
  }
  return out;
}

/** Nearest ancestor dir containing `.git` — plain-fs walk (host-local). */
async function findGitRootHostLocal(startDir: string): Promise<string | null> {
  let dir = startDir;
  for (let i = 0; i < 40; i++) {
    if (!dir || dir === '/' || dir === '.') break;
    try { await fsp.access(path.join(dir, '.git')); return dir; } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The full host-local compute: parse main + subagent JSONLs, read current
 * contents, reconstruct, group, filter. All I/O is local `fs` — this function
 * MUST only ever run on the host that owns the session files (the daemon).
 *
 * The returned result carries FULL before/after content; the daemon strips it
 * for the wire (`changes.compute` responds light) and keeps `fileMap` to serve
 * `changes.file` per-file requests.
 */
export async function computeHostLocalChanges(opts: HostLocalComputeOptions): Promise<HostLocalComputeOutput | null> {
  const claudeHome = opts.claudeHome ?? path.join(process.env.HOME ?? '', '.claude');
  const deadlineMs = Date.now() + (opts.deadlineMs ?? 100_000);
  const jsonlPath = await resolveJsonlPathHostLocal(opts.sessionId, opts.cwd, claudeHome);
  if (!jsonlPath) return null;

  let st: fs.Stats;
  try { st = await fsp.stat(jsonlPath); } catch { return null; }

  // 1. Main JSONL ops (streamed, continuing from the caller's MainParseState).
  const parsed = await streamParseHostLocal(jsonlPath, deadlineMs, opts.mainParse?.state);
  if (parsed === null) return null;
  const { trailing, resumed, readFrom, ...state } = parsed;
  if (opts.mainParse) opts.mainParse.state = state;
  // This compute's map is a copy when the state is kept: the trailing partial
  // line and the subagent merges below must not reach the next continuation.
  const fileMap = opts.mainParse ? cloneFileMap(state.fileMap) : state.fileMap;
  if (trailing) collectOpsFromJsonl(trailing, fileMap);
  const effectiveCwd = extractCwdFromJsonl(parsed.headBlock) ?? opts.cwd;
  const slice = createSlicer();
  await slice();

  // 2. Subagent JSONLs — size-keyed cache so finished agents are parsed once.
  const subCache = opts.subCache ?? new Map<string, { size: number; fileMap: Map<string, FileAccum> }>();
  const subDir = jsonlPath.replace(/\.jsonl$/, '') + '/subagents';
  let subNames: string[] = [];
  try { subNames = await fsp.readdir(subDir); } catch { /* no subagents dir */ }
  const jsonls = subNames.filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'));
  const present = new Set(jsonls);
  for (const k of [...subCache.keys()]) {
    if (!present.has(k)) subCache.delete(k);
  }
  for (const name of jsonls) {
    if (Date.now() > deadlineMs) throw new Error('changes: subagent-parse deadline exceeded');
    const p = path.join(subDir, name);
    let sst: fs.Stats;
    try { sst = await fsp.stat(p); } catch { subCache.delete(name); continue; }
    const cached = subCache.get(name);
    if (cached && cached.size === sst.size) continue;
    const sub = await streamParseHostLocal(p, deadlineMs);
    if (sub) {
      if (sub.trailing) collectOpsFromJsonl(sub.trailing, sub.fileMap);
      subCache.set(name, { size: sst.size, fileMap: sub.fileMap });
    }
  }
  for (const name of [...present].sort()) {
    const c = subCache.get(name);
    if (c) mergeFileMapInto(c.fileMap, fileMap);
    await slice();
  }

  const gitRootByDir = opts.gitRootByDir ?? new Map<string, string | null>();
  const gitRootOf = async (dir: string): Promise<string | null> => {
    if (gitRootByDir.has(dir)) return gitRootByDir.get(dir)!;
    const root = await findGitRootHostLocal(dir);
    gitRootByDir.set(dir, root);
    return root;
  };

  const cwdRepoRoot = effectiveCwd ? await findGitRootHostLocal(effectiveCwd) : null;
  const isUnder = (child: string, ancestor: string): boolean =>
    child === ancestor || child.startsWith(ancestor + path.sep);
  const resolveRepoRoot = async (filePath: string, fileCwd?: string): Promise<{ root: string; orphan: boolean }> => {
    const dir = path.dirname(filePath);
    const gitRoot = await gitRootOf(dir);
    if (gitRoot) return { root: gitRoot, orphan: false };
    if (cwdRepoRoot && isUnder(filePath, cwdRepoRoot)) return { root: cwdRepoRoot, orphan: false };
    if (effectiveCwd && isUnder(filePath, effectiveCwd)) return { root: effectiveCwd, orphan: false };
    if (fileCwd && isUnder(filePath, fileCwd)) return { root: fileCwd, orphan: false };
    return { root: dir, orphan: true };
  };

  const prevMemo = opts.changesMemo;
  const memo: HostLocalChangesMemo = { files: new Map(), topByDir: new Map(), headBlobs: new Map() };
  const stats: HostLocalComputeStats = { files: 0, reconstructed: 0, reused: 0, gitSpawns: 0 };
  const git = makeGitRun(stats);

  // 3a. Stat every candidate (bounded pool, local fs). An out-of-repo file is
  //     never shown, so it is never read: on 2026-09-30 every compute of one
  //     session read a 676 MB SQLite file it had copied into /tmp, as a string,
  //     only to drop it (1.3 GB of daemon heap, 2-3 s, on every warm).
  interface Candidate {
    accum: FileAccum;
    sig: string;
    isFile: boolean;
    tooBig: boolean;
    headPath: string | null;
    headKey: string | null;
    deletedBefore: string | null;
  }
  const candidates: Candidate[] = [];
  const rootByPath = new Map<string, string>();
  await eachPooled([...fileMap.values()], CONTENT_READ_PARALLELISM, async (accum) => {
    await slice();
    if (isExcludedPath(accum.filePath)) return;
    const { root, orphan } = await resolveRepoRoot(accum.filePath, accum.cwd);
    if (orphan) return;
    rootByPath.set(accum.filePath, root);
    // stat-before-read: transcript ops can name FIFOs/sockets/dirs (a session
    // that ran mkfifo, or wrote a .pipe path). open() on a writer-less FIFO
    // blocks a fs-pool thread FOREVER (2026-08-15: wedged all daemon fs RPCs).
    let cst: fs.Stats | null = null;
    try { cst = await fsp.stat(accum.filePath); } catch { cst = null; }
    // A formatter run on a folder (`prettier --write src`) names no file.
    if (cst?.isDirectory() && accum.ops.every((op) => op.kind === 'modify')) return;
    const isFile = !!cst?.isFile();
    const tooBig = isFile && cst!.size > MAX_CONTENT_BYTES;
    const isDeleted = accum.ops[accum.ops.length - 1]?.kind === 'delete';
    // A rewrite in place starts from the file at HEAD (at its first name), as a delete does.
    let headPath = tooBig ? null : isDeleted ? accum.filePath : headPathForModify(accum);
    // No .git above the file means git can't have it: skip git entirely (a long
    // session deletes hundreds of scratch files in /tmp).
    if (headPath && !(await gitRootOf(path.dirname(headPath)))) headPath = null;
    // The same binary file with the same ops: its listing never reads HEAD.
    const sig = cst ? statSig(cst) : 'missing';
    const prev = prevMemo?.files.get(accum.filePath);
    if (headPath && prev?.contentless && prev.sig === sig && sameOps(prev.ops, accum.ops)) headPath = null;
    candidates.push({ accum, sig, isFile, tooBig, headPath, headKey: null, deletedBefore: null });
  });

  // 3b. HEAD content for deletes and in-place rewrites: what `git show HEAD:<rel>`
  //     run from the file's directory answered, looked up per repo in one batch.
  const dirTop = new Map<string, Promise<string | null>>();
  const topOf = (dir: string): Promise<string | null> => {
    let p = dirTop.get(dir);
    if (!p) {
      p = (async () => {
        // git cannot run in a directory that is gone (the old spawn failed there).
        try { if (!(await fsp.stat(dir)).isDirectory()) return null; } catch { return null; }
        const known = prevMemo?.topByDir.get(dir);
        if (known) { memo.topByDir.set(dir, known); return known; }
        const r = await git(['rev-parse', '--show-toplevel'], dir);
        const top = r.code === 0 ? r.stdout.toString('utf-8').trim() : '';
        if (!top) return null;
        memo.topByDir.set(dir, top);
        return top;
      })();
      dirTop.set(dir, p);
    }
    return p;
  };
  const realDirs = new Map<string, Promise<string>>();
  const realDirOf = (dir: string): Promise<string> => {
    let p = realDirs.get(dir);
    if (!p) { p = fsp.realpath(dir).catch(() => dir); realDirs.set(dir, p); }
    return p;
  };
  const shaByTop = new Map<string, Promise<string | null>>();
  const shaOf = (top: string): Promise<string | null> => {
    let p = shaByTop.get(top);
    if (!p) {
      p = git(['rev-parse', '--verify', '-q', 'HEAD'], top).then((r) => {
        const sha = r.code === 0 ? r.stdout.toString('utf-8').trim() : '';
        return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
      });
      shaByTop.set(top, p);
    }
    return p;
  };
  const wanted = new Map<string, { top: string; sha: string; rels: Map<string, Candidate[]> }>();
  await eachPooled(candidates.filter((c) => c.headPath), CONTENT_READ_PARALLELISM, async (c) => {
    await slice();
    const headPath = c.headPath!;
    const dir = path.dirname(headPath);
    const top = await topOf(dir);
    if (!top) return;
    const rel = path.relative(top, path.join(await realDirOf(dir), path.basename(headPath)));
    if (!rel || rel.startsWith('..')) return;
    const sha = await shaOf(top);
    if (!sha) return; // no commit yet: nothing is at HEAD
    const key = `${top}\0${sha}\0${rel}`;
    c.headKey = key;
    if (prevMemo?.headBlobs.has(key)) {
      const value = prevMemo.headBlobs.get(key)!;
      memo.headBlobs.set(key, value);
      c.deletedBefore = value;
      return;
    }
    const w = wanted.get(`${top}\0${sha}`) ?? { top, sha, rels: new Map<string, Candidate[]>() };
    wanted.set(`${top}\0${sha}`, w);
    const list = w.rels.get(rel) ?? [];
    list.push(c);
    w.rels.set(rel, list);
  });
  for (const w of wanted.values()) {
      const blobs = await readHeadBlobs(git, w.top, w.sha, [...w.rels.keys()], slice);
    for (const [rel, list] of w.rels) {
      const got = blobs.get(rel) ?? { value: null, transient: true };
      if (!got.transient) memo.headBlobs.set(`${w.top}\0${w.sha}\0${rel}`, got.value);
      for (const c of list) c.deletedBefore = got.value;
    }
  }

  // 3c. Read + reconstruct only what changed since the last compute: the same
  //     ops, the same stat and the same HEAD content give the same change.
  const changesByPath = new Map<string, SessionFileChange>();
  stats.files = candidates.length;
  await eachPooled(candidates, CONTENT_READ_PARALLELISM, async (c) => {
    await slice();
    const { accum } = c;
    const prev = prevMemo?.files.get(accum.filePath);
    let change: SessionFileChange | null;
    let contentless = c.tooBig;
    if (prev && prev.sig === c.sig && sameOps(prev.ops, accum.ops)
      && (prev.contentless || prev.deletedBefore === c.deletedBefore)) {
      change = prev.change;
      contentless = prev.contentless;
      stats.reused++;
    } else {
      stats.reconstructed++;
      let current: string | null = null;
      if (c.isFile && !c.tooBig) {
        try {
          const buf = await fsp.readFile(accum.filePath);
          if (looksBinary(buf)) contentless = true;
          else current = buf.toString('utf-8');
        } catch { current = null; }
        await slice();
      }
      if (contentless) {
        change = contentlessChange(accum);
      } else {
        const { renamedFrom, ...recon } = reconstructFile(current, accum, c.deletedBefore);
        change = { filePath: accum.filePath, relPath: accum.filePath, ...recon };
        if (renamedFrom !== undefined) change.oldRelPath = renamedFrom;
      }
    }
    // Nothing kept that the answer does not need: a binary file's HEAD text, or
    // the content of a clean no-op (grouping drops it either way).
    if (contentless && c.headKey) memo.headBlobs.delete(c.headKey);
    const noop = !!change && change.before === change.after && !change.partial
      && change.status !== 'renamed' && change.status !== 'deleted';
    memo.files.set(accum.filePath, {
      ops: accum.ops.slice(),
      sig: c.sig,
      deletedBefore: contentless ? null : c.deletedBefore,
      contentless,
      change: noop ? { ...change!, before: '', after: '' } : change,
    });
    // Grouping below rewrites relPath/oldRelPath: hand out a copy, keep the memo pristine.
    if (change) changesByPath.set(accum.filePath, { ...change });
  });

  // 4-6. Group by repo root, drop no-ops/excluded, order.
  const groupsByRoot = new Map<string, SessionRepoGroup>();
  for (const accum of fileMap.values()) {
    await slice();
    const change = changesByPath.get(accum.filePath);
    const root = rootByPath.get(accum.filePath);
    if (!change || root === undefined) continue;
    // Drop CLEAN net no-op edits (edited then reverted); keep partial no-ops
    // and structural changes (rename/delete) — same policy as the server path.
    const structural = change.status === 'renamed' || change.status === 'deleted';
    if (change.before === change.after && !change.partial && !structural) continue;
    change.relPath = path.relative(root, accum.filePath) || path.basename(accum.filePath);
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

  for (const group of groupsByRoot.values()) {
    group.files = group.files.filter((f) => !isExcludedPath(f.filePath));
  }
  const kindOrder: Record<SessionRepoGroup['kind'], number> = { cwd: 0, submodule: 1, other: 2 };
  const groups = [...groupsByRoot.values()]
    .filter((g) => g.files.length > 0)
    .sort((a, b) => (kindOrder[a.kind] - kindOrder[b.kind]) || a.label.localeCompare(b.label));
  for (const g of groups) {
    g.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    await slice();
  }

  const fileCount = groups.reduce((n, g) => n + g.files.length, 0);
  const anyPartial = groups.some((g) => g.files.some((f) => f.partial));
  return {
    result: { sessionId: opts.sessionId, groups, fileCount, anyPartial },
    fileMap,
    effectiveCwd,
    jsonlPath,
    mtimeMs: st.mtimeMs,
    size: st.size,
    parseStats: { resumed, readBytes: state.offset + Buffer.byteLength(trailing) - readFrom },
    changesMemo: memo,
    computeStats: stats,
  };
}

/** Strip before/after for the wire (the list ships light; diffs load per file).
 *  Each file keeps its line counts, counted here while the content is still in hand. */
export function toLightChangesResult(result: SessionChangesResult): SessionChangesResult {
  const budget = lineCountBudget();
  return {
    ...result,
    groups: result.groups.map((g) => ({
      ...g,
      files: g.files.map((f) => ({ ...f, ...fileLineCounts(f, f, budget), before: '', after: '' })),
    })),
  };
}

// ── Line counts ("+12 -3") ──

/** Counted once per record object: a cached result is served many times. */
const lineCountMemo = new WeakMap<object, { additions: number; deletions: number }>();

/**
 * The record's additions and deletions: the counts it already carries (a light
 * record from a host), else counted from its before/after, else none (a light
 * record with no counts has nothing to count, and 0/0 would read "no change").
 */
export function fileLineCounts(
  f: { before: string; after: string; additions?: number; deletions?: number },
  /** The object to remember the count on, when `f` is a view of it. */
  memoKey: object = f,
  /** Steps shared by every file of one list (`lineCountBudget()`). */
  budget?: LineCountBudget,
): { additions?: number; deletions?: number } {
  if (typeof f.additions === 'number' && typeof f.deletions === 'number') return { additions: f.additions, deletions: f.deletions };
  if (!f.before && !f.after) return {};
  const memo = lineCountMemo.get(memoKey);
  if (memo) return memo;
  if (budget) {
    const size = f.before.length + f.after.length;
    if (size > budget.chars) return {};
    budget.chars -= size;
  }
  const counts = countLineChanges(f.before, f.after, budget);
  lineCountMemo.set(memoKey, counts);
  return counts;
}

/** Lines of a text the way a diff counts them: a final newline ends the last
 *  line, it does not start one, and a line's trailing CR (a CRLF file) is not
 *  part of it, as the phone's diff reads them (DiffEngine.lines). */
function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.endsWith('\r')) lines[i] = line.slice(0, -1);
  }
  return lines;
}

/** What one list may still spend on counting, across all its files: walk
 *  steps, and characters of text to split and map at all. */
export interface LineCountBudget { steps: number; chars: number }

/** One list's budget, held to tens of milliseconds of synchronous work on
 *  the event loop: a third of one large rewrite's walk, in all. */
export const LIST_COUNT_MAX_STEPS = 1_000_000;
/** Past this much text in one list (about 2 MB), the rest of its files go
 *  uncounted: no numbers rather than more synchronous work. */
export const LIST_COUNT_MAX_CHARS = 2_000_000;

export function lineCountBudget(): LineCountBudget {
  return { steps: LIST_COUNT_MAX_STEPS, chars: LIST_COUNT_MAX_CHARS };
}

/** Past this many changed lines in the middle the exact count is not worth its
 *  time. The phone's diff stops aligning at the same number
 *  (DiffEngine.maxAlignedEdits), so its list and its diff count alike. */
const EXACT_COUNT_MAX_EDITS = 1500;
/** ...nor past this many steps of the walk (a few milliseconds). */
const EXACT_COUNT_MAX_STEPS = 3_000_000;

/**
 * How many lines a line diff of before -> after adds and removes. Exact (an
 * LCS by Myers' O(ND) walk, after trimming the common head and tail) for any
 * ordinary change; a whole-file rewrite past EXACT_COUNT_MAX_EDITS edits
 * (or past EXACT_COUNT_MAX_STEPS steps) is counted by line multiset instead,
 * which can only undercount moved lines. With a `budget`, the walk also stops
 * when the list's shared steps run out (the walk's steps come out of it).
 * Dependency-free: this module is bundled into the host daemon.
 */
export function countLineChanges(
  before: string, after: string, budget?: LineCountBudget,
): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  const a = splitDiffLines(before);
  const b = splitDiffLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 || m === 0) return { additions: m, deletions: n };
  // Lines as small ints, so the walk compares numbers.
  const ids = new Map<string, number>();
  const idOf = (line: string): number => {
    let id = ids.get(line);
    if (id === undefined) { id = ids.size; ids.set(line, id); }
    return id;
  };
  const x = new Float64Array(n);
  const y = new Float64Array(m);
  for (let i = 0; i < n; i++) x[i] = idOf(a[head + i]!);
  for (let j = 0; j < m; j++) y[j] = idOf(b[head + j]!);
  const maxD = Math.min(n + m, EXACT_COUNT_MAX_EDITS);
  const offset = maxD + 1;
  const v = new Float64Array(2 * maxD + 3);
  // A bound on the walk's steps, so no one file (nor one list) holds the event loop long.
  const allowed = Math.min(EXACT_COUNT_MAX_STEPS, budget ? budget.steps : EXACT_COUNT_MAX_STEPS);
  let steps = allowed;
  const spend = () => { if (budget) budget.steps = Math.max(0, budget.steps - (allowed - Math.max(steps, 0))); };
  walk: for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let i = (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) { i++; j++; steps--; }
      if (--steps < 0) break walk;
      v[offset + k] = i;
      if (i >= n && j >= m) {
        spend();
        // d edits = deletions + additions, and additions - deletions = m - n.
        const deletions = (d + n - m) / 2;
        return { additions: d - deletions, deletions };
      }
    }
  }
  spend();
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) counts.set(x[i]!, (counts.get(x[i]!) ?? 0) + 1);
  let common = 0;
  for (let j = 0; j < m; j++) {
    const c = counts.get(y[j]!) ?? 0;
    if (c > 0) { common++; counts.set(y[j]!, c - 1); }
  }
  return { additions: m - common, deletions: n - common };
}
