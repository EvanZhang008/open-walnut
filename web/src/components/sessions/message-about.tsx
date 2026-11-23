/**
 * The tasks a reply in an Org node's chat is about, under it as live pills (src/core/org/message-about.ts;
 * 2026-10-31, the user: Main names the VP and the task, a VP the task and its lead). SessionPanel
 * turns this on for the session of Main or a lead (MessageAboutContext); the row's `about` comes
 * from the history parse, or from the message's own `<walnut-about>` line while the row is fresh.
 * The pills read as the task's live name and status like every other pill.
 */
import { createContext } from 'react';
import { StepIcon } from './StepIcon';
import { disclosureIds, useRowDisclosure } from './row-disclosure';
import { readAboutTag } from '@open-walnut/message-about';
import { useTaskTitle } from '@/components/transfer/TransferLinks';
import '@/styles/message-about.css';
import { taskPath } from '@/utils/task-path';

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
  return <a href={taskPath(id)} className="task-link" data-task-id={id}>{title ?? id}</a>;
}

/**
 * Under a reply in a session's chat the tasks it is about are one folded line, the turn's own
 * small chevron and "About 2 tasks" in its grey, opened to the pills (2026-11-23, the user, by
 * voice: take away the about line, "use the same small arrow" the threads use). `msgId` keeps it
 * open across the reply's redraws (row-disclosure.ts).
 */
export function MessageAboutFold({ ids, msgId }: { ids: readonly string[]; msgId: string | undefined }) {
  const [open, setOpen] = useRowDisclosure(disclosureIds.about(msgId), false);
  if (!ids.length) return null;
  const words = `About ${ids.length} ${ids.length === 1 ? 'task' : 'tasks'}`;
  return (
    <div className="tool-run-row process-fold msg-about-fold" data-testid="msg-about" data-ids={ids.join(',')} data-open={open ? 'true' : 'false'}>
      <button type="button" data-choice-exempt="transcript fold row: the whole row is the button, drawn by the one step-row rule (step-rows.css)" className="tool-run-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`tool-run-chevron process-fold-chevron${open ? ' tool-run-chevron--open' : ''}`}><StepIcon name="chevron" /></span>
        <span className="tool-run-label">{words}</span>
      </button>
      {open && <div className="msg-about-pills msg-about-fold-pills">{ids.map((id) => <AboutPill key={id} id={id} />)}</div>}
    </div>
  );
}

/** The tasks as a labelled line of pills (a thread card's answer, components/org/thread-card-text.tsx). */
export function MessageAbout({ ids }: { ids: readonly string[] }) {
  if (!ids.length) return null;
  return (
    <div className="msg-about" data-testid="msg-about" data-ids={ids.join(',')}>
      <span className="msg-about-label">About</span>
      <span className="msg-about-pills">{ids.map((id) => <AboutPill key={id} id={id} />)}</span>
    </div>
  );
}
