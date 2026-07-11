import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { bus, EventNames } from '../core/event-bus.js';
import { log } from '../logging/index.js';

export interface SyncStatus {
  initialized: boolean;
  remoteConfigured: boolean;
  lastSyncAt: string | null;
  pendingChanges: number;
  branch: string;
}

const LOCAL_TIMEOUT = 30_000;
const NETWORK_TIMEOUT = 15_000;

/** Flag set by git-compaction to pause auto-commits during compaction. */
export let compactionInProgress = false;
export function setCompactionInProgress(v: boolean): void {
  compactionInProgress = v;
}

// Network git subcommands that may authenticate against a remote. Only these
// get the credential-helper guard — local ops never touch credentials.
const NETWORK_GIT_RE = /^(?:clone|fetch|pull|push|ls-remote)\b/;

/**
 * When the repo's remote URL already embeds credentials (https://user:token@host),
 * neutralize ALL credential helpers (system/global/local) for network git ops via
 * `-c credential.helper=`. Otherwise git calls the helper's `store` action after
 * every successful auth — on macOS (osxkeychain) that write pops a
 * "Keychain Not Found" dialog when the process has no keychain session, and it's
 * pointless anyway: the token in the URL always wins, the stored copy is never read.
 *
 * IMPORTANT: only guard when the URL carries credentials. If it doesn't, a helper
 * (e.g. keychain) may be the user's ONLY credential source — disabling it would
 * silently break their sync with 401s.
 */
