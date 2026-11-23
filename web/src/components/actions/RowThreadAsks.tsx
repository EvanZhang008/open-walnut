/**
 * What a task row asks of the user, drawn once (2026-11-23, the user, on one question drawn as a
 * thread card and again as a question card, then his pick "两处都改"): a decision one of the task's
 * listed threads holds (the server marks it, `ActionItem.thread`, src/core/org/thread-holds.ts, the
 * same rule as the top above its chat) is one line under the row, "Needs you" and that thread's
 * title, which opens the thread where it is kept, scrolled to and marked (open-thread.ts); what no
 * thread holds (a live prompt, an approval, a letter no thread was opened from) and what he snoozed
 * keep their full card (ActionNeeded), as on every other row. The row reads no Threads of its own.
 *
 * Under experiment threads_one_card ("a task's own question lives on its thread instead of a second
 * card"); off, every row is the card as before.
 */
import type { Task } from '@open-walnut/core';
import { useExperimental } from '@/hooks/useExperimental';
import { useNow } from '@/components/approvals/ApprovalPrompts';
import { rowAsks } from '@/components/org/top-thread-model';
import { useOpenThread } from '@/components/org/open-thread';
import { log } from '@/utils/log';
import { ActionNeeded } from './ActionNeeded';

export function RowAsks({ task }: { task: Task }) {
  const oneCard = useExperimental('threads_one_card');
  const held = (task.user_status?.actions ?? []).some((it) => it.thread);
  if (!oneCard || !held) return <ActionNeeded task={task} />;
  return <RowThreadAsks task={task} />;
}

function RowThreadAsks({ task }: { task: Task }) {
  const now = useNow(30_000);
  const openThread = useOpenThread();
  const all = task.user_status?.actions ?? [];
  const { lines, onCard } = rowAsks(all, now);
  return (
    <>
      {lines.map((t) => (
        <button
          key={t.id}
          type="button"
          className="btn btn-ghost btn-sm btn-block row-thread-ask"
          data-testid="row-thread-ask"
          data-thread-id={t.id}
          title={`Open the thread “${t.title}”`}
          // The row above opens its task on a press; this line opens the thread.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            log.info('row-thread-ask', 'row line opened its thread', { taskId: task.id, threadId: t.id });
            openThread(task.id, t.id);
          }}
        >
          <span className="row-thread-ask-mark wn-fixed">Needs you</span>
          <span className="row-thread-ask-title wn-title">{t.title}</span>
          <span className="row-thread-ask-go wn-fixed" aria-hidden="true">›</span>
        </button>
      ))}
      {all.some(onCard) && <ActionNeeded task={task} accepts={onCard} />}
    </>
  );
}
