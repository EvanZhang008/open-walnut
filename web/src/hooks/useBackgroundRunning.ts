import { useMemo } from 'react';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { useLiveTasksForSession } from '@/stores/background-agents-store';
import { backgroundRunning, type BackgroundRunning } from '@/components/sessions/background-ledger';

const NONE: BackgroundRunning = { agents: 0, commands: 0, other: 0, total: 0 };

/**
 * A session's background ledger and what of it still runs. A CLI that died (stopped,
 * error) or an archived session runs nothing, whatever its last ledger says: the
 * server clears the ledger only on the next spawn, so a Stop or a crash mid-command
 * would otherwise read "1 command still running" until the session runs again.
 */
export function useBackgroundRunning(sessionId: string | undefined): {
  tasks: ReturnType<typeof useLiveTasksForSession>;
  running: BackgroundRunning;
} {
  const tasks = useLiveTasksForSession(sessionId);
  const status = useSessionStatus(sessionId);
  const alive = !!status && !status.archived && status.process_status !== 'stopped' && status.process_status !== 'error';
  const running = useMemo(() => (alive ? backgroundRunning(tasks) : NONE), [alive, tasks]);
  return { tasks, running };
}
