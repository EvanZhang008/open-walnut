/**
 * Compacting a Claude Code session from its panel, without typing /compact:
 *  · the composer's "+" menu row "Compact context" (any time no turn runs), and
 *  · the cold-cache line above the composer: a big session whose prompt cache
 *    expired offers "Compact first": the next message writes the whole context to
 *    the cache again, and so does a compaction (it never reads the cache, measured
 *    2026-11-04), but after it every message reads the summary (compact-offer.ts
 *    decides when).
 * Both send `/compact` as the user's own message. Walnut compacts idle sessions
 * before their cache expires by itself too (src/core/sessions/idle-compaction.ts);
 * this is for the sessions it did not (a 5-minute cache, an older turn, the
 * setting off).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchConfig } from '@/api/config';
import { useEvent } from '@/hooks/useWebSocket';
import { wsClient } from '@/api/ws';
import type { SessionRecord } from '@/types/session';
import type { PlusMenuAction } from '@/components/chat/plus-menu-actions';
import type { PromptCacheFacts } from '../../../../src/core/sessions/prompt-cache';
import { compactOffer, compactOfferDueAt, formatAgo, formatContextTokens } from './compact-offer';
import '@/styles/compact-context.css';

export const COMPACT_COMMAND = '/compact';
const DISMISS_KEY = (sessionId: string) => `walnut.compactOffer.dismissed.${sessionId}`;

export const COMPACT_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
  </svg>
);

// The idle compaction's threshold from Settings, shared by every panel: read once, again when the
// session config changes.
let minTokens: number | undefined;
let minLoaded = false;
let minInflight: Promise<void> | null = null;
let minBound = false;
const minListeners = new Set<(v: number | undefined) => void>();

function loadMinTokens(): void {
  minInflight ??= fetchConfig()
    .then((c) => {
      minTokens = c.session?.idle_compaction?.min_tokens ?? undefined;
      minLoaded = true;
      for (const l of minListeners) l(minTokens);
    })
    .catch(() => { /* the 200K default stands */ })
    .finally(() => { minInflight = null; });
}

function useCompactMinTokens(): number | undefined {
  const [min, setMin] = useState<number | undefined>(minTokens);
  useEffect(() => {
    minListeners.add(setMin);
    if (!minBound) {
      minBound = true;
      wsClient.onEvent('config:changed', (data: unknown) => {
        const { key } = (data ?? {}) as { key?: string };
        if (!key || key === 'session') loadMinTokens();
      });
    }
    if (!minLoaded) loadMinTokens();
    else setMin(minTokens);
    return () => { minListeners.delete(setMin); };
  }, []);
  return min;
}

function sameFacts(a: PromptCacheFacts | undefined, b: PromptCacheFacts | undefined): boolean {
  return a?.requestAt === b?.requestAt && a?.tokens === b?.tokens && a?.ttlMs === b?.ttlMs && a?.compactedAt === b?.compactedAt;
}

/**
 * The live prompt cache facts of the session (session:usage-update). State changes only when the
 * facts do (a new request, a compaction), not on every usage event of a streaming turn: the panel
 * that holds this hook re-renders on its state.
 */
function useLivePromptCache(sessionId: string | null): PromptCacheFacts | undefined {
  const [facts, setFacts] = useState<PromptCacheFacts | undefined>(undefined);
  useEffect(() => { setFacts(undefined); }, [sessionId]);
  const handler = useCallback((data: unknown) => {
    const d = data as { sessionId?: string; promptCache?: PromptCacheFacts };
    if (!sessionId || d.sessionId !== sessionId || !d.promptCache) return;
    setFacts((prev) => (sameFacts(prev, d.promptCache) ? prev : d.promptCache));
  }, [sessionId]);
  useEvent('session:usage-update', handler);
  return facts;
}

/** The working line while Walnut's own idle compaction runs (session:idle-compaction). */
export const IDLE_COMPACTING_TEXT = 'Walnut is compacting this idle session\u2026';

/**
 * Whether Walnut's idle compaction runs in this session now: the server says when it starts and
 * ends (session:idle-compaction), and the turn's result ends it here too.
 */
export function useIdleCompacting(sessionId: string | null | undefined): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => { setOn(false); }, [sessionId]);
  useEvent('session:idle-compaction', useCallback((data: unknown) => {
    const d = data as { sessionId?: string; active?: boolean };
    if (sessionId && d.sessionId === sessionId) setOn(d.active === true);
  }, [sessionId]));
  // Its result ends it; so does the CLI failing or ending before one.
  const ended = useCallback((data: unknown) => {
    if (sessionId && (data as { sessionId?: string })?.sessionId === sessionId) setOn(false);
  }, [sessionId]);
  useEvent('session:result', ended);
  useEvent('session:error', ended);
  return on;
}

