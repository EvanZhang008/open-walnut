/**
 * GitVersioningService — centralized, event-driven git versioning for ~/.walnut/.
 *
 * Subscribes to bus events, tracks dirty files, debounces commits, and runs all
 * git operations through a serial queue to prevent index.lock conflicts.
 *
 * This replaces ad-hoc git commands in hooks (on-stop, on-compact) and the
 * server's gitPullWalnut() on session events.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bus, EventNames } from './event-bus.js';
import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import type { Config } from './types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_DEBOUNCE_MS = 30_000;
const DEFAULT_PUSH_INTERVAL_MS = 600_000; // 10 min
const GIT_TIMEOUT_MS = 30_000;

interface DirtyEntry {
  category: string;
  detail: string;
}

export class GitVersioningService {
  private dirty = new Map<string, DirtyEntry>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setInterval> | null = null;
  private gitQueue: Promise<void> = Promise.resolve();
  private destroyed = false;
  private subscriberName = 'git-versioning';

  private debouncMs: number;
  private pushEnabled: boolean;
  private pushIntervalMs: number;
  private pushOnSessionEnd: boolean;

  constructor(config?: Config['git_versioning']) {
    this.debouncMs = config?.commit_debounce_ms ?? DEFAULT_DEBOUNCE_MS;
    this.pushEnabled = config?.push_enabled ?? false;
    this.pushIntervalMs = config?.push_interval_ms ?? DEFAULT_PUSH_INTERVAL_MS;
    this.pushOnSessionEnd = config?.push_on_session_end ?? true;
  }

  /** Start listening to bus events and optionally start push timer. */
  start(): void {
    bus.subscribe(this.subscriberName, (event) => {
      this.handleEvent(event.name, event.data as Record<string, unknown> | undefined);
    }, { global: true });

    if (this.pushEnabled && this.pushIntervalMs > 0) {
      this.pushTimer = setInterval(() => {
        this.enqueueGitOp(() => this.push());
      }, this.pushIntervalMs);
    }

    log.git.info('git versioning service started', {
      debounceMs: this.debouncMs,
      pushEnabled: this.pushEnabled,
      pushIntervalMs: this.pushIntervalMs,
    });
  }

  /** Notify of a memory file change (called from memory-watcher). */
  notifyMemoryChange(filename: string): void {
    this.markDirty(`memory/${filename}`, 'memory', filename);
  }

  /**
   * Flush pending dirty files: commit immediately (skip debounce).
   * Returns after the commit completes. Used during shutdown.
   */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.dirty.size > 0) {
      await this.enqueueGitOp(() => this.commitDirty());
    }
  }

  /** Graceful shutdown: flush final commit, optionally push, teardown. */
  async destroy(): Promise<void> {
    this.destroyed = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }

    // Final commit + push
    if (this.dirty.size > 0) {
      await this.enqueueGitOp(() => this.commitDirty());
    }
    if (this.pushEnabled) {
      await this.enqueueGitOp(() => this.push());
    }

    bus.unsubscribe(this.subscriberName);
    log.git.info('git versioning service destroyed');
  }

  // ── Event handling ──

  private handleEvent(name: string, data?: Record<string, unknown>): void {
    switch (name) {
      case EventNames.TASK_CREATED:
      case EventNames.TASK_UPDATED:
      case EventNames.TASK_COMPLETED:
      case EventNames.TASK_DELETED:
      case EventNames.TASK_REORDERED:
      case EventNames.TASK_STARRED: {
        const title = (data?.task as { title?: string })?.title;
        const action = name.split(':')[1]; // 'created', 'updated', etc.
        const detail = title ? `${action} "${title.slice(0, 50)}"` : action;
        this.markDirty('tasks/tasks.json', 'task', detail);
        break;
      }

      case EventNames.SESSION_STARTED:
      case EventNames.SESSION_ENDED:
      case EventNames.SESSION_RESULT: {
        const action = name.split(':')[1];
        this.markDirty('sessions.json', 'session', action);
        // Push after session ends if configured
        if (
          (name === EventNames.SESSION_ENDED || name === EventNames.SESSION_RESULT) &&
          this.pushEnabled &&
          this.pushOnSessionEnd
        ) {
          // Schedule push shortly after the commit
          setTimeout(() => {
            if (!this.destroyed) {
              this.enqueueGitOp(() => this.push());
            }
          }, 5000);
        }
        break;
      }

      case EventNames.CONFIG_CHANGED:
        this.markDirty('config.yaml', 'config', 'updated');
        break;

      case EventNames.CHAT_COMPACTED:
        this.markDirty('chat-history.json', 'chat', 'compacted');
        break;

      case 'cron:job-added':
      case 'cron:job-updated':
      case 'cron:job-removed': {
        const action = name.split('-').pop() ?? name;
        this.markDirty('cron-jobs.json', 'cron', action);
        break;
      }

      // subtask events removed (now child tasks in the plugin system)
    }
  }

  // ── Dirty tracking + debounce ──

  private markDirty(file: string, category: string, detail: string): void {
    if (this.destroyed) return;

    this.dirty.set(file, { category, detail });
    this.scheduleCommit();
  }

  private scheduleCommit(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.enqueueGitOp(() => this.commitDirty());
    }, this.debouncMs);
  }

  // ── Serial git queue ──

  private enqueueGitOp(fn: () => Promise<void>): Promise<void> {
    const op = this.gitQueue.then(fn).catch((err) => {
      log.git.warn('git operation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.gitQueue = op;
    return op;
  }

  // ── Git operations ──

  private async gitCmd(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: WALNUT_HOME,
        timeout: GIT_TIMEOUT_MS,
      });
      return stdout.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Don't log "nothing to commit" as an error
      if (msg.includes('nothing to commit')) return '';
      throw err;
    }
  }

  private async commitDirty(): Promise<void> {
    const entries = new Map(this.dirty);
    this.dirty.clear();

    if (entries.size === 0) return;

    const message = this.buildCommitMessage(entries);

    try {
      await this.gitCmd(['add', '-A']);
      await this.gitCmd(['commit', '-m', message, '--allow-empty-message']);
      log.git.info('committed', { files: entries.size, message: message.split('\n')[0] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('nothing to commit')) {
        log.git.debug('nothing to commit (files unchanged on disk)');
      } else {
        log.git.warn('commit failed', { error: msg });
        // Put dirty entries back for next attempt
        for (const [file, entry] of entries) {
          if (!this.dirty.has(file)) {
            this.dirty.set(file, entry);
          }
        }
      }
    }
  }

  private async push(): Promise<void> {
    try {
      // Check if remote is configured
      const remotes = await this.gitCmd(['remote']).catch(() => '');
      if (!remotes) return;

      const branch = await this.gitCmd(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'main');

      // Pull with rebase first
      try {
        await this.gitCmd(['pull', '--rebase', 'origin', branch]);
      } catch {
        // If rebase fails, abort and pull with theirs strategy
        await this.gitCmd(['rebase', '--abort']).catch(() => {});
        try {
          await this.gitCmd(['pull', '-X', 'theirs', 'origin', branch]);
        } catch {
          log.git.warn('pull failed, skipping push');
          return;
        }
      }

      await this.gitCmd(['push', 'origin', branch]);
      log.git.info('pushed to remote');
    } catch (err) {
      log.git.warn('push failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Commit message formatting ──

  private buildCommitMessage(entries: Map<string, DirtyEntry>): string {
    // Group by category
    const byCategory = new Map<string, DirtyEntry[]>();
    for (const entry of entries.values()) {
      const list = byCategory.get(entry.category) ?? [];
      list.push(entry);
      byCategory.set(entry.category, list);
    }

    if (byCategory.size === 1) {
      const [category, items] = [...byCategory.entries()][0];
      if (items.length === 1) {
        return `${category}: ${items[0].detail}`;
      }
      return `${category}: ${items.length} changes`;
    }

    // Multiple categories
    const subject = `auto: ${entries.size} changes across ${byCategory.size} areas`;
    const body = [...byCategory.entries()]
      .map(([cat, items]) => `- ${cat}: ${items.map((i) => i.detail).join(', ')}`)
      .join('\n');
    return `${subject}\n\n${body}`;
  }
}

// ── Module-level singleton (set by server.ts) ──

let instance: GitVersioningService | null = null;

export function getGitVersioning(): GitVersioningService | null {
  return instance;
}

export function setGitVersioning(svc: GitVersioningService | null): void {
  instance = svc;
}
