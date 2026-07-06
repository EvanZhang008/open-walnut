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
import {
  readSessionJsonlContent,
  readSubagentContents,
  isSafeForProjectEncoding,
  remoteJsonlPath,
  createFileReader,
} from './session-file-reader.js';
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
  /** How the file was changed — 'added' (Write to a new/empty file), 'deleted'
   *  (current content empty), or 'modified'. */
  status: 'added' | 'modified' | 'deleted';
  /** Number of distinct Edit/Write/MultiEdit ops the session applied. */
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
  | { kind: 'write'; content: string };

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
      if (block.type !== 'tool_use' || !block.name || !EDIT_TOOLS.has(block.name)) continue;
      const input = block.input;
      if (!input) continue;
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
 */
function reconstructFile(current: string | null, accum: FileAccum): Omit<SessionFileChange, 'filePath' | 'relPath'> {
  const ops = accum.ops;
  const lastOp = ops[ops.length - 1];
  let partial = false;

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

  // `before`: reverse-apply ops newest→oldest onto `after`.
  let before = after;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.kind === 'write') {
      // A Write replaced the whole file. Everything before this Write is unknown
      // from `after` alone — the pre-Write content is whatever the op BEFORE it
      // produced. If this is the first op, before-this-write is "" (file created),
      // unless an even-earlier op exists. Since we go newest→oldest, once we hit a
      // Write we reset `before` to the empty string and keep walking earlier ops
      // (which, if any, were edits to the pre-existing file → they reconstruct the
      // original). In practice a Write is usually the FIRST op (file created) or the
      // ONLY op, so before = "".
      before = '';
    } else {
      const r = reverseEdit(before, op);
      before = r.text;
      if (!r.ok) partial = true;
    }
  }

  // Status.
  let status: SessionFileChange['status'];
  if (before === '' && after !== '') status = 'added';
  else if (after === '' && before !== '') status = 'deleted';
  else status = 'modified';

  return { before, after, status, ops: ops.length, partial };
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

// ── mtime cache ──

interface CacheEntry {
  mtimeMs: number;
  result: SessionChangesResult;
}
const changesCache = new Map<string, CacheEntry>();
const MAX_CACHE = 30;

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
  const key = cacheKey(sessionId, host);

  // mtime fast-path: if the canonical JSONL hasn't changed since we last parsed,
  // the SET of ops is identical — but `after` (current file content) may have
  // changed on disk. So the cache is only valid for completed sessions where the
  // JSONL mtime is the dominant signal. We still re-read current file content is
  // cheap relative to re-parsing a 20MB JSONL, so: cache the parsed op map keyed
  // on mtime, but always re-read file contents. For simplicity + correctness we
  // cache the full result and invalidate on JSONL mtime change; an explicit
  // refresh (no-cache) is available via the route's ?refresh=1.
  // DAEMON-UNIFORM mtime-cache stat: both local (__local__) and remote go through
  // the daemon's fs.stat. cwd known + safe → exact tilde path; else skip the cache
  // (a find just to stat isn't worth it — the full read below still runs).
  let mtimeMs: number | undefined;
  if (cwd && isSafeForProjectEncoding(cwd)) {
    try {
      const { DaemonFileReader } = await import('./daemon-file-reader.js');
      const reader = new DaemonFileReader(host ?? '__local__');
      const statResult = await reader.stat(remoteJsonlPath(sessionId, cwd));
      if (statResult) {
        mtimeMs = statResult.mtimeMs;
        if (!opts?.noCache) {
          const cached = cacheGet(key);
          if (cached && cached.mtimeMs === mtimeMs) return cached.result;
        }
      }
    } catch {
      // stat failed (transport / old daemon) — proceed with full read.
    }
  }

  // 1. Read the main-session JSONL (local or remote) + collect ops.
  const fileMap = new Map<string, FileAccum>();
  const main = await readSessionJsonlContent(sessionId, cwd, host, outputFile);
  if (main) collectOpsFromJsonl(main.content, fileMap);

  // foundCwd from JSONL beats a possibly-stale param cwd.
  const effectiveCwd = main?.foundCwd ?? cwd;

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

  if (fileMap.size === 0) {
    const empty: SessionChangesResult = { sessionId, groups: [], fileCount: 0, anyPartial: false };
    if (mtimeMs !== undefined) cacheSet(key, { mtimeMs, result: empty });
    return empty;
  }

  // 3. Read current content for each file (after) + reconstruct before.
  const reader = await createFileReader(host);
  const isRemote = !!host;

  // Resolve a per-file change record.
  const changesByPath = new Map<string, SessionFileChange>();
  await Promise.all(
    [...fileMap.values()].map(async (accum) => {
      let current: string | null = null;
      try {
        current = await reader.readFile(accum.filePath);
      } catch {
        current = null;
      }
      const recon = reconstructFile(current, accum);
      changesByPath.set(accum.filePath, { filePath: accum.filePath, relPath: accum.filePath, ...recon });
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
  const gitRootByDir = new Map<string, string | null>();
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
    if (change.before === change.after && !change.partial) continue;
    const { root, orphan } = await resolveRepoRoot(accum.filePath, accum.cwd);
    // Skip stray out-of-repo scratch files (see resolveRepoRoot) so the set
    // matches the git modes, which can never show a non-repo file.
    if (orphan) continue;
    change.relPath = path.relative(root, accum.filePath) || path.basename(accum.filePath);

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

  if (mtimeMs !== undefined) cacheSet(key, { mtimeMs, result });
  return result;
}