function readDismissed(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  try { return localStorage.getItem(DISMISS_KEY(sessionId)); } catch { return null; }
}

export interface UseCompactContextArgs {
  sessionId: string | undefined;
  session: SessionRecord | null | undefined;
  acp: boolean;
  /** A turn runs (the stream is live). */
  running: boolean;
  /** Sends a message the way the composer does. */
  send: (message: string) => Promise<unknown> | unknown;
  /** Facts read from the loaded history, for a session whose record has none yet. */
  historyFacts?: PromptCacheFacts;
}

export interface CompactContextParts {
  /** The "+" menu row; undefined on an engine without /compact. */
  plusAction?: PlusMenuAction;
  /** The cold-cache line, or null. */
  offer: React.ReactNode;
}

export function useCompactContext({ sessionId, session, acp, running, send, historyFacts }: UseCompactContextArgs): CompactContextParts {
  const live = useLivePromptCache(sessionId ?? null);
  const minTokens = useCompactMinTokens();
  const facts = live ?? session?.promptCache ?? historyFacts;
  const [dismissedFor, setDismissedFor] = useState<string | null>(() => readDismissed(sessionId));
  const [sent, setSent] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setDismissedFor(readDismissed(sessionId)); setSent(null); }, [sessionId]);
  // The turn it started ended: a compaction that landed has no offer anyway, and one stopped
  // halfway offers again (2026-11-04 review: the line was gone until a reload).
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setSent(null);
    wasRunning.current = running;
  }, [running]);

  // Wake when the cache goes cold while the panel stays open.
  const dueAt = compactOfferDueAt(facts, minTokens);
  useEffect(() => {
    if (dueAt == null) return;
    const wait = dueAt - Date.now();
    if (wait <= 0) { setNow(Date.now()); return; }
    const t = setTimeout(() => setNow(Date.now()), Math.min(wait + 500, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [dueAt]);

  // Read at click time, so the row and its callbacks keep their identity while the record re-renders.
  const latest = useRef({ facts, send });
  latest.current = { facts, send };
  const compact = useCallback(() => {
    const f = latest.current.facts;
    if (f) setSent(f.requestAt);
    void latest.current.send(COMPACT_COMMAND);
  }, []);

  const dismiss = useCallback(() => {
    const f = latest.current.facts;
    if (!sessionId || !f) return;
    try { localStorage.setItem(DISMISS_KEY(sessionId), f.requestAt); } catch { /* storage disabled */ }
    setDismissedFor(f.requestAt);
  }, [sessionId]);

  const lane = session?.lane;
  const offer = compactOffer({
    facts, acp, lane, running, minTokens, nowMs: Math.max(now, Date.now()),
    dismissedFor: sent === facts?.requestAt ? facts?.requestAt : dismissedFor,
  });

  // "expired N min ago" keeps counting while the line is up.
  const showing = offer != null;
  useEffect(() => {
    if (!showing) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [showing]);

  const tokensLine = facts && facts.tokens > 0 ? `${formatContextTokens(facts.tokens)} tokens in context` : undefined;
  // Just compacted, nothing said since: another pass would only summarize the summary.
  const compacted = !!facts?.compactedAt;
  const plusAction = useMemo<PlusMenuAction | undefined>(() => (acp || lane ? undefined : {
    id: 'compact-context',
    label: 'Compact context',
    title: running
      ? 'Available when the current turn ends'
      : compacted
        ? 'Already compacted; available again after the next message'
        : `Summarize the conversation so far into a short context (sends ${COMPACT_COMMAND})${tokensLine ? `. ${tokensLine}` : ''}`,
    disabled: running || compacted,
    icon: COMPACT_ICON,
    onSelect: compact,
  }), [acp, lane, running, compacted, tokensLine, compact]);

  const node = offer ? (
    <div className="compact-offer-line" role="status" data-testid="compact-offer">
      <span className="compact-offer-icon" aria-hidden="true">{COMPACT_ICON}</span>
      <span className="compact-offer-body">
        <span className="compact-offer-text">
          <strong>{offer.expiredForMs < 60_000 ? 'Prompt cache just expired.' : `Prompt cache expired ${formatAgo(offer.expiredForMs)} ago.`}</strong>{' '}
          Your next message stores all {formatContextTokens(offer.tokens)} tokens of this conversation in the cache again.
          Compacting first costs about the same once, then every message reads a short summary instead.
        </span>
        <span className="compact-offer-actions">
          <button type="button" className="compact-offer-btn compact-offer-btn-primary" onClick={compact} data-testid="compact-offer-compact">
            Compact first
          </button>
          <button type="button" className="compact-offer-btn" onClick={dismiss} data-testid="compact-offer-dismiss">
            Keep full context
          </button>
        </span>
      </span>
    </div>
  ) : null;

  return { plusAction, offer: node };
}
