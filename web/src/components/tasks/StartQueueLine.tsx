/**
 * The line a task whose start did not happen shows in its details (2026-11-06, the user: a start
 * that did not start is an error; review round 6): why it did not start (no host had room, the
 * spawn failed), from the server's status (core/user-status.ts), with Start, the user's own
 * start, which never waits for a host slot. A start an older Walnut queued shows the same way,
 * with Start now (its start as asked) and Cancel. Its × hides it until what it says changes
 * (useNoticeDismiss); the start's state is unchanged, and its label says the start stays queued.
 */
import { useState } from 'react';
import type { Task } from '@open-walnut/core';
import { startQueueWords } from '@/utils/start-queue-words';
import { cancelQueuedStart, startQueuedNow, startTaskAsPerson } from '@/api/tasks';
import { NoticeClose } from '@/components/common/NoticeClose';
import { useNoticeDismiss } from '@/utils/notice-dismiss';

/** The status words of a start that did not happen, or ''. */
export function refusedStartWords(task: Pick<Task, 'user_status'>): string {
  const us = task.user_status;
  return us?.state === 'waiting' && us.kind === 'not-started' && us.waitingOn?.startsWith('Did not start') ? us.waitingOn : '';
}

export function StartQueueLine({ task, onError }: { task: Task; onError?: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const q = task.start_queue;
  const refused = q ? '' : refusedStartWords(task);
  const words = !q && !refused ? null : refused || (task.user_status?.kind === 'machine' && task.user_status.waitingOn ? task.user_status.waitingOn : startQueueWords(q!));
  const notice = useNoticeDismiss(`start-queue:${task.id}`, words);
  if (words === null || notice.hidden) return null;
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      onError?.(`Could not ${what}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tdp-start-queue" data-testid="task-detail-start-queue" role="status">
      <span className="tdp-start-queue-label">{refused ? 'Did not start' : 'Waiting for a free slot'}</span>
      <span className="tdp-start-queue-text">{refused ? words.replace(/^Did not start:\s*/, '') : words}</span>
      <span className="tdp-start-queue-actions">
        {refused ? (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => { void act('start it', () => startTaskAsPerson(task.id)); }} data-testid="task-detail-start-refused-start">
            Start
          </button>
        ) : <>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => { void act('start it now', () => startQueuedNow(task.id)); }} data-testid="task-detail-start-queue-now">
            Start now
          </button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { void act('cancel the queued start', () => cancelQueuedStart(task.id)); }} data-testid="task-detail-start-queue-cancel">
            Cancel
          </button>
        </>}
      </span>
      {/* It hides the line, Start now and Cancel with it: the start stays queued, so the label says so. */}
      <NoticeClose onClose={notice.dismiss} label={refused ? 'Hide this line until it says something new: the task stays not started' : 'Hide this line: the start stays queued'}
        testId="task-detail-start-queue-close" className="tdp-start-queue-close" />
    </div>
  );
}
