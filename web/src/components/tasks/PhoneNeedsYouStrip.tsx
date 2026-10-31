/**
 * The phone home's first rows: the open tasks that wait on the user (N2-13,
 * spec US5). The stacked home leads with Pinned and a column of collapsed
 * projects, so on a phone with nothing pinned the first screen held no task
 * at all, and work that needed the user sat two or three taps deep. This strip
 * lists that work above everything else, whatever is expanded.
 *
 * - Same rule as the row badges (needs-you.ts): NEED_ACTION, or a session
 *   blocked on a prompt right now.
 * - At most three rows until "Show all"; the order holds under the thumb
 *   (useStableOrder), newest first.
 * - A tap opens the row the way a home row does (its session, else its
 *   detail). Renders nothing on the desktop or when nothing needs the user.
 */
import { useMemo, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { sessionStatusStore } from '@/stores/session-status-store';
import { resolveTaskSessionId } from '@/utils/session-status';
import { taskNeedsYou } from './needs-you';
import { taskWaitsOnPrompt } from './PhoneRowExtras';
import { homeListScroller } from './phone-row-behavior';
import { useStableOrder } from './useStableOrder';
import { stateCountLabel } from '@open-walnut/user-status';

const FIRST_ROWS = 3;
const taskKey = (t: Task) => t.id;

function updatedAt(t: Task): number {
  const v = Date.parse((t as { updated_at?: string }).updated_at ?? '');
  return Number.isFinite(v) ? v : 0;
}

/** What the row says under its title: the prompt's tool when one waits. */
export function needsYouReason(task: Task): string {
  const sid = resolveTaskSessionId(task);
  const tool = sid ? sessionStatusStore.getStatus(sid)?.pendingPermissionTool : null;
  return tool && taskWaitsOnPrompt(task) ? `Needs you: ${tool}` : 'Needs you';
}

export function PhoneNeedsYouStrip({ tasks, onOpen }: { tasks: readonly Task[]; onOpen: (task: Task) => void }) {
  const phone = usePhoneLayout();
  const epoch = useSessionStatusEpoch();
  const [all, setAll] = useState(false);
  const live = useMemo(
    () => (phone ? tasks.filter((t) => taskNeedsYou(t, { isWaiting: taskWaitsOnPrompt })).sort((a, b) => updatedAt(b) - updatedAt(a)) : []),
    // epoch: a prompt that starts or ends waiting changes the set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phone, tasks, epoch],
  );
  const list = useStableOrder(live, taskKey, { enabled: phone, getScroller: homeListScroller });
  if (!phone || list.length === 0) return null;
  const shown = all ? list : list.slice(0, FIRST_ROWS);
  const rest = list.length - shown.length;
  return (
    <section className="phone-needs-you" aria-labelledby="phone-needs-you-heading" data-testid="phone-needs-you">
      <h2 id="phone-needs-you-heading" className="phone-needs-you-heading">
        {/* The count says what it counts: tasks, not notifications (N2-05). */}
        {stateCountLabel('needs', list.length)}
      </h2>
      <ul className="phone-needs-you-list">
        {shown.map((t) => (
          <li key={t.id}>
            <button type="button" className="phone-needs-you-row" data-needs-you-id={t.id} onClick={() => onOpen(t)}>
              <span className="phone-needs-you-title">{t.title || 'Untitled task'}</span>
              <span className="phone-needs-you-meta">
                <span className="phone-needs-you-reason">{needsYouReason(t)}</span>
                {t.project ? <span className="phone-needs-you-project">{t.project}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {(rest > 0 || all) && list.length > FIRST_ROWS && (
        <button type="button" className="phone-needs-you-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}
    </section>
  );
}
