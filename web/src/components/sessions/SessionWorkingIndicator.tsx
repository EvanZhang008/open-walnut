import { WorkingIndicator, type WorkingIndicatorProps } from './StreamingBlockView';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { useBackgroundRunning } from '@/hooks/useBackgroundRunning';
import { useForegroundActive } from '@/stores/background-agents-store';
import { openBackgroundPanel } from '@/stores/background-panel-store';
import { backgroundAgentsOnly, backgroundRunningLabel } from './background-ledger';
import '@/styles/session-working.css';

/**
 * The live-turn line at the end of the chat, and where the session's background work
 * shows (2026-10-26, the user: the Background bar at the top of the session "is too
 * ugly", it belongs with the working line). Three shapes:
 *
 *  - a turn running: its "<engine> is working…" line, with "· 1 subagent running ›"
 *    (or commands) before its clock and token count while anything else runs
 *    (2026-11-14, the user: "这个 subagent 再跑 可以放在 那个token数量的前面吗");
 *  - only subagents running (the turn itself is waiting on them): "2 subagents are
 *    working… ›";
 *  - the turn over, background work still going: one quiet "1 command still running
 *    in the background ›" line in the working line's place.
 *
 * Every one opens the Background tasks panel; the session's ⋮ menu opens it too, also
 * after everything finished.
 */
export function SessionWorkingIndicator({ sessionId, working }: {
  sessionId: string;
  /** The live turn's working line; without it, only the after-turn background line. */
  working?: Omit<WorkingIndicatorProps, 'note'>;
}) {
  const status = useSessionStatus(sessionId);
  const foregroundActive = useForegroundActive(sessionId);
  const { tasks, running } = useBackgroundRunning(sessionId);
  const agents = backgroundAgentsOnly(tasks);
  const backgroundOnly = status?.process_status === 'running' && !status.archived
    && !status.pendingPermissionTool && foregroundActive === false && agents.length > 0;

  if (backgroundOnly) {
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

  const label = backgroundRunningLabel(running);
  if (working) {
    // One wrapper whether or not a note rides it: swapping the element type at this
    // spot remounts the working line and restarts its clock at 0s.
    return (
      <div className="session-working-row">
        <WorkingIndicator {...working} note={label ? <button
          type="button"
          className="session-background-note"
          data-testid="session-background-note"
          onClick={() => openBackgroundPanel(sessionId)}
          title="Open background tasks"
        >
          <span className="session-background-note-sep" aria-hidden="true">·</span>
          {label} running <span aria-hidden="true">›</span>
        </button> : undefined} />
      </div>
    );
  }
  if (!label) return null;
  return (
    <button
      type="button"
      className="session-working-indicator session-background-working session-background-after"
      data-testid="session-background-note"
      onClick={() => openBackgroundPanel(sessionId)}
      title="Open background tasks"
    >
      <span className="session-working-label">{label} still running in the background</span>
      <span aria-hidden="true">›</span>
    </button>
  );
}
