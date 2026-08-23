/**
 * Conflict-marker detection + last-valid-version recovery for JSON data files.
 *
 * The incident this exists for (2026-08-22): an orphaned-rebase recovery left
 * git conflict markers INSIDE two data-repo JSON files
 * (`config/share/ui-prefs.json` had nested `<<<<<<< HEAD` / `|||||||` diff3
 * markers, a conversation file had them at line 3). The 30s auto-save then
 * committed that marker text as the file's real content, and every later read
 * threw `Failed to parse …` — hours of 500s on /api/ui-prefs plus six crashes
 * of a bus subscriber. Marker text is never data, so it must never be
 * committed as the live file, and a read must never dead-end on it when git
 * history still holds a good version.
 *
 * Two users, one mechanism:
 *  - WRITE side (`src/integrations/git-sync.ts`): scan changed .json files
 *    before `add -A`, and after any merge/rescue resolution.
 *  - READ side (`src/utils/fs.ts`): when `JSON.parse` fails for a file inside
 *    the data dir, restore the newest version from history instead of throwing.
 *
 * Everything here is async on purpose: this code runs on the web server's event
 * loop (the 30s sync tick and every JSON read), so `execSync` is banned —
 * `tests/core/event-loop-blocking-ratchet.test.ts` enforces that.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** git writes conflict markers at column 0 — matching only there is what keeps
 * a legitimate JSON string value containing "<<<<<<< " from being flagged. */
export const CONFLICT_BEGIN = '<<<<<<< ';
export const CONFLICT_END = '>>>>>>> ';

/**
 * Bytes read per file for the marker scan. The write-side guard runs every 30s
 * over every changed .json file, and a data repo holds multi-MB stores, so the
 * scan reads a bounded prefix rather than whole files. Trade-off: a marker
 * beyond this offset is missed by the write guard — the read-side self-heal
 * still catches that file the first time something parses it.
 */
export const MARKER_SCAN_BYTES = 200 * 1024;

/** How many commits back to look for a version that parses. */
export const HISTORY_DEPTH = 8;

const GIT_TIMEOUT_MS = 10_000;
/** A single data-store blob can be several MB; 32MB is the ceiling, not a
 * preallocation. */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

// ── Pure helpers (unit-testable without a git repo) ─────────────────────────

export interface MarkerScan {
  /** A line begins with '<<<<<<< '. */
  begin: boolean;
  /** A line AFTER the begin line starts with '>>>>>>> '. */
  end: boolean;
  /** JSON.parse failed on complete (untruncated) content. */
  unparsable: boolean;
  /** Trio verdict: markers plus corroboration. */
  conflicted: boolean;
}

/**
 * Trio heuristic. A lone `=======` line is far too common in real data (it
 * shows up in markdown, in logs, in any ASCII art), so the verdict needs the
 * distinctive `<<<<<<< ` opener PLUS corroboration: either the matching
 * `>>>>>>> ` closer later in the file, or a parse failure on complete content.
 * Both diff3 (`|||||||`) and the default 3-way marker style satisfy this.
 */
export function scanForConflictMarkers(text: string, truncated = false): MarkerScan {
  const lines = text.split('\n');
  let beginAt = -1;
  let end = false;
  for (let i = 0; i < lines.length; i++) {
    if (beginAt === -1) {
      if (lines[i].startsWith(CONFLICT_BEGIN)) beginAt = i;
      continue;
    }
    if (lines[i].startsWith(CONFLICT_END)) { end = true; break; }
  }
  const begin = beginAt !== -1;
  // Only parse when it can change the answer: markers present, no closer seen,
  // and the content is complete (a truncated prefix never parses on its own).
  const unparsable = begin && !end && !truncated && !isParsableJson(text);
  return { begin, end, unparsable, conflicted: begin && (end || unparsable) };
}

