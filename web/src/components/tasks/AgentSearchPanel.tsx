/**
 * AgentSearchPanel — the ✦ AI section above the normal search results.
 * A one-shot claude -p run searches tasks AND session transcripts server-side,
 * so a task whose own title/note say nothing (placeholder "Session: …" tasks)
 * is still findable through its transcript evidence.
 *
 * All model-derived strings render as React text children (auto-escaped) —
 * no markdown, no dangerouslySetInnerHTML, no injection surface.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { peekAgentSearch, type AdoptSearchSessionOptions } from '@/api/agentSearch';
import { isAgentSearchEligible } from '@/hooks/agentSearchTrigger';
import { useAgentTaskSearch } from '@/hooks/useAgentTaskSearch';
import { useEvent } from '@/hooks/useWebSocket';
import { ICON_CHAT } from '@/components/common/Icons';
import { AgentSearchFollowUp } from './AgentSearchFollowUp';
import { AgentSearchResultRows } from './AgentSearchResultRows';
import { buildSearchSessionMessage } from './agent-search-session';

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
          // A new search proves the earlier "writing answer…" was just the
          // model's preamble text before its tool calls, not the real answer —
          // drop the stale line so the timeline reads in order.
          return [...prev.filter((e) => e.kind !== 'answering'), { key: `s:${evt.q}`, kind: 'search', q: evt.q }];
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

/**
 * "Open as session": one click turns this search into a conversation. The AI
 * lane IS a claude session, so the owner reopens THAT one (the answer is
 * already in it — nothing re-runs) and only falls back to starting a fresh
 * session when there is none to reopen. Disabled while the round-trip is in
 * flight, so a double click cannot mint two sessions; the column the owner
 * opens is the visible feedback, this label only covers the beat before it.
 */
function OpenSessionButton({ launching, live, onClick }: { launching: boolean; live: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="agent-search-open-session"
      data-testid="agent-search-open-session"
      disabled={launching}
      aria-busy={launching || undefined}
      title={live
        // With the small window open, this conversation is already on screen —
        // the button's job changed to "give it the whole column".
        ? 'Open this conversation in a full session column'
        : 'Continue this search as a conversation: opens the session that ran it, with its answer already there, so you can just ask follow-up questions'}
      onClick={onClick}
    >
      <span className="agent-search-open-session-icon" aria-hidden="true">{ICON_CHAT}</span>
      {/* The label ellipsizes at the task panel's narrowest width; the icon and
          the title never go away, so the control stays usable and explained. */}
      <span className="agent-search-open-session-label">
        {launching ? 'Opening…' : live ? 'Open full session' : 'Open as session'}
      </span>
    </button>
  );
}

