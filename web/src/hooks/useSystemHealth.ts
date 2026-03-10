/**
 * Hook to fetch and track system health (embedding status, git-sync, etc.).
 * Fetches on mount, then listens for real-time updates via WebSocket.
 */
import { useState, useEffect, useCallback } from 'react';
import { useEvent } from './useWebSocket';

export interface EmbeddingHealth {
  total: number;
  indexed: number;
  unindexed: number;
  ollamaAvailable: boolean;
  lastReconcileAt?: string;
  lastError?: string;
}

export interface GitSyncHealth {
  protected: boolean;
  error?: string;
  lastCommitAt?: string;
  consecutiveFailures: number;
}

export interface SystemHealth {
  embedding: EmbeddingHealth;
}

const defaultHealth: SystemHealth = {
  embedding: { total: 0, indexed: 0, unindexed: 0, ollamaAvailable: true },
};

const defaultGitSync: GitSyncHealth = {
  protected: true,
  consecutiveFailures: 0,
};

export function useSystemHealth() {
  const [health, setHealth] = useState<SystemHealth>(defaultHealth);
  const [gitSync, setGitSync] = useState<GitSyncHealth>(defaultGitSync);
  const [loading, setLoading] = useState(true);
  const [reindexing, setReindexing] = useState(false);

  // Fetch initial state
  useEffect(() => {
    fetch('/api/system/health')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: SystemHealth) => {
        setHealth(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });

    // Fetch git-sync status separately
    fetch('/api/git-sync/status')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: GitSyncHealth) => setGitSync(data))
      .catch(() => {});
  }, []);

  // Listen for real-time updates
  useEvent('system:health', useCallback((data: unknown) => {
    if (data && typeof data === 'object') {
      setHealth(data as SystemHealth);
    }
  }, []));

  // Listen for git-sync status updates
  useEvent('git-sync:status', useCallback((data: unknown) => {
    if (data && typeof data === 'object') {
      setGitSync(data as GitSyncHealth);
    }
  }, []));

  const gitSyncFailing = !gitSync.protected || gitSync.consecutiveFailures >= 3;
  const hasIssues = health.embedding.unindexed > 0 || !health.embedding.ollamaAvailable || gitSyncFailing;

  const triggerReindex = useCallback(async () => {
    setReindexing(true);
    try {
      await fetch('/api/system/health/reindex', { method: 'POST' });
      // Result will come via WebSocket event
    } catch {
      // ignore
    }
    // Clear reindexing after a reasonable timeout (actual result comes via WS)
    setTimeout(() => setReindexing(false), 30_000);
  }, []);

  // Clear reindexing flag when health updates (indicates reconcile completed)
  useEffect(() => {
    if (reindexing && health.embedding.lastReconcileAt) {
      setReindexing(false);
    }
  }, [health.embedding.lastReconcileAt, reindexing]);

  return { health, gitSync, hasIssues, loading, reindexing, triggerReindex };
}