/** True when `text` is complete, non-empty JSON. */
export function isParsableJson(text: string): boolean {
  if (text.trim().length === 0) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * First candidate whose content parses as JSON. Candidates are expected in
 * newest-first order, so this returns the LAST VALID version.
 */
export function firstParsableCandidate(
  candidates: Array<{ rev: string; content: string | null }>,
): { rev: string; content: string } | null {
  for (const c of candidates) {
    if (c.content !== null && isParsableJson(c.content)) return { rev: c.rev, content: c.content };
  }
  return null;
}

/**
 * Decode a `git status --porcelain` path. git quotes paths containing unusual
 * bytes (`core.quotePath`, on by default) and escapes non-ASCII as octal, so
 * the raw field is not a filesystem path. Returns null when the quoting is
 * malformed — a path we cannot decode is one we must not act on.
 */
export function unquotePorcelainPath(raw: string): string | null {
  if (!raw.startsWith('"')) return raw;
  if (raw.length < 2 || !raw.endsWith('"')) return null;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf-8')) bytes.push(b);
      continue;
    }
    const next = body[++i];
    if (next === undefined) return null;
    if (next === 'n') bytes.push(0x0a);
    else if (next === 't') bytes.push(0x09);
    else if (next === 'r') bytes.push(0x0d);
    else if (next === '"') bytes.push(0x22);
    else if (next === '\\') bytes.push(0x5c);
    else if (next >= '0' && next <= '7') {
      const oct = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(oct)) return null;
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else return null;
  }
  return Buffer.from(bytes).toString('utf-8');
}

/**
 * Status prefix of a porcelain line: one or two status letters, then the single
 * separator space.
 *
 * NOT a fixed `slice(3)`, and that is load-bearing: every status read in this
 * codebase goes through `gitSafeAsync`, which TRIMS the whole output — so the
 * FIRST line of `git status --porcelain` loses its leading space whenever the
 * index is clean (` M a.json` arrives as `M a.json`, the most common shape of
 * all). A positional slice silently yields `.json`-suffixed garbage for that one
 * line, which is exactly how the first version of this guard scanned nothing at
 * all. Anchoring on the mandatory separator space instead is trim-proof.
 */
const PORCELAIN_PREFIX_RE = /^[ MADRCUT?!]{1,2} (.*)$/;

/**
 * Changed .json paths from `git status --porcelain` lines.
 *
 * Only .json is considered: markers in a note or a log are ugly but harmless,
 * while markers in a JSON store take a route down with a parse error. Deleted
 * paths are kept in the list on purpose — the bounded read reports "missing"
 * and skips them, which is cheaper than modelling every porcelain XY code.
 */
export function jsonCandidatesFromPorcelain(lines: string[]): string[] {
  const out = new Set<string>();
  for (const line of lines) {
    const match = PORCELAIN_PREFIX_RE.exec(line);
    if (!match) continue;
    let field = match[1].trim();
    if (field.length === 0) continue;
    // Renames/copies are "old -> new"; only the new path exists on disk.
    const arrow = field.lastIndexOf(' -> ');
    if (arrow !== -1) field = field.slice(arrow + 4).trim();
    const decoded = unquotePorcelainPath(field);
    if (!decoded || !decoded.endsWith('.json')) continue;
    out.add(decoded);
  }
  return [...out];
}

// ── Data dir resolution ─────────────────────────────────────────────────────

/**
 * Minimal duplicate of `src/constants.ts`'s WALNUT_HOME resolution.
 *
 * DUPLICATED ON PURPOSE: this module is reached from `src/utils/fs.ts`, which
 * is a leaf utility imported by nearly every module in the tree. Pulling
 * `constants.ts` in from there would invert that dependency (constants is
 * import-time evaluated and sits ABOVE the utils layer) for the sake of one
 * path. Reading the env var is equivalent in practice because constants.ts
 * WRITES `process.env.OPEN_WALNUT_HOME` whenever it overrides the default
 * (test isolation, ephemeral children), so the two always agree. Resolved on
 * every call, never cached, so a test that repoints the env var is honoured.
 */
export function resolveWalnutDataDir(): string {
  return process.env.OPEN_WALNUT_HOME || path.join(os.homedir(), '.open-walnut');
}

/** True when `filePath` lives in (or under) the walnut data dir. */
export function isInsideWalnutDataDir(filePath: string): boolean {
  const dataDir = path.resolve(resolveWalnutDataDir());
  const abs = path.resolve(filePath);
  return abs === dataDir || abs.startsWith(dataDir + path.sep);
}

// ── git plumbing (async only) ───────────────────────────────────────────────

async function gitRead(repoDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoDir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf-8',
    });
    return stdout;
  } catch {
    return null;
  }
}