export function AgentSearchPanel({ query, onOpenTask, onOpenSession }: {
  query: string;
  onOpenTask: (taskId: string) => void;
  /** Continue `query` as a conversation. The owner first tries to REOPEN the
   *  session the AI lane ran the search in (its answer is already there);
   *  `message` is the briefing for the fallback, when there is no such session
   *  to reopen (lane off, failed, or its run has aged out). The returned promise
   *  settles when the round-trip lands, either way; absent = no button. */
  onOpenSession?: (message: string, query: string, opts: AdoptSearchSessionOptions) => Promise<void> | void;
}) {
  const { state, data, sid, enabled, toggle, retry } = useAgentTaskSearch(query);
  const progress = useAgentProgress(sid);

  const [launching, setLaunching] = useState(false);
  // The card unmounts when the search box empties; a launch still in flight
  // then has no button left to re-enable (React ignores the set, but be explicit).
  // Set in the effect BODY too: StrictMode runs mount → cleanup → mount, and a
  // ref only cleared in the cleanup would stay false for the card's whole life.
  // NOTE: `launching` guards the BUTTON only, and a remount resets it — the
  // launch itself is latched by the owner (MainPage), which is the only thing a
  // clear-and-retype cycle cannot reset.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Read at click time, not captured: the button's identity must not change on
  // every progress tick (it sits in the header of a re-rendering card).
  const latest = useRef({ query, state, onOpenSession, enabled, sid });
  latest.current = { query, state, onOpenSession, enabled, sid };
  const openSession = useCallback(() => {
    const { query: q, state: s, onOpenSession: open, enabled: on, sid: progressId } = latest.current;
    if (!open) return;
    // Only a FINISHED search's rows ride along, and they are read back from the
    // memo BY QUERY (`peekAgentSearch`) rather than taken from `data`: that pairs
    // the rows with the question being sent, instead of trusting that the panel's
    // last snapshot still describes the text now in the box. A miss (evicted
    // entry, unfinished search) just sends the briefing without candidates.
    // Built BEFORE the button is disabled, so a throw in here cannot strand it
    // in its "Opening…" state. Only the FALLBACK path sends it: when the lane's
    // own session can be reopened, that conversation already holds the question.
    const message = buildSearchSessionMessage(q, s === 'done' ? peekAgentSearch(q) : undefined);
    // `search` is the human's own switch, forwarded: with the lane ON the server
    // may run the search this press needs (the lane's 1s debounce means a fast
    // click has nothing to reopen yet); with it OFF, or after it failed, the
    // press must not spend a model run behind that choice — it launches a session
    // instead. `progressId` is the lane's, so a search started by this press
    // still shows its live lines in this very card.
    const searchOpts = { search: on && s !== 'error', ...(progressId ? { progressId } : {}) };
    setLaunching(true);
    Promise.resolve()
      .then(() => open(message, q, searchOpts))
      .catch(() => { /* the owner reports the failure in its pending column */ })
      .finally(() => { if (mountedRef.current) setLaunching(false); });
  }, []);
  // Eligibility gates the button as well as the lane. Without it the OFF branch
  // (which renders for any non-empty query, not just a searchable one) offered to
  // spend a whole session on a one-character search box.
  // The follow-up window's session, once one is open. While it is, the card's own
  // rows step aside: the transcript in the window renders the SAME answer card
  // (AgentSearchResultRows) as its second message, so keeping both would show the
  // same rows twice in a panel this narrow.
  const [followUpSessionId, setFollowUpSessionId] = useState<string | null>(null);
  const openButton = onOpenSession && isAgentSearchEligible(query)
    ? <OpenSessionButton launching={launching} live={!!followUpSessionId} onClick={openSession} />
    : null;

  if (state === 'hidden' && enabled) return null;

  if (!enabled) {
    return (
      <section className="agent-search-panel is-off" data-testid="agent-search-panel">
        <button type="button" className="agent-search-toggle agent-search-enable" onClick={toggle}>
          ✦ Enable AI search
        </button>
        {openButton && <span className="agent-search-actions">{openButton}</span>}
      </section>
    );
  }

  // Done with zero results used to render nothing (the AI adds no noise when it
  // has nothing to add). It keeps the ONE header line now, because that is
  // exactly when a full session is the way forward — the rows stay absent.
  const noMatches = state === 'done' && (data?.results.length ?? 0) === 0;

  return (
    <section className={`agent-search-panel is-${state}`} data-testid="agent-search-panel">
      <header className="agent-search-header">
        <span className="agent-search-badge" aria-hidden="true">✦</span>
        <span className="agent-search-label">AI search</span>
        {state === 'loading' && <ElapsedHint />}
        {/* Own class, not the loading ticker's: a locator for one must never
            match the other. */}
        {noMatches && <span className="agent-search-empty-note">no matches</span>}
        <span className="agent-search-actions">
          {state === 'done' && data && (
            <span className="agent-search-model" title={`${data.model} · ${data.tookMs}ms${data.cached ? ' · cached' : ''}`}>
              {shortModel(data.model)}
            </span>
          )}
          {openButton}
          <button
            type="button"
            className="agent-search-toggle"
            aria-pressed={enabled}
            title="Turn off AI search"
            onClick={toggle}
          >✦</button>
        </span>
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
      {state === 'done' && data && !noMatches && !followUpSessionId && (
        <>
          {data.summary && <p className="agent-search-summary">{data.summary}</p>}
          {/* Shared with the transcript card (AgentSearchResultRows): the same
              answer renders identically wherever it is read back. */}
          <AgentSearchResultRows rows={data.results} onOpenTask={onOpenTask} />
        </>
      )}
      {/* Ask right here. Only once the search is DONE: before that there is no
          answer to follow up ON, and the header's button already covers "take me
          to the conversation now". A no-match search keeps it — that is exactly
          when asking is the way forward. */}
      {state === 'done' && onOpenSession && isAgentSearchEligible(query) && (
        <AgentSearchFollowUp
          query={query}
          searchEnabled={enabled}
          {...(sid ? { progressId: sid } : {})}
          onLive={setFollowUpSessionId}
          onOpenTask={onOpenTask}
        />
      )}
    </section>
  );
}
