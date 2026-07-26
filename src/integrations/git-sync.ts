import { execSync, exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { bus, EventNames } from '../core/event-bus.js';
import { markCriticalSection } from '../core/event-loop-monitor.js';
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
/** Grace period between SIGTERM and SIGKILL when reaping a git process group. */
const KILL_GRACE_MS = 3_000;

/** Flag set by git-compaction to pause auto-commits during compaction. */
export let compactionInProgress = false;
export function setCompactionInProgress(v: boolean): void {
  compactionInProgress = v;
}

// Network git subcommands that may authenticate against a remote. Only these
// get the credential-helper guard — local ops never touch credentials.
const NETWORK_GIT_RE = /^(?:clone|fetch|pull|push|ls-remote)\b/;

// Declared here (not next to the async git helpers below) because
// credentialGuardArgsAsync() uses it and `const` bindings are not hoisted.
const execAsync = promisify(exec);

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

/**
 * Async twin of credentialGuardArgs — MUST be used by the async tick path.
 * The sync version spawns a child process with execSync, which blocks the whole
 * event loop; gitAsync() called it on every network op, so the "async" sync path
 * still froze all HTTP requests once per fetch/push. Remote URLs effectively never
 * change at runtime, so the answer is cached after the first resolution.
 */
let credentialGuardCache: { cwd: string; args: string[] } | null = null;

/** Drop the cached guard answer — call whenever the remote URL changes. */
export function invalidateCredentialGuardCache(): void {
  credentialGuardCache = null;
}

export async function credentialGuardArgsAsync(cwd?: string): Promise<string[]> {
  const dir = cwd ?? WALNUT_HOME;
  if (credentialGuardCache?.cwd === dir) return credentialGuardCache.args;

  let args: string[] = [];
  try {
    const { stdout } = await execAsync('git config --get-regexp "remote\\..*\\.url"', {
      cwd: dir,
      timeout: LOCAL_TIMEOUT,
      encoding: 'utf-8',
    });
    if (/https?:\/\/[^/\s]+@/.test(stdout)) args = ['-c', 'credential.helper='];
  } catch {
    // No remotes / not a repo — nothing to guard
  }
  credentialGuardCache = { cwd: dir, args };
  return args;
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

// ── Async variants for the periodic tick path ───────────────────────────────
// The 30s auto-commit/sync tick used to run the whole git chain through
// execSync — every `pull`/`push` network round-trip (1-2s) blocked the event
// loop, and ALL HTTP requests stalled behind it. The tick path now uses these
// async variants; the sync `git()`/`gitSafe()` stay for one-shot callers
// (init, compaction, CLI) where blocking is acceptable.

/**
 * Run git in its own process GROUP and kill the whole group on timeout.
 *
 * Why not execAsync's `timeout`: it signals only the top-level `git`, but a
 * network op is a process TREE — `git push` → `git-remote-https` → `send-pack`
 * → `pack-objects`. Killing the parent orphans the children (they reparent to
 * pid 1) and they keep burning CPU and RAM. On a large data repo `pack-objects`
 * alone holds ~1.9GB and runs for minutes, so every timed-out tick leaked one
 * more. Observed 2026-07-25: four concurrent orphaned push trees, load average
 * 211, swap exhausted, every HTTP request timing out at 15s.
 *
 * `detached: true` puts the child in a new process group (pgid == child pid),
 * so `kill(-pgid)` reaps the parent AND every descendant.
 */
async function execGitGroup(
  command: string,
  opts: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (d: string) => { stdout += d; });
    child.stderr?.on('data', (d: string) => { stderr += d; });

    // Escalate SIGTERM → SIGKILL on the GROUP (negative pid). `git` traps TERM
    // and can take a while to unwind a large pack, so don't trust it to exit.
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch { /* already gone */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref?.();
    }, opts.timeout);
    timer.unref?.();

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`git timed out after ${opts.timeout}ms (process group killed): ${command}`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

export async function gitAsync(args: string, options?: { cwd?: string; timeout?: number; env?: Record<string, string> }): Promise<string> {
  // Async guard resolution: the sync credentialGuardArgs() spawns via execSync and
  // would block the event loop on every network op, defeating this whole path.
  const guard = NETWORK_GIT_RE.test(args)
    ? (await credentialGuardArgsAsync(options?.cwd)).join(' ')
    : '';
  const stdout = await execGitGroup(`git ${guard ? `${guard} ` : ''}${args}`, {
    cwd: options?.cwd ?? WALNUT_HOME,
    timeout: options?.timeout ?? LOCAL_TIMEOUT,
    env: options?.env ? { ...process.env, ...options.env } : undefined,
  });
  return stdout.trim();
}

export async function gitSafeAsync(args: string, options?: { cwd?: string; timeout?: number; env?: Record<string, string> }): Promise<string | null> {
  try {
    return await gitAsync(args, options);
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
auth.json.bak

# Machine-local settings — MUST stay out of the sync history. These hold the STT
# engine, SSH hosts and provider credentials, which differ per box. Keep in sync
# with CRITICAL_IGNORES; a fresh install missing these is how a remote deletion
# reached ~/.open-walnut/config.yaml twice (2026-07-25 / 07-26).
config.yaml
config.yaml.bak

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
 * .gitignore predates them.
 *
 *  - auth.json (+ its backup) — device-token hashes; each box pairs its own
 *    devices. Losing it presents as a blanket 401 on every token.
 *  - config.yaml (+ its backup) — MACHINE-LOCAL settings: the STT engine, SSH
 *    hosts, provider credentials, per-device model lists. Never synced.
 *
 * These are also actively untracked (see ensureMachineLocalUntracked): being
 * gitignored on THIS box while still tracked in the index is the dangerous
 * state — see that function for the incident this prevents.
 */
const CRITICAL_IGNORES = ['auth.json', 'auth.json.bak', 'config.yaml', 'config.yaml.bak'];

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
    + '\n# Machine-local / sensitive — never synced\n'
    + missing.join('\n') + '\n';
  fs.writeFileSync(gitignorePath, content + suffix, 'utf-8');
}

/**
 * Drop machine-local files from the INDEX while keeping them on disk.
 *
 * Being gitignored locally is NOT enough: .gitignore only stops git from
 * *adding* an untracked file. A file that is already tracked stays tracked, and
 * then a merge/pull that carries someone else's deletion of it DELETES THE
 * LOCAL FILE — .gitignore does not protect a tracked path.
 *
 * That is exactly how voice input broke (2026-07-25): config.yaml was
 * gitignored + untracked on one box, but still tracked here, so a merge from
 * origin applied the deletion and wiped ~/.open-walnut/config.yaml. The app
 * then rebuilt a minimal config from defaults, silently dropping `stt:` (plus
 * hosts/tools/plugins) — the mic went grey with "No STT engine configured".
 *
 * `rm --cached` stages the removal without touching the working tree, so after
 * this runs the path is untracked AND ignored, and no future merge can reach
 * the file on disk. Idempotent: no-ops once nothing ignored is still tracked.
 */
export function ensureMachineLocalUntracked(): string[] {
  // `ls-files -i -c --exclude-standard` = tracked paths that .gitignore says
  // should be ignored. Cheap (~20ms on a 3.7k-file repo).
  const tracked = gitSafe('ls-files -i -c --exclude-standard');
  if (!tracked) return [];
  const stillTracked = tracked
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => CRITICAL_IGNORES.includes(path.basename(f)) && CRITICAL_IGNORES.includes(f));
  if (stillTracked.length === 0) return [];

  const untracked: string[] = [];
  for (const file of stillTracked) {
    // --cached: index only. The file on disk is the user's live config.
    if (gitSafe(`rm --cached --quiet -- "${file}"`) !== null) untracked.push(file);
  }
  if (untracked.length > 0) {
    log.git.warn(
      'git-sync untracked machine-local files that were still in the index — a remote deletion could have wiped them from disk',
      { files: untracked },
    );
  }
  return untracked;
}

/**
 * Async twin of ensureMachineLocalUntracked, for the sync tick.
 *
 * ensureRepo() runs this once at boot, but a merge happens every 30s and the
 * dangerous state can appear at runtime: any `add -A` after a critical file is
 * (re-)created while .gitignore hasn't caught up re-tracks it, and then the
 * NEXT pull can carry a remote deletion straight to disk. Re-checking right
 * before every pull closes that window instead of waiting for a restart.
 *
 * Must be async: the sync tick runs on the event loop and gitSafe's execSync
 * blocks every HTTP request for the duration (the bug fixed in 2928b29).
 */
async function ensureMachineLocalUntrackedAsync(): Promise<string[]> {
  // `ls-files -i` only reports paths the CURRENT .gitignore ignores, so the
  // ignore rules must exist before the query — otherwise a repo whose
  // .gitignore predates CRITICAL_IGNORES reports nothing and the guard no-ops.
  try { ensureCriticalIgnores(); } catch { /* best-effort */ }
  const tracked = await gitSafeAsync('ls-files -i -c --exclude-standard');
  if (!tracked) return [];
  const stillTracked = tracked
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => CRITICAL_IGNORES.includes(f));
  if (stillTracked.length === 0) return [];

  const untracked: string[] = [];
  for (const file of stillTracked) {
    if (await gitSafeAsync(`rm --cached --quiet -- "${file}"`) !== null) untracked.push(file);
  }
  if (untracked.length > 0) {
    log.git.error(
      'git-sync found a machine-local file re-entering the index AT RUNTIME — untracked it before pulling. A remote deletion would have wiped it from disk (2026-07-25/26 incident).',
      { files: untracked },
    );
  }
  return untracked;
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
  // The async guard caches per-cwd; changing the remote is the one thing that
  // invalidates it (e.g. swapping a credentialed HTTPS URL for SSH).
  invalidateCredentialGuardCache();
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

/**
 * Single-flight latch for sync(). The 30s tick used to rely on setTimeout
 * self-rescheduling for serialization ("the next tick is armed only AFTER the
 * current one finishes"), but that guarantee died with the timeout leak above:
 * on timeout the tick RESOLVED and armed the next one while the orphaned git
 * tree kept packing in the background. Every 60s stacked another layer.
 *
 * The latch makes overlap impossible even if a caller ignores the tick: a
 * concurrent call joins the in-flight sync instead of starting a second one.
 */
let syncInflight: Promise<{ pulled: number; pushed: number; conflicts: number }> | null = null;

export async function sync(): Promise<{ pulled: number; pushed: number; conflicts: number }> {
  if (syncInflight) {
    log.git.debug('git-sync already in flight — joining instead of stacking');
    return syncInflight;
  }
  syncInflight = syncInner().finally(() => { syncInflight = null; });
  return syncInflight;
}

async function syncInner(): Promise<{ pulled: number; pushed: number; conflicts: number }> {
  let pulled = 0;
  let pushed = 0;
  let conflicts = 0;

  // Commit everything BEFORE pulling/merging so no local edit is ever
  // unrecorded — even if it loses an LWW conflict it stays in history.
  await gitAsync('add -A');

  // …but never let `add -A` leave a machine-local file tracked: the pull below
  // would then be able to apply a remote deletion of it straight to disk.
  // Runs after add, before pull — the only point where the check matters.
  await ensureMachineLocalUntrackedAsync();

  // Check for staged changes
  const diff = await gitSafeAsync('diff --cached --stat');
  if (diff && diff.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await gitSafeAsync(`commit -m "open-walnut sync ${timestamp}"`);
    pushed = 1;
  }

  // Pull if remote is configured. Clean case: rebase (keeps history linear).
  // Conflict case: abort the rebase and do a TRUE MERGE with per-file LWW
  // resolution — a merge commit preserves BOTH parents, so the losing side
  // of every conflict remains recoverable from git history (rebase would
  // rewrite the local commits and destroy that guarantee).
  if (hasRemote()) {
    const branch = getBranch();
    const pullResult = await gitSafeAsync(`pull --rebase origin ${branch}`, { timeout: NETWORK_TIMEOUT });
    if (pullResult === null) {
      // Rebase failed — could be a content conflict or a network error.
      // Abort any half-applied rebase (no-op if none), then take the merge path.
      await gitSafeAsync('rebase --abort');
      const merge = await lwwMerge(branch);
      conflicts = merge.conflicts;
      if (merge.merged) pulled = 1;
    } else if (pullResult.includes('Updating') || pullResult.includes('Fast-forward')) {
      pulled = 1;
    }

    // Push
    const pushResult = await gitSafeAsync(`push origin ${branch}`, { timeout: NETWORK_TIMEOUT });
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
async function lwwMerge(branch: string): Promise<{ merged: boolean; conflicts: number }> {
  const remoteRef = `origin/${branch}`;

  // Clear stale locks BEFORE fetching: a crashed git can leave a ref lock that
  // makes every future fetch fail. Previously only commitIfDirty() did this and
  // only for index.lock, so a stale refs/remotes/origin/<branch>.lock wedged sync
  // permanently — it never self-healed and the warning below repeated forever.
  clearStaleLock();

  let fetchError: unknown = null;
  try {
    await gitAsync(`fetch origin ${branch}`, { timeout: NETWORK_TIMEOUT });
  } catch (err) {
    fetchError = err;
  }

  if (fetchError) {
    // Distinguish lock contention from a real network failure: gitSafeAsync used
    // to swallow the error entirely, so a self-healable lock looked identical to
    // an unreachable remote. On lock contention, force-clear and retry once.
    if (isLockContention(fetchError)) {
      clearStaleLock(0);
      try {
        await gitAsync(`fetch origin ${branch}`, { timeout: NETWORK_TIMEOUT });
        fetchError = null;
        log.git.warn('git-sync fetch recovered after clearing a stale lock', { branch });
      } catch (retryErr) {
        fetchError = retryErr;
      }
    }

    if (fetchError) {
      const detail = fetchError instanceof Error ? fetchError.message : String(fetchError);
      log.git.warn('git-sync fetch failed — skipping merge this cycle', {
        branch,
        // Surface WHY. 246 consecutive failures were logged without ever naming
        // the cause, which is why a 2.5-day-old lock went unnoticed.
        error: detail.slice(0, 400),
        lockContention: isLockContention(fetchError),
      });
      return { merged: false, conflicts: 0 };
    }
  }

  const localHead = await gitSafeAsync('rev-parse HEAD');
  const remoteHead = await gitSafeAsync(`rev-parse ${remoteRef}`);
  if (!localHead || !remoteHead || localHead === remoteHead) {
    return { merged: false, conflicts: 0 };
  }

  // True merge WITHOUT -X: non-overlapping edits auto-merge; overlapping
  // edits leave unmerged paths we resolve per-file below.
  if (await gitSafeAsync(`merge --no-edit ${remoteRef}`) !== null) {
    return { merged: true, conflicts: 0 }; // clean auto-merge or fast-forward
  }

  const unmerged = await gitSafeAsync('diff --name-only --diff-filter=U');
  const files = (unmerged ?? '').split('\n').map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) {
    // Merge failed but not from content conflicts (unrelated histories,
    // dirty tree, lock…). Fall back to legacy behavior — but LOUDLY: this
    // path silently prefers remote and should be investigated.
    await gitSafeAsync('merge --abort');
    log.git.error(
      'git-sync merge failed with a NON-conflict error — falling back to `pull -X theirs` (REMOTE WINS unconditionally). Investigate!',
      { branch, localHead, remoteHead },
    );
    const fallback = await gitSafeAsync(`pull -X theirs origin ${branch}`, { timeout: NETWORK_TIMEOUT });
    return { merged: fallback !== null, conflicts: fallback !== null ? 1 : 0 };
  }

  // Per-file LWW: compare the newest commit touching each file on each side.
  const localWins: string[] = [];
  const remoteWins: string[] = [];
  for (const file of files) {
    const localTime = Number(await gitSafeAsync(`log -1 --format=%ct HEAD -- "${file}"`) || '0');
    const remoteTime = Number(await gitSafeAsync(`log -1 --format=%ct ${remoteRef} -- "${file}"`) || '0');
    const side = localTime > remoteTime ? '--ours' : '--theirs';
    if (await gitSafeAsync(`checkout ${side} -- "${file}"`) !== null) {
      await gitSafeAsync(`add -- "${file}"`);
    } else {
      // Delete/modify conflict: the winning side deleted the file, so
      // `checkout --ours/--theirs` has no blob to restore — honor the delete.
      // TODO(edge): rename/rename conflicts land here too and resolve as
      // delete; acceptable for a data repo of flat JSON/MD files.
      await gitSafeAsync(`rm -f -- "${file}"`);
    }
    (side === '--ours' ? localWins : remoteWins).push(file);
  }

  // Anything still unmerged means resolution failed — don't commit a broken tree.
  const stillUnmerged = await gitSafeAsync('diff --name-only --diff-filter=U');
  if (stillUnmerged && stillUnmerged.trim().length > 0) {
    await gitSafeAsync('merge --abort');
    log.git.error(
      'git-sync LWW resolution left unmerged paths — aborted merge, falling back to `pull -X theirs` (REMOTE WINS). Investigate!',
      { branch, unresolved: stillUnmerged.split('\n') },
    );
    await gitSafeAsync(`pull -X theirs origin ${branch}`, { timeout: NETWORK_TIMEOUT });
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
    committed = await gitSafeAsync(`commit -F "${msgFile}"`);
  } finally {
    try { fs.unlinkSync(msgFile); } catch { /* best-effort */ }
  }
  if (committed === null) {
    // Never leave the repo mid-merge — abort and retry on the next cycle.
    await gitSafeAsync('merge --abort');
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

export async function autoSync(): Promise<void> {
  try {
    if (!isGitAvailable() || !isRepo() || !hasRemote()) return;
    await sync();
  } catch {
    // Never throw from autoSync
  }
}

/**
 * Pull latest data from the open-walnut git repo (best-effort, async).
 * Used by the server to fetch data pushed by remote hooks.
 * Silently does nothing if ~/.open-walnut/ is not a git repo or has no remote.
 *
 * Single-flight: session:result and session:error can fire together (multiple
 * sessions finishing at once) — concurrent callers share ONE in-flight pull
 * instead of racing two `git pull` processes into .git/index.lock contention.
 */
let pullInflight: Promise<void> | null = null;

export async function gitPullWalnut(): Promise<void> {
  if (pullInflight) return pullInflight;
  pullInflight = (async () => {
    const endSection = markCriticalSection('git-pull-walnut');
    try {
      if (!isGitAvailable() || !isRepo() || !hasRemote()) return;
      clearStaleLock();
      // gitSafeAsync applies the credential-helper guard itself (pull is a
      // network subcommand) and swallows errors — same best-effort semantics
      // as the old execSync version, minus the event-loop block.
      await gitSafeAsync('pull --ff-only', { timeout: NETWORK_TIMEOUT });
    } catch {
      // Best-effort — don't fail callers
    } finally {
      endSection();
    }
  })();
  try {
    await pullInflight;
  } finally {
    pullInflight = null;
  }
}

/**
 * Remove stale git lock files older than the threshold.
 * The lock file format varies by git version (binary index copy, sometimes with PID).
 * We use pure age-based removal (default 60s) since any normal git op finishes quickly.
 *
 * Covers BOTH lock families — a crashed git leaves either behind:
 *   - .git/index.lock             → blocks `add`/`commit`
 *   - .git/refs/**\/<name>.lock   → blocks `fetch`/`pull` ref updates
 * Only index.lock used to be cleaned, so a stale ref lock survived indefinitely:
 * one sat in refs/remotes/origin/main.lock for 2.5 days and failed every 30s sync
 * tick (246 failures), each retry re-running the blocking git chain.
 */
export function clearStaleLock(maxAgeMs = 60_000): boolean {
  const gitDir = path.join(WALNUT_HOME, '.git');
  let removed = false;

  const removeIfStale = (lockPath: string): void => {
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs <= maxAgeMs) return;
      fs.unlinkSync(lockPath);
      removed = true;
      log.git.warn('git-sync removed stale lock', { lock: path.relative(gitDir, lockPath) });
    } catch {
      // Missing / unreadable / already gone — nothing to do
    }
  };

  removeIfStale(path.join(gitDir, 'index.lock'));

  // Walk .git/refs for *.lock. Depth-bounded and tiny in practice (a handful of
  // refs), so this stays cheap enough for the 30s tick.
  const walkRefs = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkRefs(full, depth + 1);
      else if (entry.name.endsWith('.lock')) removeIfStale(full);
    }
  };
  walkRefs(path.join(gitDir, 'refs'), 0);

  return removed;
}