export function credentialGuardArgs(cwd?: string): string[] {
  try {
    const urls = execSync('git config --get-regexp "remote\\..*\\.url"', {
      cwd: cwd ?? WALNUT_HOME,
      timeout: LOCAL_TIMEOUT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // https://ANYTHING@host — userinfo present means embedded credentials
    if (/https?:\/\/[^/\s]+@/.test(urls)) return ['-c', 'credential.helper='];
  } catch {
    // No remotes / not a repo — nothing to guard
  }
  return [];
}

export function git(args: string, options?: { cwd?: string; timeout?: number; env?: Record<string, string> }): string {
  const guard = NETWORK_GIT_RE.test(args) ? credentialGuardArgs(options?.cwd).join(' ') : '';
  return execSync(`git ${guard ? `${guard} ` : ''}${args}`, {
    cwd: options?.cwd ?? WALNUT_HOME,
    timeout: options?.timeout ?? LOCAL_TIMEOUT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options?.env ? { ...process.env, ...options.env } : undefined,
  }).trim();
}

export function gitSafe(args: string, options?: { cwd?: string; timeout?: number; env?: Record<string, string> }): string | null {
  try {
    return git(args, options);
  } catch {
    return null;
  }
}

export function isGitAvailable(): boolean {
  try {
    execSync('git --version', { timeout: LOCAL_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function isRepo(): boolean {
  return gitSafe('rev-parse --is-inside-work-tree') === 'true';
}

function hasRemote(): boolean {
  const remotes = gitSafe('remote');
  return remotes !== null && remotes.length > 0;
}

function getBranch(): string {
  return gitSafe('rev-parse --abbrev-ref HEAD') ?? 'main';
}

const GITIGNORE_CONTENT = `# Binary / large / ephemeral
browser/
images/
media/
timeline/
sessions/streams/

# SQLite (binary, self-managed)
*.sqlite
*.sqlite-shm
*.sqlite-wal

# Auth tokens (sensitive)
sync/ms-todo-tokens.json
auth.json

# Sync state (ephemeral)
sync/ms-todo-delta.json
sync/*.json

# Task backups (redundant with git)
tasks/*.backup*
tasks/*.bak*
tasks/archive/

# Runtime ephemeral
session-message-queue.json
*.lock/
*.lock

# Logs + OS
*.log
hook-errors.log
.DS_Store
node_modules/
`;

/**
 * Ignore entries that MUST be present even in pre-existing repos whose
 * .gitignore predates them. auth.json holds device-token hashes — it must
 * never ride the sync repo between machines (each box pairs its own devices).
 */
const CRITICAL_IGNORES = ['auth.json'];

/**
 * Append missing CRITICAL_IGNORES to an existing .gitignore (idempotent).
 * Called from ensureRepo() so every boot self-heals older installations.
 */
export function ensureCriticalIgnores(): void {
  const gitignorePath = path.join(WALNUT_HOME, '.gitignore');
  let content: string;
  try {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    return; // no .gitignore yet — initSync writes the full template
  }
  const lines = new Set(content.split('\n').map((l) => l.trim()));
  const missing = CRITICAL_IGNORES.filter((entry) => !lines.has(entry));
  if (missing.length === 0) return;
  const suffix = (content.endsWith('\n') ? '' : '\n')
    + '\n# Device-token auth (sensitive — never synced)\n'
    + missing.join('\n') + '\n';
  fs.writeFileSync(gitignorePath, content + suffix, 'utf-8');
}

export function initSync(remoteUrl?: string): void {
  if (!isRepo()) {
    git('init');
    git('checkout -b main');
  }

  // Create .gitignore if it doesn't exist
  const gitignorePath = path.join(WALNUT_HOME, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
  } else {
    ensureCriticalIgnores();
  }

  if (remoteUrl) {
    setRemote(remoteUrl);
  }

  // Initial commit if repo is empty
  const hasCommits = gitSafe('log --oneline -1') !== null;
  if (!hasCommits) {
    git('add -A');
    gitSafe('commit -m "open-walnut init"');
  }
}

export function setRemote(url: string): void {
  if (hasRemote()) {
    git(`remote set-url origin ${url}`);
  } else {
    git(`remote add origin ${url}`);
  }
  hardenGitConfigPerms(url);
}

/**
 * If the remote URL embeds credentials, .git/config now holds a plaintext
 * token — tighten it from git's default 0644 to owner-only.
 */
export function hardenGitConfigPerms(url: string, repoDir?: string): void {
  if (!/https?:\/\/[^/\s]+@/.test(url)) return;
  try {
    fs.chmodSync(path.join(repoDir ?? WALNUT_HOME, '.git', 'config'), 0o600);
  } catch {
    // Best-effort (e.g. exotic setups where .git is a file) — never fail the caller
  }
}

export function sync(): { pulled: number; pushed: number; conflicts: number } {
  let pulled = 0;
  let pushed = 0;
  let conflicts = 0;

  // Commit everything BEFORE pulling/merging so no local edit is ever
  // unrecorded — even if it loses an LWW conflict it stays in history.
  git('add -A');

  // Check for staged changes
  const diff = gitSafe('diff --cached --stat');
  if (diff && diff.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    gitSafe(`commit -m "open-walnut sync ${timestamp}"`);
    pushed = 1;
  }

  // Pull if remote is configured. Clean case: rebase (keeps history linear).
  // Conflict case: abort the rebase and do a TRUE MERGE with per-file LWW
  // resolution — a merge commit preserves BOTH parents, so the losing side
  // of every conflict remains recoverable from git history (rebase would
  // rewrite the local commits and destroy that guarantee).
  if (hasRemote()) {
    const branch = getBranch();
    const pullResult = gitSafe(`pull --rebase origin ${branch}`, { timeout: NETWORK_TIMEOUT });
    if (pullResult === null) {
      // Rebase failed — could be a content conflict or a network error.
      // Abort any half-applied rebase (no-op if none), then take the merge path.
      gitSafe('rebase --abort');
      const merge = lwwMerge(branch);
      conflicts = merge.conflicts;
      if (merge.merged) pulled = 1;
    } else if (pullResult.includes('Updating') || pullResult.includes('Fast-forward')) {
      pulled = 1;
    }

    // Push
    const pushResult = gitSafe(`push origin ${branch}`, { timeout: NETWORK_TIMEOUT });
    if (pushResult === null) {
      pushed = 0; // push failed
    }
  }

  return { pulled, pushed, conflicts };
}

/**
 * Merge origin/<branch> into the local branch with last-writer-wins conflict
 * resolution at FILE granularity:
 *
 *  - Different hunks in the same file → git auto-merges, both kept, silent.
 *  - Same-hunk conflict → the side whose latest commit touching that file is
 *    NEWER (committer time) wins. Tie or unknown → remote wins (deterministic;
 *    matches the companion-box-pulls-the-Mac common case).
 *  - The losing version is NEVER lost: the merge commit keeps both parents.
 *    RECOVERY:  git log --all --full-history -- <file>  → find the losing commit
 *               git show <losingCommit>:<file>          → read the losing content
 *    (--full-history matters: plain `git log -- <file>` simplifies away the
 *    losing parent of a merge.)
 *  - A sync:conflict-resolved event is emitted so the UI can surface
 *    "conflict auto-resolved — the other version is in history".
 *
 * If the merge fails for a NON-conflict reason (unrelated histories, etc.)
 * we abort and fall back to the legacy `pull -X theirs`, logging loudly.
 */
function lwwMerge(branch: string): { merged: boolean; conflicts: number } {
  const remoteRef = `origin/${branch}`;

  if (gitSafe(`fetch origin ${branch}`, { timeout: NETWORK_TIMEOUT }) === null) {
    // Network/transport failure — nothing to merge; push below will fail too.
    log.git.warn('git-sync fetch failed — skipping merge this cycle', { branch });
    return { merged: false, conflicts: 0 };
  }

  const localHead = gitSafe('rev-parse HEAD');
  const remoteHead = gitSafe(`rev-parse ${remoteRef}`);
  if (!localHead || !remoteHead || localHead === remoteHead) {
    return { merged: false, conflicts: 0 };
  }

  // True merge WITHOUT -X: non-overlapping edits auto-merge; overlapping
  // edits leave unmerged paths we resolve per-file below.
  if (gitSafe(`merge --no-edit ${remoteRef}`) !== null) {
    return { merged: true, conflicts: 0 }; // clean auto-merge or fast-forward
  }

  const unmerged = gitSafe('diff --name-only --diff-filter=U');
  const files = (unmerged ?? '').split('\n').map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) {
    // Merge failed but not from content conflicts (unrelated histories,
    // dirty tree, lock…). Fall back to legacy behavior — but LOUDLY: this
    // path silently prefers remote and should be investigated.
    gitSafe('merge --abort');
    log.git.error(
      'git-sync merge failed with a NON-conflict error — falling back to `pull -X theirs` (REMOTE WINS unconditionally). Investigate!',
      { branch, localHead, remoteHead },
    );
    const fallback = gitSafe(`pull -X theirs origin ${branch}`, { timeout: NETWORK_TIMEOUT });
    return { merged: fallback !== null, conflicts: fallback !== null ? 1 : 0 };
  }

  // Per-file LWW: compare the newest commit touching each file on each side.
  const localWins: string[] = [];
  const remoteWins: string[] = [];
  for (const file of files) {
    const localTime = Number(gitSafe(`log -1 --format=%ct HEAD -- "${file}"`) || '0');
    const remoteTime = Number(gitSafe(`log -1 --format=%ct ${remoteRef} -- "${file}"`) || '0');
    const side = localTime > remoteTime ? '--ours' : '--theirs';
    if (gitSafe(`checkout ${side} -- "${file}"`) !== null) {
      gitSafe(`add -- "${file}"`);
    } else {
      // Delete/modify conflict: the winning side deleted the file, so
      // `checkout --ours/--theirs` has no blob to restore — honor the delete.
      // TODO(edge): rename/rename conflicts land here too and resolve as
      // delete; acceptable for a data repo of flat JSON/MD files.
      gitSafe(`rm -f -- "${file}"`);
    }
    (side === '--ours' ? localWins : remoteWins).push(file);
  }

  // Anything still unmerged means resolution failed — don't commit a broken tree.
  const stillUnmerged = gitSafe('diff --name-only --diff-filter=U');
  if (stillUnmerged && stillUnmerged.trim().length > 0) {
    gitSafe('merge --abort');
    log.git.error(
      'git-sync LWW resolution left unmerged paths — aborted merge, falling back to `pull -X theirs` (REMOTE WINS). Investigate!',
      { branch, unresolved: stillUnmerged.split('\n') },
    );
    gitSafe(`pull -X theirs origin ${branch}`, { timeout: NETWORK_TIMEOUT });
    return { merged: true, conflicts: files.length };
  }

  // Commit the merge. Parent 1 = local HEAD, parent 2 = remote head — the
  // losing content of every conflicted file survives under one of them.
  // Message body lists each file + winning side for auditability.
  const detail = [
    ...localWins.map((f) => `local  wins: ${f}`),
    ...remoteWins.map((f) => `remote wins: ${f}`),
  ].join('\n');
  const msgFile = path.join(os.tmpdir(), `walnut-merge-msg-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(
    msgFile,
    `merge: LWW conflict resolution (${files.length} files)\n\n${detail}\n\n`
    + 'Losing versions remain in history: git log --all --full-history -- <file>\n',
    'utf-8',
  );
  let committed: string | null;
  try {
    committed = gitSafe(`commit -F "${msgFile}"`);
  } finally {
    try { fs.unlinkSync(msgFile); } catch { /* best-effort */ }
  }
  if (committed === null) {
    // Never leave the repo mid-merge — abort and retry on the next cycle.
    gitSafe('merge --abort');
    log.git.error('git-sync LWW merge commit failed — merge aborted, will retry next cycle', {
      branch, files,
    });
    return { merged: false, conflicts: files.length };
  }

  // Notify the UI: worst case of a conflict is ONE notification, never a dialog.
  // `winner` is the majority side (per-file detail is in the merge commit);
  // `losingCommit` points at the losing side's head for recovery.
  const winner: 'local' | 'remote' = localWins.length > remoteWins.length ? 'local' : 'remote';
  const losingCommit = winner === 'local' ? remoteHead : localHead;
  log.git.warn('git-sync auto-resolved same-hunk conflict (LWW)', {
    files, winner, losingCommit, localWins, remoteWins,
  });
  bus.emit(EventNames.SYNC_CONFLICT_RESOLVED, { files, winner, losingCommit }, ['web-ui'], {
    source: 'git-sync',
  });

  return { merged: true, conflicts: files.length };
}

export function autoSync(): void {
  try {
    if (!isGitAvailable() || !isRepo() || !hasRemote()) return;
    sync();
  } catch {
    // Never throw from autoSync
  }
}

/**
 * Pull latest data from the open-walnut git repo (best-effort, async).
 * Used by the server to fetch data pushed by remote hooks.
 * Silently does nothing if ~/.open-walnut/ is not a git repo or has no remote.
 */
export async function gitPullWalnut(): Promise<void> {
  try {
    if (!isGitAvailable() || !isRepo() || !hasRemote()) return;
    clearStaleLock();
    const guard = credentialGuardArgs().join(' ');
    execSync(`git ${guard ? `${guard} ` : ''}pull --ff-only`, {
      cwd: WALNUT_HOME,
      timeout: 15000,
      stdio: 'ignore',
    });
  } catch {
    // Best-effort — don't fail callers
  }
}

/**
 * Remove a stale .git/index.lock if it exists and is older than the threshold.
 * The lock file format varies by git version (binary index copy, sometimes with PID).
 * We use pure age-based removal (default 60s) since any normal git op finishes quickly.
 */
export function clearStaleLock(maxAgeMs = 60_000): boolean {
  const lockPath = path.join(WALNUT_HOME, '.git', 'index.lock');
  try {
    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs <= maxAgeMs) return false;

    fs.unlinkSync(lockPath);
    return true;
  } catch {
    // File doesn't exist or can't stat — nothing to do
  }
  return false;
}

/**
 * Check whether an error is a git index.lock contention error.
 * Matches git's specific error: "Unable to create '...index.lock': File exists."
 */
export function isLockContention(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('index.lock') && msg.includes('File exists');
}

/**
 * Commit all dirty changes with an auto-save message.
 * Returns true if a commit was made, false if working tree was clean.
 * Retries once on index.lock contention (common when multiple processes
 * run git ops against the same repo, e.g. orphaned server processes).
 */
export function commitIfDirty(): boolean {
  if (compactionInProgress) return false;
  clearStaleLock();
  const status = gitSafe('status --porcelain');
  if (!status || status.trim().length === 0) return false;

  const lines = status.split('\n').filter((l) => l.trim());
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

  try {
    git('add -A');
  } catch (err) {
    if (!isLockContention(err)) throw err;
    // Lock held by another process — wait briefly and retry once
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    clearStaleLock(5_000);
    git('add -A');
  }

  gitSafe(`commit -m "auto-save ${timestamp} (${lines.length} files)"`);
  return true;
}

/**
 * Ensure ~/.open-walnut/ is a git repo. Initializes if needed.
 * Returns { available: true } if git works, or { available: false, error } if not.
 */
export function ensureRepo(): { available: boolean; error?: string } {
  if (!isGitAvailable()) {
    return { available: false, error: 'git not found in PATH' };
  }
  if (!isRepo()) {
    try {
      initSync();
    } catch (err) {
      return { available: false, error: `git init failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else {
    // Pre-existing repo: self-heal the .gitignore so sensitive files added
    // after the repo was initialized (auth.json) never enter the sync history.
    try { ensureCriticalIgnores(); } catch { /* best-effort */ }
  }
  return { available: true };
}

// ── Cheap last-sync getter for /api/v1/status ──
// Caches the last-commit timestamp for 30s so a polling mobile client never
// pays two execSync calls per status request.
let lastSyncCache: { value: string | null; at: number } | null = null;
const LAST_SYNC_CACHE_MS = 30_000;

/** ISO timestamp of the most recent sync commit, or null if no repo/commits. */
/**
 * Derive cloud-companion credentials from the data repo's `cloud` remote
 * (`https://walnut:<device-token>@<domain>/git/data`, see docs/cloud-sync.md).
 * Zero-config source for the daemon bridge: if cloud sync works, the bridge
 * knows where to dial. Returns null when no cloud remote is configured.
 */
export function getCloudRemoteCredentials(): { domain: string; token: string; secure: boolean } | null {
  const url = gitSafe('remote get-url cloud');
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.password) return null;
    return {
      domain: u.host,
      token: u.password,
      secure: u.protocol === 'https:',
    };
  } catch {
    return null;
  }
}

export function getLastSyncAt(): string | null {
  const now = Date.now();
  if (lastSyncCache && now - lastSyncCache.at < LAST_SYNC_CACHE_MS) {
    return lastSyncCache.value;
  }
  const value = isRepo() ? gitSafe('log -1 --format=%aI') : null;
  lastSyncCache = { value, at: now };
  return value;
}

export function getSyncStatus(): SyncStatus {
  if (!isRepo()) {
    return {
      initialized: false,
      remoteConfigured: false,
      lastSyncAt: null,
      pendingChanges: 0,
      branch: 'main',
    };
  }

  const branch = getBranch();
  const remoteConfigured = hasRemote();

  // Count pending changes
  const status = gitSafe('status --porcelain') ?? '';
  const pendingChanges = status.length > 0
    ? status.split('\n').filter((l) => l.trim().length > 0).length
    : 0;

  // Get last commit date
  let lastSyncAt: string | null = null;
  const lastLog = gitSafe('log -1 --format=%aI');
  if (lastLog) {
    lastSyncAt = lastLog;
  }

  return {
    initialized: true,
    remoteConfigured,
    lastSyncAt,
    pendingChanges,
    branch,
  };
}
