/**
 * The ✦ AI search's ANSWER, as a card inside the session that produced it.
 *
 * The search's final reply is a bare JSON object (`{"results":[{"task_id":…}]}`) —
 * that IS its wire format, and the card above the task search consumes it. Once
 * "Open as session" hands the user that conversation, the same object shows up in
 * a chat bubble as raw JSON. So this renders it with the SAME rows the search card
 * uses (AgentSearchResultRows): one answer, one look, wherever it is read.
 *
 * Titles are NOT taken from the transcript. The answer carries task ids and the
 * model's evidence phrase only, exactly so the display comes from the live task
 * table (a title frozen into a transcript goes stale the moment the task is
 * renamed, and Walnut's own rule for these rows is "always from the Task record").
 * Two sources, in this order: the entity-label store paints instantly for any id
 * the loaded task list already knows, then ONE `/api/tasks/bulk` call fills in
 * phase (which the store does not carry) and settles the ids it does not know —
 * a deleted id becomes a visible "no longer exists" row rather than a lie.
 */

import { useEffect, useState } from 'react';
import type { SearchAnswerMessage, SearchAnswerRow } from '@open-walnut/search-transcript';
import { AgentSearchResultRows, type SearchResultRowView } from '@/components/tasks/AgentSearchResultRows';
import { fetchTasksBulk } from '@/api/tasks';
import { lookupTaskLabel } from '@/stores/entity-label-store';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { log } from '@/utils/log';
import '@/styles/search-ask.css';

/** Resolved rows by id-list. A windowed timeline mounts and unmounts the same
 *  message while scrolling; without this every pass would re-issue the call. */
const resolvedCache = new Map<string, Map<string, SearchResultRowView>>();
const inFlight = new Map<string, Promise<void>>();
/** Distinct answers one page life can hold on screen. FIFO, so this can't grow. */
const CACHE_CAP = 50;

/** The route takes a CSV, so an id holding a comma is unrepresentable — and no
 *  real task id has one, so it is a model invention. Refused, not sent. */
const sendable = (id: string): boolean => id.length > 0 && !id.includes(',');

function resolveRows(key: string, ids: readonly string[]): Promise<void> {
  const running = inFlight.get(key);
  if (running) return running;
  const task = (async () => {
    const asked = ids.filter(sendable);
    try {
      const fetched = await fetchTasksBulk(asked, ['title', 'phase', 'project']);
      // Aligned by INDEX, not by id: the route resolves a unique id PREFIX (the
      // model does emit 8-char prefixes) and answers with the RESOLVED id, so an
      // id-keyed lookup would call a resolved row missing. One item per input id
      // is the route's contract; a length mismatch means something changed under
      // us, and then no verdict is better than a wrong one.
      const views = new Map<string, SearchResultRowView>();
      if (fetched.length === asked.length) {
        asked.forEach((id, i) => {
          const row = fetched[i];
          if (!row || row.error) { views.set(id, { taskId: id, missing: true }); return; }
          views.set(id, {
            // The resolved id, so a prefix row's click opens the real task.
            taskId: row.id || id,
            ...(row.title ? { title: row.title } : {}),
            ...(row.phase ? { phase: row.phase } : {}),
            ...(row.project ? { project: row.project } : {}),
          });
        });
      }
      for (const id of ids) if (!sendable(id)) views.set(id, { taskId: id, missing: true });
      resolvedCache.set(key, views);
      if (resolvedCache.size > CACHE_CAP) {
        const oldest = resolvedCache.keys().next().value;
        if (oldest !== undefined) resolvedCache.delete(oldest);
      }
    } catch (err) {
      // No cache entry, so a later mount retries. The rows stay on the
      // entity-store paint (or the bare id), which is degraded but honest —
      // never a spinner, never an error where a result list belongs.
      log.warn('sessions', 'search answer rows: task lookup failed', {
        ids: ids.join(','),
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return task;
}

/**
 * Merge the answer's own rows with whatever the client knows about those ids.
 *
 * Precedence follows the repo's one display rule for entity refs: the CURRENT
 * title from the label store wins (it tracks a rename live), the fetched row is
 * the fallback and the only source for `phase` and for the "gone" verdict — the
 * store not holding an id means unknown (archived, a filtered list), never dead.
 * `evidence` always rides through: it is the model's reason, and it lives in the
 * row's hover title.
 */
function useResolvedRows(rows: readonly SearchAnswerRow[]): SearchResultRowView[] {
  // The store is fed by the loaded task list; re-render when a title changes.
  useEntityLabelsVersion();
  const ids = rows.map((r) => r.taskId);
  // JSON, not a comma join: an id is model text and may legally contain a comma,
  // and a key that cannot be split back is a key that cannot be misread.
  const key = JSON.stringify(ids);
  const [fetched, setFetched] = useState<Map<string, SearchResultRowView> | undefined>(() => resolvedCache.get(key));

  useEffect(() => {
    if (ids.length === 0) return;
    const cached = resolvedCache.get(key);
    if (cached) { setFetched(cached); return; }
    let alive = true;
    void resolveRows(key, ids).then(() => {
      if (alive) setFetched(resolvedCache.get(key));
    });
    return () => { alive = false; };
    // Keyed on `key`, which IS `ids` serialized: a fresh array every render would
    // re-run this effect forever.
  }, [key]);

  const views: SearchResultRowView[] = [];
  // A literal repeat is already gone (parseSearchAnswerMessage); this catches the
  // pair the parser cannot see — an 8-char PREFIX and the full id of the SAME
  // task, which only become equal once the route has resolved them.
  const shown = new Set<string>();
  for (const row of rows) {
    const server = fetched?.get(row.taskId);
    const taskId = server?.taskId ?? row.taskId;
    if (shown.has(taskId)) continue;
    shown.add(taskId);
    const label = lookupTaskLabel(taskId);
    const title = label?.title ?? server?.title;
    const project = label?.project ?? server?.project;
    views.push({
      taskId,
      ...(title ? { title } : {}),
      ...(server?.phase ? { phase: server.phase } : {}),
      ...(project ? { project } : {}),
      ...(row.evidence ? { evidence: row.evidence } : {}),
      ...(server?.missing ? { missing: true } : {}),
    });
  }
  return views;
}

/** Counted from what is RENDERED (plus what was capped), so the header can never
 *  claim a row the list does not show — prefix rows collapse once they resolve. */
function countLabel(shown: number, extra: number): string {
  if (shown === 0) return 'no matches';
  const total = shown + extra;
  return total === 1 ? '1 match' : `${total} matches`;
}

export function SearchAnswerCard({ answer, onOpenTask }: {
  answer: SearchAnswerMessage;
  onOpenTask?: (taskId: string) => void;
}) {
  const rows = useResolvedRows(answer.rows);
  return (
    <section className="session-search-answer" data-testid="session-search-answer">
      <header className="agent-search-header">
        <span className="agent-search-badge" aria-hidden="true">✦</span>
        <span className="agent-search-label">AI search</span>
        <span className="session-search-answer-count">{countLabel(rows.length, answer.extraRows)}</span>
      </header>
      {answer.summary && <p className="agent-search-summary">{answer.summary}</p>}
      {rows.length > 0 && (
        <AgentSearchResultRows
          rows={rows}
          onOpenTask={onOpenTask ?? (() => {})}
          className="session-search-answer-rows"
        />
      )}
      {answer.extraRows > 0 && (
        <p className="session-search-answer-more">
          {`…and ${answer.extraRows} more the answer listed`}
        </p>
      )}
    </section>
  );
}