/**
 * Check whether an error is a git lock contention error.
 * Matches both lock families git can block on:
 *   - "Unable to create '...index.lock': File exists."          (add/commit)
 *   - "cannot lock ref 'refs/...': Unable to create '....lock'" (fetch/pull)
 * Matching only index.lock made every ref-lock failure look like a network error,
 * so the self-heal retry never fired.
 */
export function isLockContention(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes('.lock')) return false;
  return msg.includes('File exists') || msg.includes('cannot lock ref');
}

// ── Repo-size sentinel ───────────────────────────────────────────────────────
// Last line of defense for the 2026-07-25 starvation incident: every layer
// above (derived-file gitignores, history compaction, timeout reaping) can
// fail independently, and compaction in particular failed SILENTLY for months
// (ENOBUFS) while .git grew to 15GB. Whatever breaks next, this check makes
// sure a ballooning data repo surfaces as a warning long before it can take
// the machine down. Checked from the sync tick, at most once per interval.

/** Warn when the data repo's .git exceeds this many bytes (3GB). */
const REPO_SIZE_WARN_BYTES = 3 * 1024 * 1024 * 1024;
const REPO_SIZE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

let lastRepoSizeCheck = 0;

/** du -sk equivalent for .git via pack files only — packs dominate (>95%) and
 * enumerating just objects/pack avoids walking hundreds of loose-object dirs. */
