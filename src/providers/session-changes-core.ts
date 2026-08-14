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
 * string fallback twin) deliberately does NOT mirror this pipeline; it strips
 * 'changes-v1' from its hello capabilities so the server uses the fallback.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseBashFileOps } from '../core/bash-file-ops.js';

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

export type FileOp =
  | { kind: 'edit'; oldString: string; newString: string; replaceAll: boolean }
  | { kind: 'write'; content: string }
  | { kind: 'create' }
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
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Extract file ops from one JSONL content string, appending to `fileMap`. */
export function collectOpsFromJsonl(content: string, fileMap: Map<string, FileAccum>): void {
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
        // Notebook cells: best-effort treat new_source as an edit onto old.
        const newSrc = typeof input.new_source === 'string' ? input.new_source : undefined;
        if (newSrc !== undefined) {
          accum.ops.push({ kind: 'edit', oldString: '', newString: newSrc, replaceAll: false });
        }
      }

      fileMap.set(filePath, accum);
    }
  }
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
  // content-boundary markers, not text edits.
  let before = after;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    if (op.kind === 'write' || op.kind === 'create') {
      before = '';
    } else if (op.kind === 'rename' || op.kind === 'delete') {
      if (op.kind === 'delete') before = '';
    } else {
      const r = reverseEdit(before, op);
      before = r.text;
      if (!r.ok) partial = true;
    }
  }

  let status: SessionFileChange['status'];
  if (renamedFrom !== undefined) status = 'renamed';
  else if (before === '' && after !== '') status = 'added';
  else if (after === '' && before !== '') status = 'deleted';
  else status = 'modified';

  return { before, after, status, ops: ops.length, partial, renamedFrom };
}

// ── path filtering + repo grouping ──

/** Claude/Walnut bookkeeping (plans + Claude Code's per-project memory dir). */
function isBookkeepingPath(filePath: string): boolean {
  return /(^|\/)\.claude\/(plans|projects)\//.test(filePath);
}

/** Agent MEMORY STORE entries (butler/subagent persistent memory, not code). */
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
  /** Abort if the whole compute exceeds this (default 100s). */
  deadlineMs?: number;
}

export interface HostLocalComputeOutput {
  result: SessionChangesResult;
  /** The merged op map — kept by the daemon to serve per-file requests. */
  fileMap: Map<string, FileAccum>;
  effectiveCwd?: string;
  jsonlPath: string;
  mtimeMs: number;
  size: number;
}

const STREAM_WINDOW = 1024 * 1024;
const CONTENT_READ_PARALLELISM = 8;

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
  try { dirs = await fsp.readdir(projectsDir); } catch { return null; }
  for (const d of dirs) {
    const candidate = path.join(projectsDir, d, `${sessionId}.jsonl`);
    try { await fsp.access(candidate); return candidate; } catch { /* keep scanning */ }
  }
  return null;
}

/** Stream-parse a whole JSONL into `fileMap` in 1MB newline-aligned windows —
 *  never materializes the file as one string (whales exceed any sane cap).
 *  Yields the event loop between windows so the daemon's session I/O never
 *  starves. Returns the first decoded block (for cwd extraction). */
async function streamParseHostLocal(
  jsonlPath: string,
  fileMap: Map<string, FileAccum>,
  deadlineMs: number,
): Promise<{ headBlock: string } | null> {
  let fh: fsp.FileHandle;
  try { fh = await fsp.open(jsonlPath, 'r'); } catch { return null; }
  try {
    let carry = Buffer.alloc(0);
    let headBlock = '';
    const win = Buffer.alloc(STREAM_WINDOW);
    let offset = 0;
    for (;;) {
      if (Date.now() > deadlineMs) throw new Error('changes: stream-parse deadline exceeded');
      const { bytesRead } = await fh.read(win, 0, STREAM_WINDOW, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const buf = carry.length ? Buffer.concat([carry, win.subarray(0, bytesRead)]) : Buffer.from(win.subarray(0, bytesRead));
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl !== -1) {
        const text = buf.subarray(0, lastNl + 1).toString('utf-8');
        collectOpsFromJsonl(text, fileMap);
        if (!headBlock) headBlock = text;
        carry = Buffer.from(buf.subarray(lastNl + 1));
      } else {
        carry = buf;
      }
      // Explicit yield: fh.read can complete synchronously from page cache.
      await new Promise<void>((r) => setImmediate(r));
    }
    if (carry.length) collectOpsFromJsonl(carry.toString('utf-8'), fileMap);
    return { headBlock };
  } finally {
    await fh.close().catch(() => { /* already closed */ });
  }
}