/** Commit shas that touched `relPath`, newest first. */
export async function listRecentCommits(
  repoDir: string,
  relPath: string,
  depth = HISTORY_DEPTH,
): Promise<string[]> {
  const out = await gitRead(repoDir, ['log', `-n`, String(depth), '--format=%H', '--', relPath]);
  if (!out) return [];
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Content of `relPath` at `rev`, or null when it does not exist there. */
export async function showAtRev(
  repoDir: string,
  rev: string,
  relPath: string,
): Promise<string | null> {
  return gitRead(repoDir, ['show', `${rev}:${relPath}`]);
}

/**
 * Newest version of `relPath` in history that parses as JSON.
 *
 * HEAD is probed first because it is "the last committed version" regardless of
 * which commit last touched the path; the `git log` walk covers the case where
 * HEAD itself carries the marker text (exactly what happened in the incident —
 * the bad content was committed). Candidates are fetched lazily, so the common
 * case costs ONE `git show`.
 */
export async function findLastValidJsonVersion(
  repoDir: string,
  relPath: string,
  depth = HISTORY_DEPTH,
): Promise<{ rev: string; content: string } | null> {
  const head = await showAtRev(repoDir, 'HEAD', relPath);
  const fromHead = firstParsableCandidate([{ rev: 'HEAD', content: head }]);
  if (fromHead) return fromHead;

  for (const sha of await listRecentCommits(repoDir, relPath, depth)) {
    const content = await showAtRev(repoDir, sha, relPath);
    const hit = firstParsableCandidate([{ rev: sha, content }]);
    if (hit) return hit;
  }
  return null;
}

/**
 * Nearest enclosing git repo root at or above `startDir`, never walking above
 * `boundaryDir`. The boundary matters: without it a corrupt file in a data dir
 * that is NOT a repo would resolve to whatever repo happens to contain the home
 * directory, and we would "restore" a file from an unrelated history.
 */
export async function findRepoRootUpward(
  startDir: string,
  boundaryDir: string,
): Promise<string | null> {
  const boundary = path.resolve(boundaryDir);
  let dir = path.resolve(startDir);
  if (dir !== boundary && !dir.startsWith(boundary + path.sep)) return null;
  for (;;) {
    try {
      await fsp.stat(path.join(dir, '.git'));
      return dir;
    } catch { /* keep walking */ }
    if (dir === boundary) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── file helpers ────────────────────────────────────────────────────────────

/**
 * Read at most `maxBytes` of a file. Returns null when there is nothing to
 * scan (missing file, directory, unreadable).
 */
export async function readFileBounded(
  filePath: string,
  maxBytes = MARKER_SCAN_BYTES,
): Promise<{ text: string; truncated: boolean } | null> {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, maxBytes);
    const buf = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0);
    return { text: buf.subarray(0, bytesRead).toString('utf-8'), truncated: stat.size > maxBytes };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** `<name>.<label>-<timestamp>` beside the original (same dir → no EXDEV). */
export function sidecarPath(filePath: string, label: 'conflicted' | 'corrupt'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${filePath}.${label}-${stamp}`;
}

/** tmp-then-rename in the SAME directory (rename across filesystems = EXDEV). */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.open-walnut-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, content, 'utf-8');
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// ── the heal action ─────────────────────────────────────────────────────────

export interface HealResult {
  action: 'restored' | 'quarantined' | 'skipped' | 'failed';
  /** Rev the content came from ('HEAD' or a sha). */
  restoredFrom?: string;
  /** Where the damaged original was parked for forensics. */
  movedTo?: string;
  /** The restored content (already validated as parsable). */
  content?: string;
  error?: string;
}

/**
 * Replace a damaged JSON file with the newest version from git history, keeping
 * the damaged original beside it for forensics.
 *
 * The forensic sidecar (`<name>.conflicted-<ts>` / `<name>.corrupt-<ts>`) lives
 * in the data repo, so both patterns are gitignored (git-sync's
 * EXTRA_IGNORE_PATTERNS) — otherwise the next auto-save would commit the marker
 * text again under a second name. Keeping it matters: one side of a conflict can
 * be a local edit that never reached a commit.
 *
 * `quarantineOnFailure` is the write-side posture: when NO valid version exists
 * the damaged file is moved aside anyway, because a missing file reads as
 * "first run" (fallback) while marker text reads as a crash. The read side
 * leaves the file alone instead and lets the original parse error surface.
 */
export async function healJsonFileFromHistory(opts: {
  repoDir: string;
  filePath: string;
  relPath?: string;
  label: 'conflicted' | 'corrupt';
  quarantineOnFailure?: boolean;
  depth?: number;
}): Promise<HealResult> {
  const relPath = (opts.relPath ?? path.relative(opts.repoDir, opts.filePath)).split(path.sep).join('/');
  if (relPath.startsWith('..')) return { action: 'skipped', error: 'file is outside repoDir' };

  const valid = await findLastValidJsonVersion(opts.repoDir, relPath, opts.depth);
  const parked = sidecarPath(opts.filePath, opts.label);

  if (!valid) {
    if (!opts.quarantineOnFailure) return { action: 'skipped', error: 'no valid version in history' };
    try {
      await fsp.rename(opts.filePath, parked);
      return { action: 'quarantined', movedTo: parked };
    } catch (err) {
      return { action: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Park the damaged original first. A missing original (a concurrent reader
  // already parked it) must not stop the restore — the good content is what
  // callers are waiting for.
  let movedTo: string | undefined;
  try {
    await fsp.rename(opts.filePath, parked);
    movedTo = parked;
  } catch { /* already gone or unrenamable — restore anyway */ }

  try {
    await writeFileAtomic(opts.filePath, valid.content);
  } catch (err) {
    return { action: 'failed', movedTo, error: err instanceof Error ? err.message : String(err) };
  }
  return { action: 'restored', restoredFrom: valid.rev, movedTo, content: valid.content };
}

// ── read-side self-heal orchestration ───────────────────────────────────────

/** Repeated failures are memoised briefly so a hot read path cannot turn one
 * unrecoverable file into a git-subprocess storm (the /api/ui-prefs 500 loop
 * hit the same file on every request). */
const SELF_HEAL_FAILURE_MEMO_MS = 60_000;
const selfHealFailedAt = new Map<string, number>();
const selfHealInflight = new Map<string, Promise<SelfHealResult | null>>();

export interface SelfHealResult {
  content: string;
  restoredFrom: string;
  movedTo?: string;
}

/** Test hook: forget memoised failures and in-flight work. */
export function resetJsonSelfHealCacheForTest(): void {
  selfHealFailedAt.clear();
  selfHealInflight.clear();
}

/**
 * Read-side self-heal. Returns the restored content, or null when recovery is
 * not possible or not allowed — callers must then surface their ORIGINAL parse
 * error unchanged.
 *
 * Gated to the walnut data dir on purpose: repo config files and test fixtures
 * must keep failing loudly, and "silently swap in an older version" is only a
 * defensible move for a store whose history we own.
 */
export async function selfHealDataDirJson(filePath: string): Promise<SelfHealResult | null> {
  const abs = path.resolve(filePath);
  if (!isInsideWalnutDataDir(abs)) return null;

  const failedAt = selfHealFailedAt.get(abs);
  if (failedAt !== undefined && Date.now() - failedAt < SELF_HEAL_FAILURE_MEMO_MS) return null;

  const existing = selfHealInflight.get(abs);
  if (existing) return existing;

  const work = (async (): Promise<SelfHealResult | null> => {
    const dataDir = resolveWalnutDataDir();
    const repoRoot = await findRepoRootUpward(path.dirname(abs), dataDir);
    if (!repoRoot) return null;
    const result = await healJsonFileFromHistory({
      repoDir: repoRoot,
      filePath: abs,
      label: 'corrupt',
      quarantineOnFailure: false,
    });
    if (result.action !== 'restored' || !result.content) return null;
    return { content: result.content, restoredFrom: result.restoredFrom!, movedTo: result.movedTo };
  })()
    .catch(() => null)
    .then((res) => {
      if (res === null) {
        // Bound the memo: this only ever holds paths that failed to recover.
        if (selfHealFailedAt.size > 200) selfHealFailedAt.clear();
        selfHealFailedAt.set(abs, Date.now());
      } else {
        selfHealFailedAt.delete(abs);
      }
      return res;
    })
    .finally(() => { selfHealInflight.delete(abs); });

  selfHealInflight.set(abs, work);
  return work;
}
