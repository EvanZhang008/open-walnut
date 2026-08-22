import { execSync, exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { bus, EventNames } from '../core/event-bus.js';
import { markCriticalSection } from '../core/event-loop-monitor.js';
import { safeKillProcessGroup } from '../core/process-group-kill.js';
import { log } from '../logging/index.js';

export interface SyncStatus {
  initialized: boolean;
  remoteConfigured: boolean;
  lastSyncAt: string | null;
  pendingChanges: number;
  branch: string;
  /** True while the mass-revert guard holds sync in pull-only safe mode. */
  safeMode: boolean;
  /** True while the disk watermark holds sync in pull-only mode (disk ≥90%). */
  diskPullOnly: boolean;
}

const LOCAL_TIMEOUT = 30_000;
/** Fetch/push/ls-remote — pure network transfers, fail fast. */
const NETWORK_TIMEOUT = 15_000;
/**
 * Pull = fetch + CHECKOUT. On a fat data repo a checkout can easily exceed 15s
 * (especially on a CPU-starved box), and execGitGroup kills the whole process
 * group on timeout — which is how the 2026-08-03 hub ended up with a TORN
 * worktree: HEAD moved to the new tip but the checkout died halfway, leaving
 * 2000+ files stale on disk. The next `add -A` then snapshotted that stale
 * tree as a mass revert. Give checkout-bearing ops room to finish.
 */
export const PULL_TIMEOUT = 60_000;
/** Exported for tests pinning the fetch/pull timeout split. */
export const FETCH_TIMEOUT = NETWORK_TIMEOUT;
/** Grace period between SIGTERM and SIGKILL when reaping a git process group. */
const KILL_GRACE_MS = 3_000;

/**
 * Flag set while history compaction runs, to pause auto-commits AND sync.
 *
 * ⚠️ Process-boundary trap (root cause of the 2026-08 cloud incident): the
 * compaction worker is a FORKED child (dist/workers/git-compaction-worker.js),
 * so runScheduledCompaction() setting this flag inside the worker pauses
 * nothing in the server. The PARENT must set it around the fork (server.ts
 * does). When only the worker set it, the 30s tick kept committing while the
 * worker rebuilt history, `main` moved between collection and verify, and
 * every compaction run for 9 days failed "verification failed: trees differ" —
 * the data repo regrew to 25k commits/6.5GB and its pushes wedged the cloud box.
 */
export let compactionInProgress = false;
export function setCompactionInProgress(v: boolean): void {
  compactionInProgress = v;
}

/**
 * Resolves when no sync() is in flight. The parent calls this before forking
 * the compaction worker so a mid-flight pull/push can't interleave with the
 * history rewrite (the flag only stops NEW ticks, not one already running).
 */
export async function waitForSyncSettled(): Promise<void> {
  try { await syncInflight; } catch { /* a failed sync is still settled */ }
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
 *
 * Exported for git-maintenance.ts, which runs long gc/repack children under
 * the same group-kill discipline.
 */
export async function execGitGroup(
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
      safeKillProcessGroup(child.pid, signal);
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
# Ephemeral working area — daemon stream files (multi-MB, constantly appended).
# Syncing them would be the 15 GB data-repo starvation incident all over again.
tmp/

# SQLite (binary, self-managed)
*.sqlite
*.sqlite-shm
*.sqlite-wal

# Auth tokens (sensitive)
sync/ms-todo-tokens.json
auth.json
auth.json.bak
# Cloud-provisioning job state — holds the pairing code (a live setup token)
# until the new instance claims itself. Never syncs, never reaches a remote.
cloud-setup-job.json

# Machine-local settings — MUST stay out of the sync history. These hold the STT
# engine, SSH hosts and provider credentials, which differ per box. Keep in sync
# with CRITICAL_IGNORES; a fresh install missing these is how a remote deletion
# reached ~/.open-walnut/config.yaml twice (2026-07-25 / 07-26).
#
# EXACT FILENAMES on purpose — do NOT broaden to config* or config/. Its sibling
# config/share/ (ui-prefs.json, stt-vocab.txt) is the SYNCED half of the config:
# cross-device user preferences that are supposed to be tracked. A wider pattern
# here would silently make them device-local again.
config.yaml
config.yaml.bak

# Sync state (ephemeral)
sync/ms-todo-delta.json
sync/*.json

# Task backups (redundant with git)
tasks/*.backup*
tasks/*.bak*
tasks/archive/

# Bounded-memory pre-write snapshots (bounded-memory-backup.ts) — machine-local
# rollback artifacts. Recovery always happens on the box that took the damage,
# and syncing them would multiply memory write churn into the history.
memory/**/*.bak.*

# Runtime ephemeral
session-message-queue.json
# Cron RUNTIME state (nextRunAtMs etc.) is machine-local — syncing it echoes a
# stale due time back from the other box and re-fires jobs (2026-08-04 storm).
# Job DEFINITIONS (cron-jobs.json) still sync.
cron-state.json
*.lock/
*.lock

# Logs + OS
*.log
hook-errors.log
.DS_Store
node_modules/

# ── Crash residue, dead stores, machine-local runtime state ─────────────────
# Every rule below was found TRACKED in a real data repo and removed in the
# 2026-08-09 cleanup. They existed ONLY in that box's hand-edited .gitignore, so
# a FRESH install re-leaked all of it — hence this block. Note the anchoring: a
# leading / means root-level only, and each one below that has it needs it.

# Atomic-write temp files. writeJsonFile() writes .open-walnut-<hex>.tmp beside
# the target then renames; a crash mid-write orphans the .tmp. NOT anchored —
# orphans appear in every dir that holds a JSON store. Nine were tracked, and one
# was a stale copy of sync/ms-todo-tokens.json with a live MS Graph accessToken.
# (src/core/tmp-sweep.ts deletes the stale ones on boot; this keeps them out of
# the index in the window before that runs.)
.open-walnut-*.tmp

# Dead pre-SQLite stores (0-byte sessions.db / tasks.db leftovers). ROOT-LEVEL
# ONLY: memory/history.db is live chat data and must stay tracked — a blanket
# *.db would silence it.
/*.db

# One-shot migration output (e.g. chat-history.json.migrated, 1.8MB).
*.migrated

# Ad-hoc backup snapshots — git history already IS the backup.
*.backup.json
# ROOT-LEVEL only: notes/ may legitimately contain a note whose name has .bak.
/*.bak.*

# Local disk caches — cache/history (rebuilt from session JSONLs on demand)
# and cache/projections + cache/transcripts (the projection cache: written by
# the exporters on the primary, bridge-pushed to the cloud; see
# src/core/projection-cache.ts). Machine-local by definition — the bridge is
# their transport, never git.
cache/

# Obsidian semantic index — chunks plus a ~71MB embeddings blob, both regenerable
# from notes/. Binary, so git stores a FULL copy per change (no delta).
.walnut-obsidian-search/

# Plugin-store clones. The source of truth is config.yaml plugin_sources, and
# these are nested git repos — never tracked by the data repo.
plugin-stores/

# Voice recordings + transcripts (machine-local binary). Pre-1a location; new
# writes go to tmp/stt-recordings/, but old installs still have this dir.
stt-debug/

# Audio capture. Both moved under tmp/ in phase 1a; kept here for older installs.
recordings/
recording-state.json

# Server singleton lock — holds THIS machine's pid/port; syncing it makes the
# other box think a dead pid owns the repo.
/server.lock.json

# History-compaction watermark — a per-machine progress marker.
/.last-compaction

# UI state (open panels, widths, last-viewed ids). Rewritten constantly; was
# worth ~45 commits/day on its own. ROOT-ANCHORED: the live copy moved to
# config/share/ui-prefs.json, which IS synced (cross-device layout), and this
# rule must not follow it there — it only silences the pre-2026-08 root file that
# older installs still have until the migration moves it.
/ui-prefs.json

# Prebuilt dtach binary (pre-1a location; now tmp/bin/). A platform-specific
# compiled artifact — rebuildable, and wrong for any other architecture.
/bin/

# Obsidian "new file" scratch names left at the vault root by an accidental
# Cmd-N. ROOT-LEVEL only — a real note deeper in notes/ must be unaffected
# (notes/_attachment/Untitled 1.png is genuine user data).
/Untitled*
/Pasted image *
/未命名*

# Obsidian's own state. .obsidian/ holds PLUGIN CONFIG, which in a real vault
# contained S3 credentials; .smart-env is the Smart Connections embeddings store
# (large, binary, regenerable). Neither is user content — notes/ is.
.obsidian/
.smart-env
secrets/

# Dead pre-SQLite session store. sessions.sqlite is the source of truth (ignored
# above). session-db-migration.ts still reads sessions.json and writes
# sessions.json.migrated-from-json.backup next to it, so a fresh install CAN
# recreate both. Its history was once 906GB across 112,725 versions.
sessions.json
sessions.json.*

# Ad-hoc backup snapshots at the WALNUT_HOME root (config.yaml.backup-<ts>,
# config.yaml.backup-preheal-<ts>, …) — git history already IS the backup.
# ROOT-ANCHORED on purpose: the hand-written rules these mirror were bare
# *.bak / *.backup, which would also silence any note in notes/ whose filename
# happens to contain .bak.
/*.bak
/*.bak-*
/*.backup
/*.backup-*
`;

/**
 * Ignore entries that MUST be present even in pre-existing repos whose
 * .gitignore predates them.
 *
 *  - auth.json (+ its backup) — device-token hashes; each box pairs its own
 *    devices. Losing it presents as a blanket 401 on every token.
 *  - config.yaml (+ its backup) — MACHINE-LOCAL settings: the STT engine, SSH
 *    hosts, provider credentials, per-device model lists. Never synced.
 *  - cron-state.json — per-machine cron RUNTIME state (nextRunAtMs etc.).
 *    Syncing it echoes a stale due time back from the other box and re-fires
 *    jobs (2026-08-04 storm). Pre-existing repos' .gitignore predates this
 *    file, so it needs both the append and the untrack self-heal.
 *  - cloud-setup-job.json — in-flight cloud provisioning state, including the
 *    pairing code that doubles as the new instance's setup token. A live secret
 *    must never reach the sync history.
 *
 * These are also actively untracked (see ensureMachineLocalUntracked): being
 * gitignored on THIS box while still tracked in the index is the dangerous
 * state — see that function for the incident this prevents.
 */
const CRITICAL_IGNORES = ['auth.json', 'auth.json.bak', 'cloud-setup-job.json', 'config.yaml', 'config.yaml.bak', 'cron-state.json'];

/**
 * Ignore-only patterns: kept out of the .gitignore drift, but NOT fed to the
 * untrack pass, which matches exact paths and cannot resolve a glob.
 *
 * `memory/**\/*.bak.*` — bounded-memory pre-write snapshots. Purely local
 * rollback artifacts, rewritten on every memory mutation; they have never been
 * tracked, so there is no index state to repair, only churn to keep out.
 */
const EXTRA_IGNORE_PATTERNS = ['memory/**/*.bak.*', 'tmp/'];

/**
 * Append missing CRITICAL_IGNORES / EXTRA_IGNORE_PATTERNS to an existing
 * .gitignore (idempotent). Called from ensureRepo() so every boot self-heals
 * older installations.
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
  const missing = [...CRITICAL_IGNORES, ...EXTRA_IGNORE_PATTERNS].filter((entry) => !lines.has(entry));
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

function ensureGitIdentity(): void {
  // The data repo auto-commits without user interaction. Fresh CI runners and
  // minimal self-hosted installs often have no global Git identity, which used
  // to make initial commits and later auto-saves silently fail.
  // Preserve an existing user identity; provide a repo-local fallback only
  // when Git cannot resolve one.
  if (!gitSafe('config user.name')) git('config user.name "Open Walnut"');
  if (!gitSafe('config user.email')) git('config user.email "open-walnut@localhost"');
}

export function initSync(remoteUrl?: string): void {
  if (!isRepo()) {
    git('init');
    git('checkout -b main');
  }

  ensureGitIdentity();

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

// ── Mass-revert circuit breaker + pull-only safe mode ───────────────────────
// Root cause guard for the 2026-08-03 data-repo incident: the hub box's
// fetch/pull timed out for ~8h (its worktree froze on an old tree), then a
// pull finally moved HEAD but the checkout was killed mid-way (15s timeout,
// process group reaped) — leaving a TORN worktree: HEAD at the new tip, disk
// still holding the old tree. The next `commitIfDirty` ran `add -A` BEFORE any
// pull and committed the entire stale tree (2233 renames reverted + deleted
// files resurrected) as one commit, silently undoing 8h of the user's work,
// with a commit message claiming "(1 files)". The guards below attack each
// link of that chain.

/**
 * Dirty-file count above which a snapshot is suspicious and gets vetted.
 * This is the FLOOR only — the live threshold is effectiveMassDirtyThreshold(),
 * which scales with repo size (a flat 300 is ~1% of a 30k-file repo, i.e. a
 * legitimate bulk edit trips it, while on a 200-file repo 300 can never trip).
 * Still exported: callers/tests pin the floor, and it is the documented minimum.
 */
export const MASS_DIRTY_THRESHOLD = 300;
/** Share of the tracked file count that also counts as a "mass" dirty set. */
const MASS_DIRTY_TRACKED_FRACTION = 0.05;
/** How long one `git ls-files` count is reused before recounting. */
const TRACKED_COUNT_TTL_MS = 10 * 60_000;
let trackedCountCache: { count: number; at: number } | null = null;

/**
 * Tracked-file count, cached for TRACKED_COUNT_TTL_MS. `git ls-files` on a
 * 30k-file repo is cheap but not free, and this is consulted from every tick
 * (twice: commitIfDirty + syncInner). On failure the last known count is reused
 * rather than collapsing to 0 — a transient git error must not silently lower
 * the breaker's sensitivity floor.
 */
async function trackedFileCount(): Promise<number> {
  const now = Date.now();
  if (trackedCountCache && now - trackedCountCache.at < TRACKED_COUNT_TTL_MS) {
    return trackedCountCache.count;
  }
  const out = await gitSafeAsync('ls-files');
  if (out === null) return trackedCountCache?.count ?? 0;
  const count = out.split('\n').filter((l) => l.trim().length > 0).length;
  trackedCountCache = { count, at: now };
  return count;
}

/**
 * Live mass-dirty threshold: max(MASS_DIRTY_THRESHOLD, 5% of tracked files).
 * Scales the circuit breaker with the repo so it keeps meaning "a suspiciously
 * large share of the repo changed at once" instead of a fixed file count.
 */
export async function effectiveMassDirtyThreshold(): Promise<number> {
  const tracked = await trackedFileCount();
  return Math.max(MASS_DIRTY_THRESHOLD, Math.ceil(tracked * MASS_DIRTY_TRACKED_FRACTION));
}

/** Test hook: drop the cached tracked-file count. */
export function resetTrackedCountCacheForTest(): void {
  trackedCountCache = null;
}

/** Consecutive fetch/pull failures after which the worktree is presumed stale. */
export const FAILURE_STREAK_FOR_PULL_FIRST = 3;
/**
 * Untracked dirty files that upstream's recent history deleted/renamed away —
 * at or above this count a huge dirty set is treated as a mass resurrection.
 */
export const RESURRECTION_TRIP_COUNT = 25;
/** How many recent commits to scan for deleted paths in the resurrection check. */
const RESURRECTION_LOG_DEPTH = 50;

interface SyncGuardState {
  safeMode: boolean;
  safeModeReason: string | null;
  safeModeSince: string | null;
  consecutiveNetworkFailures: number;
}

const guard: SyncGuardState = {
  safeMode: false,
  safeModeReason: null,
  safeModeSince: null,
  consecutiveNetworkFailures: 0,
};

/** Re-log the ongoing safe-mode refusal at most this often (first hit is always loud). */
const SAFE_MODE_RELOG_MS = 10 * 60_000;
let lastSafeModeRefusalLog = 0;

/** Read-only view of the guard, for status endpoints and tests. */
export function getSyncGuardState(): Readonly<SyncGuardState> {
  return { ...guard };
}

/**
 * Human-visible escape hatch: stand down from pull-only safe mode. Called
 * automatically when the anomaly disappears (dirty set shrinks/clears), or
 * manually after a human has repaired the worktree.
 */
export function clearSyncSafeMode(reason = 'manual'): void {
  if (!guard.safeMode) return;
  log.git.warn('git-sync leaving pull-only safe mode — auto-commits resume', {
    reason,
    enteredFor: guard.safeModeReason,
    since: guard.safeModeSince,
  });
  guard.safeMode = false;
  guard.safeModeReason = null;
  guard.safeModeSince = null;
}

function enterSafeMode(reason: string, detail: Record<string, unknown>): void {
  const firstEntry = !guard.safeMode;
  if (firstEntry) {
    guard.safeMode = true;
    guard.safeModeReason = reason;
    guard.safeModeSince = new Date().toISOString();
  }
  // Loud on purpose — this is a refused data-destroying commit, not a hiccup.
  log.git.error(
    'git-sync entered PULL-ONLY SAFE MODE — refusing to auto-commit a suspicious mass change. '
    + 'Local files are untouched but will NOT be committed until the anomaly clears '
    + '(dirty set shrinks below threshold) or a human clears safe mode.',
    { reason, firstEntry, since: guard.safeModeSince, ...detail },
  );
}

// ── Disk-watermark pull-only latch ───────────────────────────────────────────
// Set by src/core/disk-watermark.ts when the data-dir filesystem crosses the
// critical watermark (90%). Distinct from the mass-revert safe mode above: that
// one protects against committing a BAD tree and auto-clears when the anomaly
// does; this one protects a nearly-full DISK — a commit writes objects and a
// push writes pack files locally, so both would race the filesystem to 0% and
// die mid-lock with ENOSPC (the 2026-08-12 cloud outage). Pulls stay allowed:
// receiving upstream deletions/compactions is how the box gets smaller.
let diskPullOnly = false;

/** Flip the disk latch (idempotent — repeated same-value calls are silent). */
export function setDiskPullOnly(v: boolean, detail?: Record<string, unknown>): void {
  if (diskPullOnly === v) return;
  diskPullOnly = v;
  if (v) {
    log.git.error(
      'git-sync entering DISK pull-only mode — data disk critically full. '
      + 'Auto-commits and pushes are paused until space is freed; pulls continue.',
      detail ?? {},
    );
  } else {
    log.git.warn('git-sync leaving disk pull-only mode — commits and pushes resume', detail ?? {});
  }
}

export function isDiskPullOnly(): boolean {
  return diskPullOnly;
}

/** Record a fetch/pull network failure; returns the current streak. */
export function noteNetworkFailure(): number {
  return ++guard.consecutiveNetworkFailures;
}

/** Record a successful fetch/pull — resets the failure streak. */
export function noteNetworkSuccess(): void {
  guard.consecutiveNetworkFailures = 0;
}

// ── Bundle-push fallback (T65) ───────────────────────────────────────────────
// Endpoint-security TLS filters on some machines corrupt long sustained
// uploads: a push whose pack exceeds a few dozen MB dies mid-stream with
// "SSL bad record mac" — reproducibly (2026-08-22 controlled experiment; the
// hub accepted the same 250MB pack pushed locally in 20s). One-off failures
// are ordinary network weather; a STREAK of them while local commits pile up
// is the filter signature, so after PUSH_FAILURES_FOR_BUNDLE consecutive
// failures the delta is delivered through the chunked bundle channel
// (git-bundle-client.ts — small requests, one fresh connection each).

export const PUSH_FAILURES_FOR_BUNDLE = 3;
let pushFailureStreak = 0;

async function tryBundlePushFallback(branch: string): Promise<boolean> {
  const remoteUrl = await gitSafeAsync('remote get-url origin');
  if (!remoteUrl) return false;
  const remoteTip = await gitSafeAsync(`rev-parse origin/${branch}`);
  try {
    const { pushViaBundle } = await import('./git-bundle-client.js');
    const result = await pushViaBundle({
      branch,
      remoteUrl,
      // CAS against the tip we believe; basis makes the bundle incremental
      // (only the un-pushed commits travel, not the whole history).
      oldValue: remoteTip ?? '',
      basis: remoteTip ?? undefined,
    });
    if (result.ok) {
      log.git.warn('sync push delivered via bundle channel after repeated push failures', {
        branch, bytes: result.bytes, chunks: result.chunks, streak: pushFailureStreak,
      });
      // Remote moved under us (from git's viewpoint) — refresh the tracking ref.
      await gitSafeAsync(`fetch origin ${branch}`, { timeout: FETCH_TIMEOUT });
      return true;
    }
    log.git.warn('bundle push fallback failed', { branch, error: result.error });
    return false;
  } catch (err) {
    log.git.warn('bundle push fallback threw', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Test hook: reset all guard state between tests. */
export function resetSyncGuardForTest(): void {
  diskPullOnly = false;
  guard.safeMode = false;
  guard.safeModeReason = null;
  guard.safeModeSince = null;
  guard.consecutiveNetworkFailures = 0;
  pushFailureStreak = 0;
  lastSafeModeRefusalLog = 0;
  lastSurgeryWarnLog = 0;
  // The tracked-file count is per-repo and cached for 10 minutes; tests rebuild
  // the fixture repo between cases, so a carried-over count would size the
  // breaker against the previous repo.
  resetTrackedCountCacheForTest();
}

/**
 * True while the data repo is mid-surgery: a rebase, an am-session, or an
 * unfinished merge. In every one of those states the worktree is a TRANSIENT
 * intermediate — a partially replayed tree, or a merge with unresolved paths —
 * and `add -A` + commit snapshots it as real user intent. That is the
 * 2026-08-04 incident: the data repo's 30s auto-save fired while a rebase was
 * in progress and committed the mid-replay tree, resurrecting 2233 files.
 *
 * Cheap on purpose (three fs.existsSync calls, no git subprocess) because the
 * sync tick calls it twice every 30s.
 */
export function isGitSurgeryInProgress(repoDir = WALNUT_HOME): boolean {
  const gitDir = path.join(repoDir, '.git');
  return (
    fs.existsSync(path.join(gitDir, 'rebase-merge'))     // interactive/merge rebase
    || fs.existsSync(path.join(gitDir, 'rebase-apply'))  // `rebase --apply` / `git am`
    || fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))    // merge with unresolved paths
  );
}

/**
 * Surgery state older than this is ORPHANED: no live process owns it. The only
 * rebase creator on the data repo is our own `pull --rebase` (PULL_TIMEOUT=60s),
 * so 30 minutes is 30× past any legitimate lifetime; a human mid-rebase keeps
 * the dir's mtime fresh by advancing through picks.
 */
export const ORPHAN_SURGERY_MIN_AGE_MS = 30 * 60_000;

export interface OrphanRecoveryResult {
  recovered: boolean;
  kind?: 'rebase' | 'merge' | 'marker';
  rescueBranch?: string;
  mergedBack?: boolean;
  error?: string;
}

/**
 * Recover from an ORPHANED rebase/merge in the data repo — the 2026-08-22
 * incident: a server restart mid-`pull --rebase` left `.git/rebase-merge`
 * behind, the surgery guard then (correctly) froze every auto-commit, and
 * nothing ever cleaned the state up: sync stayed frozen for 22 hours across
 * FIVE server restarts while local commits piled 365 deep.
 *
 * The guard must stay conservative (a LIVE rebase is untouchable), so this
 * runs only when the surgery state is provably orphaned: stale mtime, and by
 * construction at startup no previous in-process git can still own it.
 *
 * Rebase recovery preserves BOTH sides:
 *   1. snapshot the live worktree as a commit on the detached HEAD
 *      (server writes since the freeze — the newest data on the machine),
 *      parked on a rescue branch;
 *   2. `checkout -f <branch>` back to the pre-rebase tip (all local commits);
 *   3. `rebase --quit` to drop the dead state;
 *   4. merge the rescue branch back with `-X theirs` (live disk wins), and
 *      resolve any modify/delete leftovers the same way. If the merge cannot
 *      complete it is aborted — main is unfrozen either way and the rescue
 *      branch keeps the data recoverable.
 *
 * An orphaned MERGE (MERGE_HEAD, no owner) is simply aborted: lwwMerge always
 * commits within its own tick, so a leftover merge is half-applied state whose
 * remote side is still safe in origin/<branch> — the next pull redoes it.
 */
export async function recoverOrphanedGitSurgery(
  repoDir = WALNUT_HOME,
  minAgeMs = ORPHAN_SURGERY_MIN_AGE_MS,
): Promise<OrphanRecoveryResult> {
  const gitDir = path.join(repoDir, '.git');
  const opts = { cwd: repoDir };
  const stale = (p: string): boolean => {
    try { return Date.now() - fs.statSync(p).mtimeMs > minAgeMs; } catch { return false; }
  };

  for (const dirName of ['rebase-merge', 'rebase-apply']) {
    const stateDir = path.join(gitDir, dirName);
    if (!fs.existsSync(stateDir)) continue;
    if (!stale(stateDir)) return { recovered: false };

    const headNamePath = path.join(stateDir, 'head-name');
    if (!fs.existsSync(headNamePath)) {
      // No head-name = not a real rebase (e.g. a leftover pause marker) — debris.
      try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      log.git.warn('git-sync removed an orphaned surgery marker dir', { dir: stateDir });
      return { recovered: true, kind: 'marker' };
    }

    const branch = fs.readFileSync(headNamePath, 'utf-8').trim().replace(/^refs\/heads\//, '');
    const rescueBranch = `rescue-orphaned-rebase-${new Date().toISOString().slice(0, 10)}`;
    log.git.warn('git-sync recovering from an ORPHANED rebase — sync has been frozen since it died', {
      dir: stateDir, branch, rescueBranch,
    });

    // 1. Snapshot the live worktree on the detached HEAD (newest data on disk).
    await gitSafeAsync('add -A', opts);
    await gitSafeAsync('commit -q -m "rescue: live worktree at orphaned-rebase recovery"', opts);
    const rescueTip = await gitSafeAsync('rev-parse HEAD', opts);
    if (rescueTip) await gitSafeAsync(`branch -f ${rescueBranch} ${rescueTip}`, opts);

    // 2. Back to the pre-rebase branch tip (keeps every un-replayed local commit).
    if (await gitSafeAsync(`checkout -f ${branch}`, { ...opts, timeout: PULL_TIMEOUT }) === null) {
      return { recovered: false, kind: 'rebase', rescueBranch, error: `checkout -f ${branch} failed` };
    }
    // 3. Drop the dead rebase state (quit keeps refs; fall back to rm).
    if (await gitSafeAsync('rebase --quit', opts) === null) {
      try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    // 4. Merge the live snapshot back — live disk wins content conflicts.
    let mergedBack = false;
    if (rescueTip) {
      const merge = await gitSafeAsync(`merge --no-edit -X theirs ${rescueBranch}`, { ...opts, timeout: PULL_TIMEOUT });
      if (merge !== null) {
        mergedBack = true;
      } else {
        // -X theirs does not cover modify/delete — resolve leftovers toward the
        // rescue side (it IS the live disk), then commit; abort if truly stuck.
        const unmerged = (await gitSafeAsync('diff --name-only --diff-filter=U', opts)) ?? '';
        let resolvedAll = unmerged.length > 0;
        for (const file of unmerged.split('\n').filter(Boolean)) {
          const take = await gitSafeAsync(`checkout ${rescueBranch} -- "${file}"`, opts);
          if (take === null && await gitSafeAsync(`rm -q -- "${file}"`, opts) === null) resolvedAll = false;
          else if (take !== null) await gitSafeAsync(`add -- "${file}"`, opts);
        }
        if (resolvedAll
          && await gitSafeAsync('commit -q --no-edit -m "rescue: merge orphaned-rebase live snapshot"', opts) !== null) {
          mergedBack = true;
        } else {
          await gitSafeAsync('merge --abort', opts);
          log.git.error('git-sync orphaned-rebase recovery could not merge the live snapshot — kept on the rescue branch', {
            rescueBranch,
          });
        }
      }
    }
    log.git.warn('git-sync orphaned-rebase recovery complete — sync unfrozen', {
      branch, rescueBranch, mergedBack,
    });
    return { recovered: true, kind: 'rebase', rescueBranch, mergedBack };
  }

  const mergeHead = path.join(gitDir, 'MERGE_HEAD');
  if (fs.existsSync(mergeHead) && stale(mergeHead)) {
    await gitSafeAsync('merge --abort', opts);
    if (fs.existsSync(mergeHead)) {
      try { fs.unlinkSync(mergeHead); } catch { /* best-effort */ }
    }
    log.git.warn('git-sync aborted an ORPHANED merge — remote side is safe in origin, next pull redoes it');
    return { recovered: true, kind: 'merge' };
  }

  return { recovered: false };
}

/** Re-log the ongoing surgery refusal at most this often (first hit is always loud). */
const SURGERY_RELOG_MS = 10 * 60_000;
let lastSurgeryWarnLog = 0;

/**
 * Log the surgery skip, throttled like the safe-mode re-log — a human rebase can
 * take minutes and the tick fires twice per 30s.
 */
function logSurgerySkip(context: string): void {
  const now = Date.now();
  if (now - lastSurgeryWarnLog < SURGERY_RELOG_MS) return;
  lastSurgeryWarnLog = now;
  log.git.warn(
    'git-sync skipping auto-commit — a git rebase/merge/am is IN PROGRESS in the data repo. '
    + 'Committing a mid-surgery worktree is the 2026-08-04 mass-resurrection incident. '
    + 'Pulls continue; commits resume once the surgery finishes or is aborted.',
    { context, repo: WALNUT_HOME },
  );
}

/** Strip the porcelain XY prefix; keep git's C-style quoting as-is (it is
 * consistent with `log --name-only` output, so set-matching still works). */
function porcelainPath(line: string): string {
  return line.slice(3).trim();
}

/**
 * Resurrection heuristic: untracked dirty paths that upstream's recent history
 * deleted (or renamed away — `--no-renames` splits renames into D+A). A stale
 * worktree snapshotted after upstream reorganized shows up as exactly this:
 * hundreds of "new" files at paths the fresh HEAD recently deleted. A LEGIT
 * local reorg looks different — its untracked paths are brand new, not
 * recently-deleted ones. Cost: one `git log` over the last 50 commits.
 */
async function countResurrections(
  dirtyLines: string[],
): Promise<{ resurrected: number; untracked: number; sample: string[] }> {
  const untracked = dirtyLines.filter((l) => l.startsWith('??')).map(porcelainPath);
  if (untracked.length === 0) return { resurrected: 0, untracked: 0, sample: [] };
  const deletedLog = await gitSafeAsync(
    `log -${RESURRECTION_LOG_DEPTH} --no-renames --diff-filter=D --name-only --format=`,
  );
  if (!deletedLog) return { resurrected: 0, untracked: untracked.length, sample: [] };
  const deleted = new Set(deletedLog.split('\n').map((s) => s.trim()).filter(Boolean));
  const hits = untracked.filter((p) => deleted.has(p));
  return { resurrected: hits.length, untracked: untracked.length, sample: hits.slice(0, 10) };
}

/**
 * Decide whether a dirty snapshot is safe to `add -A` + commit. Cheap by
 * design: counts + one recent-history scan, never content diffs.
 *
 * Two independent trip conditions:
 *
 *  1. MASS: dirty count ≥ effectiveMassDirtyThreshold() AND at least one revert
 *     signal — a fetch/pull failure streak (worktree presumed stale) or a mass
 *     resurrection of recently-deleted upstream paths. A huge dirty set with NO
 *     revert signal (e.g. a legitimate bulk import) is allowed with a loud warn.
 *  2. RESURRECTION ALONE: ≥ RESURRECTION_TRIP_COUNT untracked files sitting at
 *     paths upstream recently deleted, EVEN BELOW the mass threshold. Nothing
 *     legitimate re-creates 25 just-deleted paths; tying this signal to the mass
 *     count meant a partial revert (say 80 resurrected files on a small repo)
 *     sailed straight through.
 *
 * Cost bound: countResurrections (one `git log` over 50 commits) runs only when
 * the dirty set is already at least RESURRECTION_TRIP_COUNT lines.
 */
export async function assessCommitSafety(
  dirtyLines: string[],
): Promise<{ ok: boolean; reason?: string }> {
  const massThreshold = await effectiveMassDirtyThreshold();
  const isMass = dirtyLines.length >= massThreshold;
  // Below the resurrection floor nothing can trip — skip the `git log` entirely.
  const worthChecking = dirtyLines.length >= RESURRECTION_TRIP_COUNT;

  if (guard.safeMode) {
    // Stay latched while EITHER anomaly is still visible. The mass count alone
    // used to gate this, so a resurrection-triggered latch (which can sit well
    // below the mass threshold) would have been released on the very next tick
    // and committed the thing it just refused.
    const stillResurrecting = !isMass && worthChecking
      && (await countResurrections(dirtyLines)).resurrected >= RESURRECTION_TRIP_COUNT;
    if (!isMass && !stillResurrecting) {
      // Anomaly gone (human repaired the tree, or the mass change vanished).
      clearSyncSafeMode('dirty set shrank below threshold');
      return { ok: true };
    }
    // The tick runs every 30s and calls this from both commitIfDirty and
    // syncInner — throttle the repeat noise; entry + periodic re-log stay loud.
    const now = Date.now();
    if (now - lastSafeModeRefusalLog >= SAFE_MODE_RELOG_MS) {
      lastSafeModeRefusalLog = now;
      log.git.error(
        'git-sync SAFE MODE active — auto-commit refused (pull-only). '
        + 'Repair the worktree or clear safe mode to resume commits.',
        { reason: guard.safeModeReason, since: guard.safeModeSince, dirtyCount: dirtyLines.length },
      );
    }
    return { ok: false, reason: guard.safeModeReason ?? 'safe-mode' };
  }

  if (!worthChecking) return { ok: true };

  const streak = guard.consecutiveNetworkFailures;
  const res = await countResurrections(dirtyLines);
  const massResurrection = res.resurrected >= RESURRECTION_TRIP_COUNT;
  const staleAfterOutage = isMass && streak >= FAILURE_STREAK_FOR_PULL_FIRST;
  if (staleAfterOutage || massResurrection) {
    enterSafeMode('mass-revert-suspect', {
      dirtyCount: dirtyLines.length,
      massThreshold,
      consecutiveNetworkFailures: streak,
      resurrectedCount: res.resurrected,
      untrackedCount: res.untracked,
      resurrectedSample: res.sample,
      dirtySample: dirtyLines.slice(0, 10),
      trigger: massResurrection ? 'resurrection' : 'stale-after-outage',
    });
    return { ok: false, reason: 'mass-revert-suspect' };
  }

  if (isMass) {
    log.git.warn('git-sync committing an unusually large dirty set (no revert signals — allowing)', {
      dirtyCount: dirtyLines.length,
      massThreshold,
      dirtySample: dirtyLines.slice(0, 10),
    });
  }
  return { ok: true };
}

/**
 * Torn-worktree sentinel: right after a pull/merge/reset applied cleanly, the
 * worktree should be near-clean (syncInner commits everything first; only
 * files the app wrote DURING the pull may be dirty). A massive disagreement
 * means the checkout half of the pull died (e.g. killed on timeout) while the
 * ref half landed — the exact torn state that produced the 2026-08-03 mass
 * revert. Enter pull-only safe mode so no `add -A` can snapshot it.
 */
export async function verifyWorktreeAfterPull(context: string): Promise<boolean> {
  const status = await gitSafeAsync('status --porcelain -uall');
  const lines = (status ?? '').split('\n').filter((l) => l.trim().length > 0);
  const massThreshold = await effectiveMassDirtyThreshold();
  if (lines.length < massThreshold) return true;
  enterSafeMode('torn-worktree', {
    context,
    dirtyCount: lines.length,
    massThreshold,
    dirtySample: lines.slice(0, 10),
  });
  return false;
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
  // Compaction pause must gate sync() too, not just commitIfDirty(): syncInner
  // runs its own `add -A` + commit, so an unpaused tick would still move `main`
  // mid-rewrite and fail the tree verification.
  if (compactionInProgress) {
    log.git.debug('git-sync skipped — history compaction in progress');
    return { pulled: 0, pushed: 0, conflicts: 0 };
  }
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

  // Surgery-in-progress: a rebase/merge/am is mid-flight in the data repo, so
  // this whole cycle stands down. Checked FIRST, before any git call — mid-rebase
  // HEAD is detached, so getBranch() below would report "HEAD" rather than a
  // branch. Committing the transient tree is the incident (see
  // isGitSurgeryInProgress); pulling would be safe in isolation, but the pull
  // path is NOT surgery-safe either — pullFromRemote runs `rebase --abort`
  // whenever `pull --rebase` fails, which would destroy the human's in-flight
  // rebase (verified: abort succeeds against a conflicted rebase-merge). And git
  // itself refuses to pull mid-rebase anyway, so there is nothing to gain.
  if (isGitSurgeryInProgress()) {
    // Self-heal an ORPHANED rebase/merge (stale state no process owns) instead
    // of freezing forever: the 2026-08-22 incident froze sync for 22 hours
    // across five restarts because nothing ever recovered the dead rebase.
    // Age-gated inside (30 min) so a live rebase is never touched; on the tick
    // that recovers, we still stand down and let the NEXT tick sync normally.
    const recovery = await recoverOrphanedGitSurgery();
    if (!recovery.recovered) logSurgerySkip('sync');
    return { pulled: 0, pushed: 0, conflicts: 0 };
  }

  const remote = hasRemote();
  const branch = remote ? getBranch() : 'main';

  // Never let a machine-local file stay tracked: any pull below could apply a
  // remote deletion of it straight to disk. Runs unconditionally every cycle
  // (the dangerous state can appear at runtime); its `rm --cached` staging is
  // picked up by the dirty check and committed like the old flow did.
  await ensureMachineLocalUntrackedAsync();

  // -uall: an entirely-untracked directory otherwise collapses to one `?? dir/`
  // line, hiding a mass resurrection from both the threshold and the heuristic.
  const preStatus = await gitSafeAsync('status --porcelain -uall');
  const preLines = (preStatus ?? '').split('\n').filter((l) => l.trim().length > 0);

  // ── Order inversion after an outage ──
  // Normally we commit BEFORE pulling so no local edit is ever unrecorded.
  // But after a fetch/pull failure streak the worktree is presumed STALE
  // (frozen on an old tree while upstream moved) — exactly the state where
  // `add -A` snapshots a mass revert (2026-08-03 incident). One-shot: refresh
  // the worktree from upstream FIRST, then let the commit see honest dirt.
  // Only when no TRACKED file is modified: git refuses to rebase/merge over
  // tracked changes anyway, and a frozen-then-recovered worktree is clean.
  const trackedDirty = preLines.filter((l) => !l.startsWith('??'));
  const pullFirst = remote
    && guard.consecutiveNetworkFailures >= FAILURE_STREAK_FOR_PULL_FIRST
    && trackedDirty.length === 0;
  if (pullFirst) {
    log.git.warn(
      'git-sync recovering from a fetch/pull failure streak — pulling BEFORE commit this cycle so a stale worktree cannot be snapshotted',
      { consecutiveNetworkFailures: guard.consecutiveNetworkFailures, branch },
    );
    const first = await pullFromRemote(branch);
    pulled = first.pulled;
    conflicts += first.conflicts;
  }

  // ── Commit local changes (guarded) ──
  // Re-read after a possible pull; the pull may have absorbed or changed dirt.
  const status = pullFirst ? await gitSafeAsync('status --porcelain -uall') : preStatus;
  const dirtyLines = pullFirst
    ? (status ?? '').split('\n').filter((l) => l.trim().length > 0)
    : preLines;
  if (dirtyLines.length === 0 && guard.safeMode) {
    // Tree is clean again (e.g. a human reset it) — the anomaly is gone.
    clearSyncSafeMode('worktree clean');
  }
  // Second layer, not redundant: the pull-first branch above can run for up to
  // PULL_TIMEOUT (60s), and a human can start a rebase inside that window. Three
  // existsSync calls are free relative to the failure they prevent. Bail on the
  // rest of the cycle (commit AND pull) for the reasons at the top of syncInner.
  if (isGitSurgeryInProgress()) {
    logSurgerySkip('syncInner:commit');
    return { pulled, pushed: 0, conflicts };
  }
  if (dirtyLines.length > 0 && !diskPullOnly) {
    const safety = await assessCommitSafety(dirtyLines);
    if (safety.ok) {
      await gitAsync('add -A');

      // …and re-check: `add -A` itself can re-track a machine-local file the
      // instant before a pull could carry its remote deletion to disk.
      await ensureMachineLocalUntrackedAsync();

      // Count from what is ACTUALLY staged at commit time. The old code
      // counted a pre-add snapshot elsewhere, which is how the 2026-08-03
      // 2233-rename mass revert got committed as "(1 files)".
      const staged = await gitSafeAsync('diff --cached --name-only');
      const stagedCount = (staged ?? '').split('\n').filter((l) => l.trim().length > 0).length;
      if (stagedCount > 0) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await gitSafeAsync(`commit -m "open-walnut sync ${timestamp} (${stagedCount} files)"`);
        pushed = 1;
      }
    }
    // safety.ok === false → pull-only safe mode: skip commit, still pull below
    // so the box keeps receiving upstream (assessCommitSafety already logged).
  }

  // ── Pull + push ──
  if (remote) {
    if (!pullFirst) {
      const result = await pullFromRemote(branch);
      pulled = result.pulled;
      conflicts += result.conflicts;
    }

    // Push (skipped in safe mode: nothing new was committed, and a torn/stale
    // box must not publish anything until a human or a clean cycle clears it.
    // Also skipped in disk pull-only mode: a push packs objects LOCALLY first,
    // which is exactly the write pressure the disk latch exists to stop).
    if (!guard.safeMode && !diskPullOnly) {
      const pushResult = await gitSafeAsync(`push origin ${branch}`, { timeout: NETWORK_TIMEOUT });
      if (pushResult === null) {
        pushed = 0; // push failed
        // Endpoint-security TLS filters kill large sustained pushes mid-stream
        // (T65) — a push that keeps failing while commits pile up locally is
        // that signature, and retrying it every 30s just re-packs the same
        // doomed pack. After a few consecutive failures, deliver the delta
        // through the chunked bundle channel instead (small requests, one
        // connection each — the filters never see a long stream).
        pushFailureStreak++;
        if (pushFailureStreak >= PUSH_FAILURES_FOR_BUNDLE) {
          const delivered = await tryBundlePushFallback(branch);
          if (delivered) {
            pushed = 1;
            pushFailureStreak = 0;
          }
        }
      } else {
        pushFailureStreak = 0;
      }
    }
  }

  return { pulled, pushed, conflicts };
}

/**
 * Pull with linear-history preference and LWW-merge fallback, plus the
 * incident guards: pull gets the LONG timeout (it checks out files, not just
 * transfers), success/failure feeds the outage-streak tracker, and a
 * completed pull is verified against a torn worktree.
 *
 * Clean case: rebase (keeps history linear). Conflict case: abort the rebase
 * and do a TRUE MERGE with per-file LWW resolution — a merge commit preserves
 * BOTH parents, so the losing side of every conflict remains recoverable from
 * git history (rebase would rewrite the local commits and destroy that).
 */
async function pullFromRemote(branch: string): Promise<{ pulled: number; conflicts: number }> {
  let pulled = 0;
  let conflicts = 0;

  const pullResult = await gitSafeAsync(`pull --rebase origin ${branch}`, { timeout: PULL_TIMEOUT });
  if (pullResult === null) {
    // Rebase failed — could be a content conflict or a network error.
    // Abort any half-applied rebase (no-op if none), then take the merge path.
    // lwwMerge's fetch outcome updates the network failure streak.
    await gitSafeAsync('rebase --abort');
    const merge = await lwwMerge(branch);
    conflicts = merge.conflicts;
    if (merge.merged) pulled = 1;
  } else {
    noteNetworkSuccess();
    if (pullResult.includes('Updating') || pullResult.includes('Fast-forward')) {
      pulled = 1;
    }
  }

  // Torn-worktree sentinel: if the checkout half of the pull died while the
  // ref half landed, the tree now massively disagrees with HEAD — flag it
  // BEFORE any later `add -A` can snapshot the stale files as a revert.
  if (pulled === 1) {
    await verifyWorktreeAfterPull(`pull origin/${branch}`);
  }

  return { pulled, conflicts };
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
      // Feed the outage tracker: a long streak means the worktree is frozen on
      // an old tree, and the first recovered cycle must pull BEFORE committing.
      const streak = noteNetworkFailure();
      log.git.warn('git-sync fetch failed — skipping merge this cycle', {
        branch,
        // Surface WHY. 246 consecutive failures were logged without ever naming
        // the cause, which is why a 2.5-day-old lock went unnoticed.
        error: detail.slice(0, 400),
        lockContention: isLockContention(fetchError),
        consecutiveNetworkFailures: streak,
      });
      return { merged: false, conflicts: 0 };
    }
  }
  noteNetworkSuccess();

  const localHead = await gitSafeAsync('rev-parse HEAD');
  const remoteHead = await gitSafeAsync(`rev-parse ${remoteRef}`);
  if (!localHead || !remoteHead || localHead === remoteHead) {
    return { merged: false, conflicts: 0 };
  }

  // Upstream history rewrite (weekly compaction on the primary force-pushes a
  // rewritten main). No common ancestor means merging would join the OLD fat
  // chain with the compacted one — resurrecting the entire pre-compaction
  // history into the hub and undoing the compaction. Adopt the new chain
  // instead: park the old head on a self-replacing backup ref (any local-only
  // commits stay recoverable from it until the next rewrite), then hard-reset.
  // Safe against dirty-file loss: syncInner() commits everything before pull.
  if (await gitSafeAsync(`merge-base HEAD ${remoteRef}`) === null) {
    await gitSafeAsync('branch -f pre-rewrite-backup HEAD');
    if (await gitSafeAsync(`reset --hard ${remoteRef}`) === null) {
      log.git.error('git-sync: upstream history rewritten but reset --hard failed — will retry next cycle', { localHead, remoteHead });
      return { merged: false, conflicts: 0 };
    }
    log.git.warn('git-sync: upstream history rewritten (compaction) — adopted the new chain; previous head saved on pre-rewrite-backup', {
      previousHead: localHead, newHead: remoteHead,
    });
    return { merged: true, conflicts: 0 };
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
    const fallback = await gitSafeAsync(`pull -X theirs origin ${branch}`, { timeout: PULL_TIMEOUT });
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
    await gitSafeAsync(`pull -X theirs origin ${branch}`, { timeout: PULL_TIMEOUT });
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
      // as the old execSync version, minus the event-loop block. PULL_TIMEOUT:
      // a pull checks out files, and killing it mid-checkout is what tears a
      // worktree (2026-08-03 incident) — give it room to finish.
      const pullOut = await gitSafeAsync('pull --ff-only', { timeout: PULL_TIMEOUT });
      // Same torn-worktree sentinel as the sync tick: if this pull moved HEAD
      // but died mid-checkout, flag it before any add -A can snapshot it.
      if (pullOut !== null && (pullOut.includes('Updating') || pullOut.includes('Fast-forward'))) {
        await verifyWorktreeAfterPull('gitPullWalnut --ff-only');
      }
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

  // Top-level .git/*.lock beyond index.lock: a merge killed mid-run (e.g. by
  // execGitGroup's timeout during the 2026-08 hub CPU-starvation) leaves
  // AUTO_MERGE.lock / MERGE_HEAD.lock behind, and every later merge then fails
  // "cannot lock ref" FOREVER — observed as a merge-failure loop falling back
  // to `pull -X theirs` on every 30s tick for two days. Sweep them all; the
  // same mtime staleness guard keeps a live git's locks safe.
  try {
    for (const entry of fs.readdirSync(gitDir)) {
      if (entry !== 'index.lock' && entry.endsWith('.lock')) {
        removeIfStale(path.join(gitDir, entry));
      }
    }
  } catch {
    // .git unreadable — nothing to do
  }

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
  // Disk latch: a commit writes loose objects; on a critically-full disk it
  // dies mid-lock with ENOSPC (2026-08-12 cloud outage). Local edits stay on
  // disk and are committed as soon as the watermark clears.
  if (diskPullOnly) return false;
  // Surgery-in-progress guard: a rebase/merge/am leaves a transient tree that
  // `add -A` must never snapshot (2026-08-04 incident). Bail BEFORE clearing
  // locks — a live rebase's locks are not ours to sweep.
  if (isGitSurgeryInProgress()) {
    logSurgerySkip('commitIfDirty');
    return false;
  }
  clearStaleLock();
  // -uall: see syncInner — collapsed `?? dir/` lines would hide a mass
  // resurrection from the circuit breaker.
  const status = await gitSafeAsync('status --porcelain -uall');
  if (!status || status.trim().length === 0) {
    // Clean tree while in safe mode = the anomaly is gone (human repaired it).
    if (guard.safeMode) clearSyncSafeMode('worktree clean');
    return false;
  }

  const lines = status.split('\n').filter((l) => l.trim());

  // Mass-revert circuit breaker: this exact function committed the 2026-08-03
  // incident — `add -A` on a worktree frozen 8h behind upstream snapshotted a
  // 2200-file revert of the user's reorg. Refuse suspicious mass snapshots.
  const safety = await assessCommitSafety(lines);
  if (!safety.ok) return false;

  try {
    await gitAsync('add -A');
  } catch (err) {
    if (!isLockContention(err)) throw err;
    // Lock held by another process — wait briefly (async, loop keeps running) and retry once
    await new Promise((r) => setTimeout(r, 300));
    clearStaleLock(5_000);
    await gitAsync('add -A');
  }

  // Honest count: from what is ACTUALLY staged at commit time, not the
  // pre-add status snapshot. The incident commit reverted 2233 renames while
  // its message claimed "(1 files)" because the count predated the add.
  const staged = await gitSafeAsync('diff --cached --name-only');
  const stagedCount = (staged ?? '').split('\n').filter((l) => l.trim().length > 0).length;
  if (stagedCount === 0) return false; // e.g. everything dirty was gitignored/untracked-only noise

  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await gitSafeAsync(`commit -m "auto-save ${timestamp} (${stagedCount} files)"`);
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
    try {
      ensureGitIdentity();
    } catch (err) {
      return {
        available: false,
        error: `git identity setup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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
      safeMode: guard.safeMode,
      diskPullOnly,
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
    safeMode: guard.safeMode,
    diskPullOnly,
  };
}
