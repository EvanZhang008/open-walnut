import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { NotificationFixResult } from '@/api/notifications';
import { useNavigate } from 'react-router-dom';
import { getHostFixSnapshot, hostFixTargetKey, runHostFix, subscribeHostFix, type FixTarget } from '@/utils/host-fix-store';
import { openSessionOnHome } from '@/utils/open-session';
import { taskPath } from '@/utils/task-path';
import { openTaskOnHome } from '@/utils/open-session';
import { useLocalAgentBlocked } from '@/utils/local-agent-runnable';

export function HostFixButton({ target, name, onNavigate }: { target: FixTarget; name: string; onNavigate?: (to: string) => void }) {
  const navigate = useNavigate();
  // A repair session runs on Claude Code here: none is offered while it cannot run.
  const agentBlocked = useLocalAgentBlocked();
  const snapshot = useSyncExternalStore(subscribeHostFix, () => getHostFixSnapshot(target), () => getHostFixSnapshot(target));
  const targetKey = hostFixTargetKey(target);
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current++;
    return () => { generation.current++; };
  }, [targetKey]);
  const open = (result: NotificationFixResult) => {
    if (onNavigate) {
      onNavigate(result.sessionId ? `/sessions?id=${encodeURIComponent(result.sessionId)}` : taskPath(result.taskId));
    } else if (result.sessionId) openSessionOnHome(result.sessionId, navigate);
    else openTaskOnHome(result.taskId, navigate);
  };
  const label = snapshot.pending ? 'Starting...' : 'Fix with agent';
  if (agentBlocked && !snapshot.pending) return null;
  return (
    <span className="host-agent-fix">
      <button type="button" tabIndex={0} className="setup-step-btn host-agent-fix-button"
        data-testid="host-agent-fix" aria-label={`${label} for ${name}`} disabled={snapshot.pending}
        onClick={(event) => {
          event.stopPropagation();
          const startedAt = generation.current;
          void runHostFix(target).then((result) => { if (result && generation.current === startedAt) open(result); });
        }}>
        {label}
      </button>
      {snapshot.error && <span className="host-agent-fix-error" role="alert" tabIndex={0}>{snapshot.error}</span>}
    </span>
  );
}