/** Recover a deleted file's last-committed content via `git show HEAD:<rel>`. */
async function readDeletedBeforeHostLocal(absPath: string): Promise<string | null> {
  const run = (argv: string[], cwd: string) => new Promise<{ stdout: string; code: number }>((resolve) => {
    execFile(argv[0]!, argv.slice(1), { cwd, timeout: 10_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf-8' },
      (err, stdout) => resolve({ stdout: stdout || '', code: err ? 1 : 0 }));
  });
  try {
    const dir = path.dirname(absPath);
    const root = await run(['git', 'rev-parse', '--show-toplevel'], dir);
    if (root.code !== 0) return null;
    const repoRoot = root.stdout.trim();
    if (!repoRoot) return null;
    let realDir = dir;
    try { realDir = await fsp.realpath(dir); } catch { /* dir also gone */ }
    const rel = path.relative(repoRoot, path.join(realDir, path.basename(absPath)));
    if (!rel || rel.startsWith('..')) return null;
    const show = await run(['git', 'show', `HEAD:${rel}`], repoRoot);
    return show.code === 0 ? show.stdout : null;
  } catch {
    return null;
  }
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

  // 1. Main JSONL ops (streamed).
  const fileMap = new Map<string, FileAccum>();
  const parsed = await streamParseHostLocal(jsonlPath, fileMap, deadlineMs);
  if (parsed === null) return null;
  const effectiveCwd = extractCwdFromJsonl(parsed.headBlock) ?? opts.cwd;

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
    const sub = new Map<string, FileAccum>();
    const ok = await streamParseHostLocal(p, sub, deadlineMs);
    if (ok) subCache.set(name, { size: sst.size, fileMap: sub });
  }
  for (const name of [...present].sort()) {
    const c = subCache.get(name);
    if (c) mergeFileMapInto(c.fileMap, fileMap);
  }

  // 3. Current contents + reconstruction (bounded pool — local fs, still
  //    keep the daemon's loop responsive).
  const changesByPath = new Map<string, SessionFileChange>();
  const entries = [...fileMap.values()];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const accum = entries[next++]!;
      let current: string | null = null;
      try { current = await fsp.readFile(accum.filePath, 'utf-8'); } catch { current = null; }
      const isDeleted = accum.ops[accum.ops.length - 1]?.kind === 'delete';
      const deletedBefore = isDeleted ? await readDeletedBeforeHostLocal(accum.filePath) : null;
      const { renamedFrom, ...recon } = reconstructFile(current, accum, deletedBefore);
      const change: SessionFileChange = { filePath: accum.filePath, relPath: accum.filePath, ...recon };
      if (renamedFrom !== undefined) change.oldRelPath = renamedFrom;
      changesByPath.set(accum.filePath, change);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONTENT_READ_PARALLELISM, entries.length) }, worker));

  // 4-6. Group by repo root, drop no-ops/orphans/excluded, order.
  const gitRootByDir = opts.gitRootByDir ?? new Map<string, string | null>();
  const cwdRepoRoot = effectiveCwd ? await findGitRootHostLocal(effectiveCwd) : null;
  const isUnder = (child: string, ancestor: string): boolean =>
    child === ancestor || child.startsWith(ancestor + path.sep);
  const resolveRepoRoot = async (filePath: string, fileCwd?: string): Promise<{ root: string; orphan: boolean }> => {
    const dir = path.dirname(filePath);
    let gitRoot: string | null;
    if (gitRootByDir.has(dir)) {
      gitRoot = gitRootByDir.get(dir)!;
    } else {
      gitRoot = await findGitRootHostLocal(dir);
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
    // Drop CLEAN net no-op edits (edited then reverted); keep partial no-ops
    // and structural changes (rename/delete) — same policy as the server path.
    const structural = change.status === 'renamed' || change.status === 'deleted';
    if (change.before === change.after && !change.partial && !structural) continue;
    const { root, orphan } = await resolveRepoRoot(accum.filePath, accum.cwd);
    if (orphan) continue; // out-of-repo scratch — git modes can never show it
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
  for (const g of groups) g.files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const fileCount = groups.reduce((n, g) => n + g.files.length, 0);
  const anyPartial = groups.some((g) => g.files.some((f) => f.partial));
  return {
    result: { sessionId: opts.sessionId, groups, fileCount, anyPartial },
    fileMap,
    effectiveCwd,
    jsonlPath,
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
}

/** Strip before/after for the wire (the list ships light; diffs load per file). */
export function toLightChangesResult(result: SessionChangesResult): SessionChangesResult {
  return {
    ...result,
    groups: result.groups.map((g) => ({
      ...g,
      files: g.files.map((f) => ({ ...f, before: '', after: '' })),
    })),
  };
}
