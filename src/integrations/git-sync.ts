import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';

export interface SyncStatus {
  initialized: boolean;
  remoteConfigured: boolean;
  lastSyncAt: string | null;
  pendingChanges: number;
  branch: string;
}

const LOCAL_TIMEOUT = 30_000;
const NETWORK_TIMEOUT = 15_000;

function git(args: string, timeout = LOCAL_TIMEOUT): string {
  return execSync(`git ${args}`, {
    cwd: WALNUT_HOME,
    timeout,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitSafe(args: string, timeout = LOCAL_TIMEOUT): string | null {
  try {
    return git(args, timeout);
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

export function initSync(remoteUrl?: string): void {
  if (!isRepo()) {
    git('init');
    git('checkout -b main');
  }

  // Create .gitignore if it doesn't exist
  const gitignorePath = path.join(WALNUT_HOME, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
  }

  if (remoteUrl) {
    setRemote(remoteUrl);
  }

  // Initial commit if repo is empty
  const hasCommits = gitSafe('log --oneline -1') !== null;
  if (!hasCommits) {
    git('add -A');
    gitSafe('commit -m "walnut init"');
  }
}

export function setRemote(url: string): void {
  if (hasRemote()) {
    git(`remote set-url origin ${url}`);
  } else {
    git(`remote add origin ${url}`);
  }
}

export function sync(): { pulled: number; pushed: number; conflicts: number } {
  let pulled = 0;
  let pushed = 0;
  let conflicts = 0;

  // Stage all changes
  git('add -A');

  // Check for staged changes
  const diff = gitSafe('diff --cached --stat');
  if (diff && diff.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    gitSafe(`commit -m "walnut sync ${timestamp}"`);
    pushed = 1;
  }

  // Pull with rebase if remote is configured
  if (hasRemote()) {
    const branch = getBranch();
    const pullResult = gitSafe(`pull --rebase origin ${branch}`, NETWORK_TIMEOUT);
    if (pullResult === null) {
      // Check for rebase conflict
      const status = gitSafe('status --porcelain');
      if (status && status.includes('UU')) {
        conflicts = 1;
        // Abort rebase and accept theirs for tasks.json
        gitSafe('rebase --abort');
        gitSafe(`pull -X theirs origin ${branch}`, NETWORK_TIMEOUT);
      }
    } else if (pullResult.includes('Updating') || pullResult.includes('Fast-forward')) {
      pulled = 1;
    }

    // Push
    const pushResult = gitSafe(`push origin ${branch}`, NETWORK_TIMEOUT);
    if (pushResult === null) {
      pushed = 0; // push failed
    }
  }

  return { pulled, pushed, conflicts };
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
 * Pull latest data from the walnut git repo (best-effort, async).
 * Used by the server to fetch data pushed by remote hooks.
 * Silently does nothing if ~/.walnut/ is not a git repo or has no remote.
 */
export async function gitPullMybot(): Promise<void> {
  try {
    if (!isGitAvailable() || !isRepo() || !hasRemote()) return;
    execSync('git pull --ff-only', {
      cwd: WALNUT_HOME,
      timeout: 15000,
      stdio: 'ignore',
    });
  } catch {
    // Best-effort — don't fail callers
  }
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
