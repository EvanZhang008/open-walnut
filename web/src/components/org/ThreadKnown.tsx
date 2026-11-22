/**
 * What holds a card he acknowledged once it was placed in Working or Waiting (experiment
 * ack_means_known, core/org/thread-known.ts), in place of its summary, under the line saying where
 * it went and why. Each task still working on its subject, or waiting (on what, until when), with
 * its status dot and what it is to finish; his reply on its way; a decision letter. One Walnut
 * placed with nothing holding it any more closes in a few minutes unless the node has something new.
 */
import { useMemo } from 'react';
import type { Task } from '@open-walnut/core';
import type { OrgThread } from '@/api/org-threads';
import { placedSinceAck } from '@open-walnut/thread-groups';
import { AgentText } from '@/components/common/AgentText';
import { taskTextSource } from '@/utils/agent-text-source';
import { TaskChip } from './ThreadTaskChips';

/** "Nov 21, 9:00 AM": when a wait ends. */
const untilWords = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export function KnownBlock({ t, tasks, name }: { t: OrgThread; tasks: readonly Task[]; name: string }) {
  const byId = useMemo(() => new Map(tasks.map((x) => [x.id, x] as const)), [tasks]);
  const w = t.awaits;
  // An older server sends no `awaits`: the thread's own task list says what it went to.
  const waits: NonNullable<OrgThread['awaits']>['tasks'] = w ? w.tasks : (t.tasks ?? []).map((id) => ({ id, title: byId.get(id)?.title ?? id }));
  const placed = placedSinceAck(t);
  // Only one Walnut placed settles by itself; one the node placed is the node's to move.
  const ended = placed?.by === 'walnut' && !!w && !w.tasks.length && !w.replies && !w.letter;
  const working = placed?.to === 'working';
  return (
    <div className="org-thread-known" data-testid="org-thread-known" data-ended={ended ? 'true' : undefined} data-placed={placed?.to}>
      {ended && <p className="org-thread-known-lead">{`Its work is over; it closes in a few minutes unless ${name} has something new for you.`}</p>}
      {!ended && waits.map((x) => (
        <div key={x.id} className="org-thread-known-wait" data-testid="org-thread-known-wait" data-task-id={x.id}>
          <p>
            {working ? 'Still in work: ' : 'Waiting on '}<TaskChip id={x.id} task={byId.get(x.id)} fallback={x.title} />
            {/* What it waits on is the task's own words: they open from the session that wrote them. */}
            {x.waitingOn && <>{': '}<AgentText text={x.waitingOn} inline shortLinks {...taskTextSource(byId.get(x.id), 'waiting')} testId="org-thread-known-on" /></>}
            {x.until ? `, until ${untilWords(x.until)}` : ''}
          </p>
          {x.what && <p className="org-thread-known-what" data-testid="org-thread-known-what">{x.what}</p>}
        </div>
      ))}
      {!ended && w?.replies && <p data-testid="org-thread-known-reply">Waiting on your reply to reach {name}.</p>}
      {!ended && w?.letter && <p data-testid="org-thread-known-letter">Waiting on the decision its letter asks.</p>}
    </div>
  );
}
