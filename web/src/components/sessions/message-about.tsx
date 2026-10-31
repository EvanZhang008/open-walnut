/**
 * The tasks a reply in an Org node's chat is about, under it as live pills (src/core/org/message-about.ts;
 * 2026-10-31, the user: Main names the VP and the task, a VP the task and its lead). SessionPanel
 * turns this on for the session of Main or a lead (MessageAboutContext); the row's `about` comes
 * from the history parse, or from the message's own `<walnut-about>` line while the row is fresh.
 * The pills read as the task's live name and status like every other pill.
 */
import { createContext } from 'react';
import { readAboutTag } from '@open-walnut/message-about';
import { useTaskTitle } from '@/components/transfer/TransferLinks';
import '@/styles/message-about.css';

/** True inside the chat of Main or a lead: replies show the tasks they are about. */
export const MessageAboutContext = createContext(false);

/** The ids a row is about: the parse's, else its own line's. */
export function rowAbout(about: readonly string[] | undefined, rawText: string | undefined): string[] {
  return about?.length ? [...about] : readAboutTag(rawText).ids;
}

/**
 * One task pill, as React elements: an innerHTML pill is rebuilt whenever the label store moves, and
 * one rebuilt between a press and its release loses the click (2026-10-31: the press landed on a
 * pill that was gone by the release). The status dot is stamped in place (utils/task-pill-status.ts);
 * the click rides the message's own entity handler (useEntityClickHandler), like every chat pill.
 */
function AboutPill({ id }: { id: string }) {
  const title = useTaskTitle(id);
  return <a href={`/tasks/${encodeURIComponent(id)}`} className="task-link" data-task-id={id}>{title ?? id}</a>;
}

export function MessageAbout({ ids }: { ids: readonly string[] }) {
  if (!ids.length) return null;
  return (
    <div className="msg-about" data-testid="msg-about" data-ids={ids.join(',')}>
      <span className="msg-about-label">About</span>
      <span className="msg-about-pills">{ids.map((id) => <AboutPill key={id} id={id} />)}</span>
    </div>
  );
}
