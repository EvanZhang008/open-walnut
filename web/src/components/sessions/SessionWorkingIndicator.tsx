import { WorkingIndicator, type WorkingIndicatorProps } from './StreamingBlockView';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { useBackgroundRunning } from '@/hooks/useBackgroundRunning';
import { useForegroundActive } from '@/stores/background-agents-store';
import { openBackgroundPanel } from '@/stores/background-panel-store';
import { backgroundAgentsOnly, backgroundRunningLabel } from './background-ledger';
import { useMemo } from 'react';
import { useTaskListSelect } from '@/contexts/TasksContext';
import { useOpenTask } from '@/hooks/useOpenTask';
import { Chip, ChipGroup, DisclosureButton } from '@/components/controls';
import { isBoolean, usePageViewOf } from '@/utils/view-memory';
import { ICON_CHEVRON_RIGHT } from '@/components/common/Icons';
import { workersStartFolded, workersWorkingLabel, workersWorkingOf, type WorkingWorker } from './workers-working';
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
 *    in the background ›" line in the working line's place;
 *  - its task's workers (subtasks) at work: "3 subtasks are working…" with each one, which
 *    opens it, under whichever line shows, its own turn's included, so it never blinks out when
 *    the lead's turn starts; past three it is one folded line (workers-working.ts).
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
  const workers = useWorkersWorking(sessionId);
  const workersRow = workers.length ? <WorkersWorkingRow sessionId={sessionId} workers={workers} /> : null;
  const backgroundOnly = status?.process_status === 'running' && !status.archived
    && !status.pendingPermissionTool && foregroundActive === false && agents.length > 0;

  if (backgroundOnly) {
    const agentsLine = (
      <button
        type="button"
        className="session-working-indicator session-background-working"
        onClick={() => openBackgroundPanel(sessionId, agents[0].taskId)}
        title="Open running background agents"
      >
        <span className="session-working-label">
          {agents.length === 1 ? '1 subagent is working…' : `${agents.length} subagents are working…`}
        </span>
        <span className="wn-dir-mark" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>
      </button>
    );
    return workersRow ? <>{agentsLine}{workersRow}</> : agentsLine;
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
          {label} running<span className="wn-dir-mark" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>
        </button> : undefined} />
        {workersRow}
      </div>
    );
  }
  if (!label) return workersRow;
  const backgroundRow = (
    <button
      type="button"
      className="session-working-indicator session-background-working session-background-after"
      data-testid="session-background-note"
      onClick={() => openBackgroundPanel(sessionId)}
      title="Open background tasks"
    >
      <span className="session-working-label">{label} still running in the background</span>
      <span className="wn-dir-mark" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>
    </button>
  );
  return workersRow ? <>{workersRow}{backgroundRow}</> : backgroundRow;
}

/** The task's workers at work, kept as one string in the list's select so it re-renders only on a change. */
function useWorkersWorking(sessionId: string): WorkingWorker[] {
  const key = useTaskListSelect(({ tasks }) => JSON.stringify(workersWorkingOf(tasks, sessionId))) ?? '[]';
  return useMemo(() => JSON.parse(key) as WorkingWorker[], [key]);
}

function WorkersWorkingRow({ sessionId, workers }: { sessionId: string; workers: WorkingWorker[] }) {
  const openTask = useOpenTask();
  // A long list starts folded; his open or close of it is kept for this session (usePageViewOf).
  const [picked, setPicked] = usePageViewOf<boolean | null>('session', 'workers-open', sessionId, null, (v): v is boolean | null => v === null || isBoolean(v));
  const folds = workersStartFolded(workers.length);
  const open = !folds || (picked ?? false);
  const label = workersWorkingLabel(workers.length);
  // The working line's own row and label; each worker is a one-shot chip (pressed undefined) that opens it.
  // A ChipGroup, so on a phone its wrapped rows sit apart and no chip's 44 px finger target covers
  // the toggle or the chip above (2026-11-25: at 390px the first chip took the tap meant to fold).
  return (
    <ChipGroup className="session-working-row" data-testid="session-workers-working" data-open={open ? 'true' : 'false'}>
      {folds
        ? <DisclosureButton expanded={open} inline data-testid="session-workers-toggle" title={open ? 'Hide the subtasks' : 'Show each subtask'} onClick={() => setPicked(!open)}>
            <span className="session-working-label">{label}</span>
          </DisclosureButton>
        : <span className="session-working-label">{label}</span>}
      {open && workers.map((w) => (
        <Chip key={w.id} pressed={undefined} title={`Open ${w.title}`} trailing={<span className="wn-dir-mark" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>} onClick={() => openTask(w.id)}>
          {w.title}
        </Chip>
      ))}
    </ChipGroup>
  );
}
