/**
 * PayloadBuilder — lazy context resolution for session hook payloads.
 *
 * Caches task/session lookups per session to avoid redundant DB reads
 * within the same event burst.
 */

import type { Task, SessionRecord } from '../types.js';
import type { SessionHookContext } from './types.js';

interface CacheEntry {
  task?: Task;
  session?: SessionRecord;
  expiresAt: number;
}

const CACHE_TTL_MS = 10_000; // 10s

export class PayloadBuilder {
  private cache = new Map<string, CacheEntry>();

  /**
   * Build a SessionHookContext with lazy-resolved task and session.
   */
  async build(
    sessionId: string,
    taskId: string | undefined,
    traceId: string,
  ): Promise<SessionHookContext> {
    const cached = this.cache.get(sessionId);
    const now = Date.now();

    let task: Task | undefined;
    let session: SessionRecord | undefined;

    if (cached && cached.expiresAt > now) {
      task = cached.task;
      session = cached.session;
    } else {
      // Resolve task
      if (taskId) {
        try {
          const { getTask } = await import('../task-manager.js');
          task = await getTask(taskId);
        } catch {
          // Task may not exist
        }
      }

      // Resolve session
      try {
        const { getSessionByClaudeId } = await import('../session-tracker.js');
        session = await getSessionByClaudeId(sessionId) ?? undefined;
      } catch {
        // Session may not exist yet
      }

      this.cache.set(sessionId, { task, session, expiresAt: now + CACHE_TTL_MS });
    }

    return {
      sessionId,
      taskId,
      task,
      session,
      timestamp: new Date().toISOString(),
      traceId,
    };
  }

  /** Clear cache for a specific session (call on session:ended). */
  clearSession(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /** Clear all cached entries. */
  clearAll(): void {
    this.cache.clear();
  }

  /** Periodic cleanup of expired entries. */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt < now) {
        this.cache.delete(key);
      }
    }
  }
}
