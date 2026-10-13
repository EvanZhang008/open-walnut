import type { ReactNode } from 'react';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { useForegroundActive, useLiveTasksForSession } from '@/stores/background-agents-store';
import { openBackgroundPanel } from '@/stores/background-panel-store';
import { backgroundAgentsOnly } from './background-ledger';
import '@/styles/session-working.css';

export function SessionWorkingIndicator({ sessionId, children }: {
  sessionId: string;
  children?: ReactNode;
}) {
  const status = useSessionStatus(sessionId);
  const foregroundActive = useForegroundActive(sessionId);
  const tasks = useLiveTasksForSession(sessionId);
  const agents = backgroundAgentsOnly(tasks);
  const backgroundOnly = status?.process_status === 'running' && !status.archived
    && !status.pendingPermissionTool && foregroundActive === false && agents.length > 0;

  if (!backgroundOnly) return children;
  return (
    <button
      type="button"
      className="session-working-indicator session-background-working"
      onClick={() => openBackgroundPanel(sessionId, agents[0].taskId)}
      title="Open running background agents"
    >
      <span className="session-working-label">
        {agents.length === 1 ? '1 subagent is working…' : `${agents.length} subagents are working…`}
      </span>
      <span aria-hidden="true">›</span>
    </button>
  );
}
