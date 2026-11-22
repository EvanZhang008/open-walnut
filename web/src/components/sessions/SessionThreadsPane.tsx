/**
 * A task's Threads beside its chat (the session split view 'threads'): the user's own requests to
 * it, one thread per subject, the same view and state Main and the leads keep on the Org page
 * (OrgThreads, useOrgThreads). Any task other than Main or a lead keeps them only once the user
 * turned them on in its ⋮ menu (Task.threads_on, src/core/org/keeps-threads.ts; 2026-11-18, the
 * user: "we should be able to enable the thread for a leader, default off ... click the more and
 * select to open").
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import { useTaskStoreActions, useTasksContext } from '@/contexts/TasksContext';
import { useSessionSend } from '@/hooks/useSessionSend';
import type { ImageAttachment } from '@/api/chat';
import { OrgThreads } from '@/components/org/OrgThreads';
import type { OrgThreadsState } from '@/components/org/useOrgThreads';
import { setTaskThreads } from './session-threads-model';
import { FitButton, HeaderFitMore, useHeaderFit } from '@/components/common/HeaderFit';
import { ICON_EYE_OFF } from '@/components/common/Icons';
import '@/styles/session-threads.css';

export function SessionThreadsPane({ task, sessionId, threads, barRightSlot }: {
  task: Task;
  sessionId: string;
  /** The task's threads, read by the panel (its chip counts them too). */
  threads: OrgThreadsState;
  /** Chat segment of the full-width bar (see SessionFileExplorer.barRightSlot). */
  barRightSlot?: ReactNode;
}) {
  const { tasks } = useTasksContext();
  const { send } = useSessionSend(sessionId);
  const store = useTaskStoreActions();
  const [failed, setFailed] = useState(false);
  const barRef = useHeaderFit();
  const [now, setNow] = useState(() => Date.now());
  // "3 min ago" stays true while the pane is open.
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  const followUp = (threadId: string, text: string, images?: ImageAttachment[]) => send(sessionId, text, images, { threadId });
  const turnOff = async () => {
    setFailed(false);
    // The panel closes this view once the task reads off (SessionPanel's threads effect).
    if (!(await setTaskThreads(task.id, false, store))) setFailed(true);
  };
  return (
    <div className="session-threads-pane" data-testid="session-threads-pane">
      <div className="session-threads-bar" ref={barRef} data-fit-header="">
        <span className="session-threads-bar-title" data-fit-title="">Threads</span>
        <span className="session-threads-bar-sub" data-fit-sub="">Your requests to this task, one per subject</span>
        <div className="session-threads-bar-right" data-fit-actions="">
          {failed && <span className="session-threads-error" role="alert">Did not save. Try again.</span>}
          <FitButton icon={ICON_EYE_OFF} label="Turn off" onClick={() => void turnOff()} data-testid="session-threads-off"
            title="Turn off: stop filing your messages to this task as threads" />
          <HeaderFitMore />
          {barRightSlot}
        </div>
      </div>
      <div className="session-threads-body">
        <OrgThreads name={task.title} owner={task} state={threads} tasks={tasks} onFollowUp={followUp} now={now} />
      </div>
    </div>
  );
}
