import { useState, useEffect } from 'react';
import { useEvent } from '@/hooks/useWebSocket';

interface GitSyncHealth {
  protected: boolean;
  error?: string;
  lastCommitAt?: string;
  consecutiveFailures: number;
}

export function DataSafetyBanner() {
  const [health, setHealth] = useState<GitSyncHealth | null>(null);

  // Fetch initial status on mount
  useEffect(() => {
    fetch('/api/git-sync/status')
      .then((r) => r.json())
      .then((data) => setHealth(data))
      .catch(() => {
        // Server not reachable — don't show banner
      });
  }, []);

  // Listen for real-time updates via WebSocket
  useEvent('git-sync:status', (data) => {
    setHealth(data as GitSyncHealth);
  });

  if (!health) return null;

  // Determine banner state
  const showBanner = !health.protected || health.consecutiveFailures >= 3;
  if (!showBanner) return null;

  const isFailure = health.protected && health.consecutiveFailures >= 3;
  const message = isFailure
    ? 'Data backup failing \u2014 check logs'
    : `Data NOT backed up \u2014 ${health.error ?? 'install git to enable auto-save'}`;

  return (
    <div
      className="data-safety-banner"
      role="alert"
      style={{
        background: isFailure ? '#b91c1c' : '#dc2626',
        color: '#fff',
        padding: '6px 16px',
        fontSize: '13px',
        fontWeight: 600,
        textAlign: 'center',
        lineHeight: '20px',
        flexShrink: 0,
      }}
    >
      {message}
    </div>
  );
}
