/**
 * AgentSearchPanel — the ✦ AI section above the normal search results.
 * A one-shot claude -p run searches tasks AND session transcripts server-side,
 * so a task whose own title/note say nothing (placeholder "Session: …" tasks)
 * is still findable through its transcript evidence.
 *
 * All model-derived strings render as React text children (auto-escaped) —
 * no markdown, no dangerouslySetInnerHTML, no injection surface.
 */

import { useEffect, useRef, useState } from 'react';
import { useAgentTaskSearch } from '@/hooks/useAgentTaskSearch';
import { useEvent } from '@/hooks/useWebSocket';

/** Elapsed-seconds ticker for the model wait (5-13s is normal). */
function ElapsedHint() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="agent-search-elapsed">{seconds > 2 ? `searching… ${seconds}s` : 'searching…'}</span>;
}

interface ProgressEntry {
  key: string;
  kind: 'seed' | 'search' | 'search_done' | 'answering';
  q?: string;
  count?: number;
}

/** Live mini-session lines: the server streams what the search agent is doing
 *  ('search-agent:progress' WS events keyed by this fetch's sid), so the wait
 *  reads as work happening, not a spinner. */
function useAgentProgress(sid: string | undefined): ProgressEntry[] {
  const [entries, setEntries] = useState<ProgressEntry[]>([]);
  const sidRef = useRef(sid);
  if (sidRef.current !== sid) {
    sidRef.current = sid;
  }
  useEffect(() => { setEntries([]); }, [sid]);
  useEvent('search-agent:progress', (raw) => {
    const evt = raw as { id?: string; kind?: ProgressEntry['kind']; q?: string; count?: number };
    if (!sidRef.current || evt.id !== sidRef.current || !evt.kind) return;
    setEntries((prev) => {
      switch (evt.kind) {
        case 'seed':
          return [...prev, { key: '__seed', kind: 'seed', q: evt.q, count: evt.count }];
        case 'search':
          return [...prev, { key: `s:${evt.q}`, kind: 'search', q: evt.q }];
        case 'search_done': {
          const idx = prev.findIndex((e) => e.key === `s:${evt.q}` && e.kind === 'search');
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], kind: 'search_done', count: evt.count };
            return next;
          }
          return [...prev, { key: `s:${evt.q}`, kind: 'search_done', q: evt.q, count: evt.count }];
        }
        case 'answering':
          return prev.some((e) => e.kind === 'answering') ? prev : [...prev, { key: '__answering', kind: 'answering' }];
        default:
          return prev;
      }
    });
  });
  return entries;
}

function progressLabel(e: ProgressEntry): string {
  if (e.kind === 'answering') return 'writing answer…';
  if (e.kind === 'search') return `searching “${e.q}”…`;
  const hits = typeof e.count === 'number' ? ` · ${e.count} ${e.count === 1 ? 'hit' : 'hits'}` : '';
  return `searched “${e.q}”${hits}`;
}

function shortModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('opus')) return 'opus';
  return model.length > 16 ? `${model.slice(0, 16)}…` : model;
}

export function AgentSearchPanel({ query, onOpenTask }: {
  query: string;
  onOpenTask: (taskId: string) => void;
}) {
  const { state, data, sid, enabled, toggle, retry } = useAgentTaskSearch(query);
  const progress = useAgentProgress(sid);

  if (state === 'hidden' && enabled) return null;
  // Done with zero results renders nothing — the AI adds no noise when it has
  // nothing to add (the normal lane below still shows its own empty state).
  if (state === 'done' && (data?.results.length ?? 0) === 0) return null;

  if (!enabled) {
    return (
      <section className="agent-search-panel is-off" data-testid="agent-search-panel">
        <button type="button" className="agent-search-toggle agent-search-enable" onClick={toggle}>
          ✦ Enable AI search
        </button>
      </section>
    );
  }

  return (
    <section className={`agent-search-panel is-${state}`} data-testid="agent-search-panel">
      <header className="agent-search-header">
        <span className="agent-search-badge" aria-hidden="true">✦</span>
        <span className="agent-search-label">AI search</span>
        {state === 'loading' && <ElapsedHint />}
        {state === 'done' && data && (
          <span className="agent-search-model" title={`${data.model} · ${data.tookMs}ms${data.cached ? ' · cached' : ''}`}>
            {shortModel(data.model)}
          </span>
        )}
        <button
          type="button"
          className="agent-search-toggle"
          aria-pressed={enabled}
          title="Turn off AI search"
          onClick={toggle}
        >✦</button>
      </header>
      {state === 'loading' && progress.length > 0 && (
        <ul className="agent-search-progress" role="status" aria-busy="true" aria-label="AI search in progress">
          {progress.map((e) => (
            <li key={e.key} className={`agent-search-progress-line${e.kind === 'search' || e.kind === 'answering' ? ' is-pending' : ''}`}>
              {progressLabel(e)}
            </li>
          ))}
        </ul>
      )}
      {state === 'loading' && progress.length === 0 && (
        <div className="agent-search-skeleton" role="status" aria-busy="true" aria-label="AI search in progress">
          <span /><span /><span />
        </div>
      )}
      {state === 'error' && (
        <div className="agent-search-error">
          AI search unavailable ·{' '}
          <button type="button" className="agent-search-retry" onClick={retry}>Retry</button>
        </div>
      )}
      {state === 'done' && data && (
        <>
          {data.summary && <p className="agent-search-summary">{data.summary}</p>}
          <ul className="agent-search-results">
            {data.results.map((row) => (
              <li key={row.taskId}>
                <button
                  type="button"
                  className="agent-search-row"
                  data-task-id={row.taskId}
                  onClick={() => onOpenTask(row.taskId)}
                >
                  <span className="agent-search-row-title">{row.title}</span>
                  <span className="agent-search-row-meta">
                    {row.phase}{row.project ? ` · ${row.project}` : ' · Inbox'}
                  </span>
                  {row.evidence && <span className="agent-search-row-evidence">{row.evidence}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
