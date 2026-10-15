/**
 * Task detail's phase choice on a phone (spec 4.2, 4.7 Task detail; C58).
 *
 * The home row's phase circle no longer completes anything on a phone (one
 * tap under the thumb stopped a running session with no undo). Completing
 * lives here: a `Phase` row opens a bottom list of the phases (44 px rows,
 * never a native select). Picking Complete while the task's session is alive
 * asks first, `Complete this task?` / `Its running session stops.`; Cancel
 * sends nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { usePhoneOverlay } from '@/hooks/usePhoneOverlayHistory';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { PhoneConfirmSheet } from '@/components/common/PhoneConfirmSheet';
import { ChevronRightIcon } from '@/components/common/PhoneIcons';
import { PHASE_LABELS, phasePickerChoices, resolveTaskSessionId } from '@/utils/session-status';
import type { TaskPhase } from '@/types/session';
import { log } from '@/utils/log';

export function phaseLabelOf(phase: string | undefined): string {
  return PHASE_LABELS[(phase ?? 'TODO') as TaskPhase] ?? phase ?? 'To Do';
}

/** A live process stops when its task completes: that is what the sheet warns about. */
export function sessionIsAlive(status: { process_status?: string | null } | null | undefined): boolean {
  return status?.process_status === 'running' || status?.process_status === 'idle';
}

const CONFIRM = 'confirm-complete';

export interface PhonePhaseSheetProps {
  task: Task;
  /** Applies the phase (the task store's optimistic setPhase, or the REST call). */
  onSetPhase: (phase: string) => void;
}

export function PhonePhaseSheet({ task, onSetPhase }: PhonePhaseSheetProps) {
  const [listOpen, setListOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const status = useSessionStatus(resolveTaskSessionId(task));
  const alive = sessionIsAlive(status ?? task.session_status);
  const current = task.status === 'done' ? 'COMPLETE' : (task.phase ?? 'TODO');
  const choices = phasePickerChoices(current);
  const pendingRef = useRef<string | null>(null);

  const list = usePhoneOverlay({
    id: 'sheet:phase',
    kind: 'sheet',
    open: listOpen,
    bar: null,
    onClose: () => {
      setListOpen(false);
      // A pick that needs a confirmation opens it once this sheet's entry is gone.
      const next = pendingRef.current;
      pendingRef.current = null;
      if (next === CONFIRM) setConfirmOpen(true);
      else if (next) onSetPhase(next);
    },
  });

  const pick = useCallback((phase: string) => {
    log.info('phone-task-detail', 'phase picked', { taskId: task.id, phase, alive });
    if (phase !== current) pendingRef.current = phase === 'COMPLETE' && alive ? CONFIRM : phase;
    list.close();
  }, [alive, current, list, task.id]);

  useEffect(() => {
    if (!listOpen) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); list.close(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [listOpen, list]);

  return (
    <>
      <button
        type="button"
        className="phone-detail-row phone-phase-row"
        onClick={() => setListOpen(true)}
        aria-haspopup="listbox"
        aria-expanded={listOpen}
        data-testid="phone-phase-row"
      >
        <span className="phone-detail-row-label">Phase</span>
        <span className="phone-detail-row-value">{phaseLabelOf(current)}</span>
        <ChevronRightIcon size={18} />
      </button>
      {listOpen && createPortal(
        <div className="phone-confirm-sheet-root phone-phase-sheet-root" data-testid="phone-phase-sheet">
          <button type="button" className="phone-confirm-sheet-backdrop" aria-label="Close" onClick={() => list.close()} />
          <div className="phone-confirm-sheet phone-phase-sheet" role="listbox" aria-label="Phase">
            <h2 className="phone-confirm-sheet-title">Phase</h2>
            {choices.map((phase) => (
              <button
                key={phase}
                type="button"
                role="option"
                aria-selected={phase === current}
                className={`phone-phase-option${phase === current ? ' is-current' : ''}`}
                onClick={() => pick(phase)}
              >
                {phaseLabelOf(phase)}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
      <PhoneConfirmSheet
        open={confirmOpen}
        name="complete-task"
        title="Complete this task?"
        body="Its running session stops."
        confirmLabel="Complete"
        onConfirm={() => { setConfirmOpen(false); onSetPhase('COMPLETE'); }}
        onCancel={() => setConfirmOpen(false)}
        testId="phone-complete-confirm"
      />
    </>
  );
}
