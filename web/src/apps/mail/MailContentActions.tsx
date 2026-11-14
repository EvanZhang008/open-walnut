/**
 * What the Mail reader offers on the open message: Talk to CEO and New task, the two content actions
 * every surface in Walnut offers (utils/content-actions.ts), plus the task an older Walnut made from
 * this message, when there is one.
 *
 * The pill carries the same MARKUP the rest of Walnut uses (`a.task-link` + `data-task-id`, labelled
 * from the shared entity-label store), for a reason worth stating: a second pill invented here would
 * drift in wording, in colour and in what a click does. The chip's LOOK is restated in mail.css,
 * because the shared rules are scoped to `.markdown-body a.task-link` and this reader is not a
 * markdown container.
 *
 * The click is handled here rather than by the shared delegation hook, because there is no markdown
 * container in the reader to delegate from: one anchor, one handler, and `href` kept honest so the
 * middle click and the context menu still do the right thing.
 */
import { useEffect, type MouseEvent } from 'react';
import { useTaskLabel } from '@/hooks/useEntityLabels';
import { lookupTaskLabel } from '@/stores/entity-label-store';
import { ContentActionButtons } from '@/components/content/ContentActionButtons';
import { taskPath } from '@/utils/task-path';
import { useOpenTask } from '@/hooks/useOpenTask';
import { bodyQuoteText } from './mail-quote-text';
import { mailContentItem } from './mail-content-item';
import type { MailOpenMessage } from './mail-store';

export function MailContentActions({ open }: { open: MailOpenMessage }) {
  const message = open.message;
  if (!message) return null;
  return (
    <div className="mail-task-slot">
      {message.taskId && <MailTaskPill taskId={message.taskId} />}
      <ContentActionButtons
        item={mailContentItem(message, bodyQuoteText(open.body))}
        size="compact"
        className="mail-content-actions"
        buttonClassName="mail-round-btn"
      />
    </div>
  );
}

function MailTaskPill({ taskId }: { taskId: string }) {
  const openTask = useOpenTask();
  const label = useTaskLabel(taskId);
  /*
   * Make the title arrive.
   *
   * `useTaskLabel` reads the label store without OBSERVING the id, and the store deliberately stays
   * quiet for ids nothing has claimed to be rendering, so without this call the raw id would sit
   * here until something unrelated re-rendered the reader. `lookupTaskLabel` is the observing half.
   *
   * In an effect rather than in render: the lookup mutates the store's observed set, and a store
   * write during render is a render-phase update.
   */
  useEffect(() => { lookupTaskLabel(taskId); }, [taskId]);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    // A plain left click opens the task on Home; anything with a modifier is the human asking
    // for a new tab, and the href is already right for that.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    openTask(taskId);
  };
  return (
    <a
      className="task-link mail-task-pill"
      data-testid="mail-task-pill"
      data-task-id={taskId}
      href={taskPath(taskId)}
      title={label?.project ? `${label.project} / ${label.title}` : taskId}
      onClick={open}
    >
      {label?.title ?? taskId}
    </a>
  );
}
