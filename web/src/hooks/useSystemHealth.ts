/**
 * Hook to fetch and track system health (git-sync, daemons, etc.).
 * Fetches on mount, then listens for real-time updates via WebSocket.
 */
import { useState, useEffect, useCallback } from 'react';
import { useEvent } from './useWebSocket';

export interface GitSyncHealth {
  protected: boolean;
  error?: string;
  lastCommitAt?: string;
  consecutiveFailures: number;
}

export interface DaemonHealth {
  host: string;
  label?: string;
  connected: boolean;
}

/** Where the active Bedrock credential was resolved from. Mirrors the server's CredentialSource. */
export type CredentialSource = 'config' | 'claude-settings' | 'env' | 'aws-files' | 'none';

export interface SystemHealth {
  daemons?: DaemonHealth[];
  /** True when the Claude Code CLI is available to the server (coding sessions work). */
  claudeCliAvailable?: boolean;
  /** True when at least one AI provider has a usable credential (the butler can talk). */
  hasReadyProvider?: boolean;
  /** Where the active Bedrock credential came from (for the onboarding "auto-detected" note). */
  credentialSource?: CredentialSource;
  /** Short human-readable provenance, e.g. "AWS_BEARER_TOKEN_BEDROCK" or "profile: dev". */
  credentialDetail?: string;
}

const defaultHealth: SystemHealth = {};

const defaultGitSync: GitSyncHealth = {
  protected: true,
  consecutiveFailures: 0,
};

export function useSystemHealth() {
  const [health, setHealth] = useState<SystemHealth>(defaultHealth);
  const [gitSync, setGitSync] = useState<GitSyncHealth>(defaultGitSync);
  const [loading, setLoading] = useState(true);

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
  const hasIssues = gitSyncFailing;

  // Setup is "complete" once the butler has a provider AND the CLI is present.
  // Fields are optional on the wire; treat undefined as "not yet known" → not complete,
  // so the banner can appear on first load rather than flashing complete-then-incomplete.
  const setupComplete = health.claudeCliAvailable === true && health.hasReadyProvider === true;

  return { health, gitSync, hasIssues, loading, setupComplete };
}
