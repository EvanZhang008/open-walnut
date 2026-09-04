/**
 * "Quote in session" — the task-menu row that drops a `<task-ref/>` pill for
 * this task into the composer of the CURRENT session (stores/active-session.ts),
 * so a human who spots a task while a session is open can hand it to that
 * session in one click: the pill lands in the input, the human adds their
 * words, Enter sends, and the session's agent gets the reference card with the
 * task's id + title. It never sends by itself.
 *
 * Rendered inside TaskKebabMenu's dropdown (same JSX row shape as its siblings).
 * With no session open the row stays visible but disabled, naming what to do.
 */
import { useNavigate } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { useActiveSessionId } from '@/stores/active-session';
import { lookupSessionTitle } from '@/stores/entity-label-store';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { taskRefTag } from '@/utils/entity-ref-tags';
import { insertIntoSessionComposer } from '@/utils/composer-insert';

const TITLE_MAX = 28;

function shortTitle(title: string): string {
  const t = title.trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

export function QuoteInSessionItem({ task, onDone }: { task: Task; onDone: () => void }) {
  const navigate = useNavigate();
  const sessionId = useActiveSessionId();
  useEntityLabelsVersion(); // re-render when a session title arrives
  const title = sessionId ? lookupSessionTitle(sessionId) : undefined;
  const target = sessionId ? (title ? shortTitle(title) : sessionId.slice(0, 8)) : null;
  return (
    <button
      className="task-kebab-item"
      disabled={!sessionId}
      title={sessionId ? `Insert a reference to this task into the composer of “${title ?? sessionId}”` : 'Open a session first'}
      data-testid="task-quote-in-session"
      onClick={(e) => {
        e.stopPropagation();
        if (!sessionId) return;
        insertIntoSessionComposer(sessionId, `${taskRefTag(task.id, task.title)} `, navigate);
        onDone();
      }}
    >
      <span className="task-kebab-icon">❝</span>
      <span>{target ? <>Quote in <b>{target}</b></> : 'Quote in session'}</span>
    </button>
  );
}