function measureGitDirBytes(repoDir: string): number {
  let total = 0;
  const addDir = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        total += fs.statSync(path.join(dir, e.name)).size;
      } catch { /* raced with gc — skip */ }
    }
  };
  addDir(path.join(repoDir, '.git', 'objects', 'pack'));
  return total;
}

/**
 * Periodic sentinel: returns a human-readable warning when the data repo has
 * grown past the threshold, null otherwise. Self-throttles to one real check
 * per REPO_SIZE_CHECK_INTERVAL_MS; callers can invoke it every tick.
 */
export function checkRepoSize(repoDir = WALNUT_HOME): string | null {
  const now = Date.now();
  if (now - lastRepoSizeCheck < REPO_SIZE_CHECK_INTERVAL_MS) return null;
  lastRepoSizeCheck = now;

  const bytes = measureGitDirBytes(repoDir);
  if (bytes < REPO_SIZE_WARN_BYTES) return null;

  const gb = (bytes / 1024 / 1024 / 1024).toFixed(1);
  return `data repo .git has grown to ${gb}GB (threshold 3GB) — compaction may be failing; check open-walnut logs -s git`;
}

/** Test hook: reset the sentinel's throttle window. */
export function resetRepoSizeCheckForTest(): void {
  lastRepoSizeCheck = 0;
}

