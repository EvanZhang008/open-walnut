/**
 * Hook to fetch and track system health (embedding status, etc.).
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

export interface SystemHealth {
  embedding: EmbeddingHealth;
}

const defaultHealth: SystemHealth = {
  embedding: { total: 0, indexed: 0, unindexed: 0, ollamaAvailable: true },
};

export function useSystemHealth() {
  const [health, setHealth] = useState<SystemHealth>(defaultHealth);
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
  }, []);

  // Listen for real-time updates
  useEvent('system:health', useCallback((data: unknown) => {
    if (data && typeof data === 'object') {
      setHealth(data as SystemHealth);
    }
  }, []));

  const hasIssues = health.embedding.unindexed > 0 || !health.embedding.ollamaAvailable;

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

  return { health, hasIssues, loading, reindexing, triggerReindex };
}
