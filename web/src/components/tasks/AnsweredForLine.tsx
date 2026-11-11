/**
 * The line a task shows when a lead, VP or Main answered its ask of the user in his place
 * (task_send answers_ask), with Withdraw: the answer is taken back and the ask returns to his
 * Needs you (core/sessions/ask-withdraw.ts; 2026-11-08, the Personal VP's reflection: an answer
 * given on his older words could not be taken back). Two clicks, so a stray one changes nothing.
 */
import { useState } from 'react';
import type { Task } from '@open-walnut/core';
import { withdrawAskAnswer } from '@/api/tasks';
import { AgentText } from '@/components/common/AgentText';
import { taskTextSource } from '@/utils/agent-text-source';
import '@/styles/task-detail-pane.css';

/**
 * Who answered, the ask, and the answer, or null when the task shows no answer given for the user.
 * Kept apart because each has its own writer: the answer's is recorded with it, the ask's is not.
 */
export function answeredForParts(task: Pick<Task, 'user_status'>): { by: string; ask: string; answer: string } | null {
  const us = task.user_status;
  if (!us?.answeredFor) return null;
  const answer = (us.waitingOn ?? '').split(' for you: ')[1]?.trim() ?? '';
  return { by: us.answeredFor.byTitle.replace(/\s+/g, ' ').slice(0, 80), ask: us.answeredFor.ask.replace(/\s+/g, ' ').slice(0, 160), answer };
}

/** Who answered and what, in a line, or '' when the task shows no answer given for the user. */
export function answeredForWords(task: Pick<Task, 'user_status'>): string {
  const p = answeredForParts(task);
  return p ? `${p.by} answered for you "${p.ask}"${p.answer ? `: ${p.answer}` : ''}` : '';
}

/** Withdraw, then a confirm step; `compact` for a row (the Board's Status view). */
export function WithdrawAnswerButton({ taskId, compact = false, onError }: { taskId: string; compact?: boolean; onError?: (message: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const run = async () => {
    setBusy(true);
    try {
      await withdrawAskAnswer(taskId);
      setConfirming(false);
    } catch (err) {
      onError?.(`Could not withdraw the answer: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const cls = `tdp-start-queue-btn${compact ? ' answered-for-btn-compact' : ''}`;
  if (!confirming) {
    return (
      <button type="button" className={cls} disabled={busy} onPointerDown={stop}
        onClick={(e) => { stop(e); setConfirming(true); }} data-testid="answered-for-withdraw"
        title="Take this answer back: the question comes back to your Needs you">
        Withdraw
      </button>
    );
  }
  return (
    <span className="answered-for-confirm" onPointerDown={stop}>
      <button type="button" className={`${cls} tdp-start-queue-now`} disabled={busy}
        onClick={(e) => { stop(e); void run(); }} data-testid="answered-for-withdraw-confirm">
        Back to Needs you
      </button>
      <button type="button" className={cls} disabled={busy}
        onClick={(e) => { stop(e); setConfirming(false); }} data-testid="answered-for-withdraw-cancel">
        Keep
      </button>
    </span>
  );
}

export function AnsweredForLine({ task, onError }: { task: Task; onError?: (message: string) => void }) {
  const p = task.phase === 'COMPLETE' ? null : answeredForParts(task);
  if (!p) return null;
  // The answer opens its paths on its writer's machine; the ask's writer is not kept with the
  // answer, so a path in it asks which machine (never a guess).
  return (
    <div className="tdp-start-queue" data-testid="task-detail-answered-for" role="status">
      <span className="tdp-start-queue-label">Answered for you</span>
      <span className="tdp-start-queue-text">
        {p.by} answered for you &quot;<AgentText compact inline unknownSource text={p.ask} testId="answered-for-ask" />&quot;
        {p.answer && <>: <AgentText compact inline {...taskTextSource(task, 'waiting')} text={p.answer} testId="answered-for-answer" /></>}
      </span>
      <span className="tdp-start-queue-actions"><WithdrawAnswerButton taskId={task.id} onError={onError} /></span>
    </div>
  );
}