/**
 * Commit all dirty changes with an auto-save message.
 * Returns true if a commit was made, false if working tree was clean.
 * Retries once on index.lock contention (common when multiple processes
 * run git ops against the same repo, e.g. orphaned server processes).
 */
export async function commitIfDirty(): Promise<boolean> {
  if (compactionInProgress) return false;
  clearStaleLock();
  const status = await gitSafeAsync('status --porcelain');
  if (!status || status.trim().length === 0) return false;

  const lines = status.split('\n').filter((l) => l.trim());
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

  try {
    await gitAsync('add -A');
  } catch (err) {
    if (!isLockContention(err)) throw err;
    // Lock held by another process — wait briefly (async, loop keeps running) and retry once
    await new Promise((r) => setTimeout(r, 300));
    clearStaleLock(5_000);
    await gitAsync('add -A');
  }

  await gitSafeAsync(`commit -m "auto-save ${timestamp} (${lines.length} files)"`);
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
    // Pre-existing repo: self-heal the .gitignore so sensitive/machine-local
    // files added after the repo was initialized never enter the sync history…
    try { ensureCriticalIgnores(); } catch { /* best-effort */ }
    // …and drop any that are STILL tracked. Ignoring a tracked path does not
    // protect it: a merge carrying its deletion removes the local file.
    try { ensureMachineLocalUntracked(); } catch { /* best-effort */ }
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
 * Derive cloud-companion credentials from the data repo's cloud remote
 * (`https://walnut:<device-token>@<domain>/git/data`, see docs/reference/cloud-sync.md).
 * Zero-config source for the daemon bridge: if cloud sync works, the bridge
 * knows where to dial. Returns null when no cloud remote is configured.
 *
 * Remote name: setups that predate two-way auto-sync call it `cloud`; newer
 * ones renamed it `origin`. Try both, but only accept a URL that looks like
 * the companion's git endpoint (credentialed + /git/ path) — a plain GitHub
 * origin must never be mistaken for a bridge target.
 */
export function getCloudRemoteCredentials(): { domain: string; token: string; secure: boolean } | null {
  for (const remote of ['cloud', 'origin']) {
    const url = gitSafe(`remote get-url ${remote}`);
    if (!url) continue;
    try {
      const u = new URL(url);
      if (!u.password || !u.pathname.startsWith('/git/')) continue;
      return {
        domain: u.host,
        token: u.password,
        secure: u.protocol === 'https:',
      };
    } catch {
      continue;
    }
  }
  return null;
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
