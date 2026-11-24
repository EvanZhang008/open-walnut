/**
 * Tasks like the one being typed (experiment `project_first_start`): while the person writes a new
 * task, the draft searches the tasks with Walnut's own search, the board's (useTaskSearch, and the
 * board's arrangement: arrangeSearchResults), and lists the few that match over the composer. A
 * click opens that task the way a task reference does (useOpenTask); Shift+Enter opens the first
 * one when its title holds what was typed (a literal hit), and is a new line otherwise. The user,
 * 11-24: "I want this to be abel to serach also, user teh same search of the walniut, also I can
 * click and jump to the task, maybe be shift enter".
 *
 * The first line of the text is the query, from 3 characters on. Literal hits come first and never
 * move when the search answers; its own hits that show the words follow. Hidden (×) until the first
 * line changes.
 */
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { Task } from '@open-walnut/core';
import * as ICONS from '@/components/common/Icons';
import { useTaskListSelect } from '@/contexts/TasksContext';
import { useTaskSearch } from '@/hooks/useTaskSearch';
import { useOpenTask } from '@/hooks/useOpenTask';
import { arrangeSearchResults, taskMatchesLiterally } from '@/components/tasks/search-relevance';
import { projectDisplayName } from '@/utils/project-display';
import { taskStatusLabel } from '@/utils/session-status';
import { log } from '@/utils/log';

/** Rows shown (the list scrolls past them in a short draft). */
const SHOWN = 4;
/** The query starts at this many characters. */
const MIN_CHARS = 3;
const NO_TASKS: readonly Task[] = [];

export interface TaskMatch { id: string; title: string; detail: string; open: boolean; literal: boolean }

/** The first line of the composer text, trimmed: what the search reads. */
export function matchQuery(text: string): string {
  const first = text.split('\n', 1)[0].trim();
  return first.length >= MIN_CHARS ? first : '';
}

/**
 * The tasks to show, by the board's search rules: literal hits (the query in a title, project or
 * tag) first, then the search's hits that show the words, open before done; at most SHOWN.
 */
export function pickMatches(tasks: readonly Task[], query: string, shownIds: readonly string[] | null): TaskMatch[] {
  if (!query) return [];
  const lower = query.toLowerCase();
  const literal = tasks.filter((t) => taskMatchesLiterally(t, lower));
  const literalIds = new Set(literal.map((t) => t.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const server = (shownIds ?? []).flatMap((id) => (literalIds.has(id) ? [] : byId.get(id) ?? []));
  const shown = new Set(shownIds ?? []);
  const { primary } = arrangeSearchResults([...literal, ...server], {
    isOpen: (t) => t.status !== 'done',
    isLiteral: (t) => literalIds.has(t.id),
    showsQuery: (t) => literalIds.has(t.id) || shown.has(t.id),
    titlePosition: (t) => { const i = t.title.toLowerCase().indexOf(lower); return i < 0 ? Infinity : i; },
    completedAt: (t) => t.completed_at,
  }, false);
  return primary.slice(0, SHOWN).map((t) => ({
    id: t.id,
    title: t.title || 'Untitled',
    detail: [t.project ? projectDisplayName(t.project) : '', taskStatusLabel(t)].filter(Boolean).join(' · '),
    open: t.status !== 'done',
    literal: literalIds.has(t.id),
  }));
}

/** The matches for `text`, opening one, and the composer's Shift+Enter (true when it opened one). */
export function useTaskMatches(text: string, on: boolean): {
  matches: TaskMatch[]; strongFirst: boolean; open: (id: string) => void; hide: () => void; shiftEnter: () => boolean;
} {
  const query = on ? matchQuery(text) : '';
  const deferred = useDeferredValue(query);
  const search = useTaskSearch();
  const { setQuery } = search;
  useEffect(() => { setQuery(deferred); }, [deferred, setQuery]);
  const [hidden, setHidden] = useState('');
  const tasks = useTaskListSelect(({ tasks: list }) => list) ?? NO_TASKS;
  const shownIds = useMemo(() => (search.results ? search.results.filter((r) => r.showsQuery).map((r) => r.taskId) : null), [search.results]);
  const all = useMemo(() => pickMatches(tasks, deferred, shownIds), [tasks, deferred, shownIds]);
  const matches = !query || (hidden && hidden === query) ? [] : all;
  const openTask = useOpenTask();
  const open = (id: string) => {
    log.info('draft', 'task matches: opened an existing task', { taskId: id });
    openTask(id);
  };
  // Shift+Enter takes the key only for a strong first match on a one-line text, and only once the
  // list shows this very text (never a row about to change under the finger).
  const strongFirst = !!matches[0]?.literal && !text.includes('\n') && deferred === query;
  return {
    matches, strongFirst, open, hide: () => setHidden(query),
    shiftEnter: () => { if (!strongFirst) return false; open(matches[0].id); return true; },
  };
}

export function DraftTaskMatches({ matches, shiftEnters, onOpen, onHide }: {
  matches: readonly TaskMatch[]; shiftEnters: boolean; onOpen: (id: string) => void; onHide: () => void;
}) {
  if (!matches.length) return null;
  return (
    <div className="draft-v6-matches" role="group" aria-label="Tasks like this" data-testid="draft-v6-task-matches">
      <div className="draft-v6-matches-head" data-fit-header="">
        <span className="draft-v6-matches-title" data-fit-title="">Tasks like this</span>
        {shiftEnters && <span className="wn-key-hint draft-v6-matches-hint"><kbd className="wn-key">⇧Enter</kbd> opens the first</span>}
        <button type="button" className="btn btn-link btn-sm draft-v6-matches-x" aria-label="Hide tasks like this" title="Hide until the first line changes"
          onMouseDown={(e) => e.preventDefault()} onClick={onHide}>{ICONS.ICON_CLOSE}</button>
      </div>
      <div className="draft-v6-matches-list" role="listbox" aria-label="Tasks like this: open one">
        {matches.map((m) => (
          <button key={m.id} type="button" role="option" aria-selected={false} className={`draft-v6-match wn-pick-row${m.open ? '' : ' is-done'}`} data-testid="draft-v6-task-match" data-task-id={m.id}
            title={`Open ${m.title}${m.detail ? ` (${m.detail})` : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onOpen(m.id)}>
            {!m.open && <span className="draft-v6-match-done" aria-label="Done">{ICONS.ICON_CHECK}</span>}
            <span className="draft-v6-match-title wn-title">{m.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
