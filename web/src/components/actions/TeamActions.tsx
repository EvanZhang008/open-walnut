/**
 * "From your team" at the top of a VP's Threads (experiment action_needed_everywhere; 2026-11-19,
 * the user: "thread 里面也可以加……这些 task 本身的……需要我 make decision 的"). One card per team
 * task that asks the user something now, with its Action needed block: the same items as its row,
 * answered and snoozed the same way, so an answer here takes it off the row and the session strip.
 * Nothing new is stored and nothing is counted again (the node's Needs you count already holds them).
 */
import type { Task } from '@open-walnut/core';
import { USER_STATE_LABELS } from '@open-walnut/user-status';
import { userStateOf } from '@open-walnut/org-tree';
import { useOpenTask } from '@/hooks/useOpenTask';
import { ActionNeeded } from './ActionNeeded';
import './action-needed.css';

export function TeamActions({ tasks }: { tasks: readonly Task[] }) {
  const openTask = useOpenTask();
  if (!tasks.length) return null;
  return (
    <section className="team-actions" data-testid="team-actions" aria-label="From your team">
      <div className="team-actions-title">From your team · {tasks.length}</div>
      {tasks.map((t) => (
        <div key={t.id} className="team-actions-task" data-testid="team-actions-task" data-task-id={t.id}>
          <div className="team-actions-head" data-peek-row="">
            <button type="button" className="team-actions-name" data-testid="team-actions-open" onClick={() => openTask(t.id)}>{t.title}</button>
            {t.user_status?.working ? <span className="team-actions-state">Working</span>
              : <span className="team-actions-state">{USER_STATE_LABELS[userStateOf(t)]}</span>}
          </div>
          <ActionNeeded task={t} variant="card" />
        </div>
      ))}
    </section>
  );
}
