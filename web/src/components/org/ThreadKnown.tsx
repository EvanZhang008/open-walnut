/**
 * A Known card's body (experiment ack_means_known, core/org/thread-known.ts): he acknowledged it
 * while its work ran, so in place of the summary it says he knows it, what it waits on (each task
 * with its status dot and what it is to finish, from the read's `awaits`), and how it ends: back to
 * To read only with something new for him, otherwise it closes, and his phone does not buzz.
 */
import { useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import type { OrgThread } from '@/api/org-threads';
import { TaskChip } from './ThreadTaskChips';

const ENDS = 'comes back to To read only if there is something new for you; otherwise it closes. Your phone does not buzz.';

export function KnownBlock({ t, tasks, name }: { t: OrgThread; tasks: readonly Task[]; name: string }) {
  const byId = useMemo(() => new Map(tasks.map((x) => [x.id, x] as const)), [tasks]);
  const w = t.awaits;
  // An older server sends no `awaits`: the thread's own task list says what it went to.
  const waits: NonNullable<OrgThread['awaits']>['tasks'] = w ? w.tasks : (t.tasks ?? []).map((id) => ({ id, title: byId.get(id)?.title ?? id }));
  const ended = !!w && !w.tasks.length && !w.replies && !w.letter;
  return (
    <div className="org-thread-known" data-testid="org-thread-known" data-ended={ended ? 'true' : undefined}>
      <p className="org-thread-known-lead">
        {ended ? `You know it. Its work is done; ${name} has a few minutes to tell you anything new.` : 'You know it.'}
      </p>
      {!ended && waits.map((x) => (
        <div key={x.id} className="org-thread-known-wait" data-testid="org-thread-known-wait" data-task-id={x.id}>
          <p>Waiting on <TaskChip id={x.id} task={byId.get(x.id)} fallback={x.title} /> to finish{x.what ? ':' : '.'}</p>
          {x.what && <p className="org-thread-known-what" data-testid="org-thread-known-what">{x.what}</p>}
        </div>
      ))}
      {!ended && w?.replies && <p data-testid="org-thread-known-reply">Waiting on your reply to reach {name}.</p>}
      {!ended && w?.letter && <p data-testid="org-thread-known-letter">Waiting on the decision its letter asks.</p>}
      <p className="org-thread-known-ends" data-testid="org-thread-known-ends">{ended ? `It ${ENDS}` : `When it ends: it ${ENDS}`}</p>
    </div>
  );
}
