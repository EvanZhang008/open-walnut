/**
 * Compacting a Claude Code session from its panel, without typing /compact: the
 * composer's "+" menu row "Compact context" (any time no turn runs). It sends
 * `/compact` as the user's own message.
 *
 * The rule (2026-11-04, Evan: "compact is user's own decision, only time we can
 * do it auto or warn is the cache almost expired"): Walnut compacts by itself only
 * while the prompt cache is still warm and about to expire, for a session past its
 * threshold (src/core/sessions/idle-compaction.ts). Once the cache has expired it
 * neither compacts nor says anything: a compaction then writes the whole
 * conversation to the cache again (measured on Claude Code 2.1.312), so it saves
 * nothing that time, and whether to compact is the user's call.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { useWalnutCompactingSession, type WalnutCompaction } from '@/stores/idle-compacting-store';
import type { SessionRecord } from '@/types/session';
import type { PlusMenuAction } from '@/components/chat/plus-menu-actions';
import type { PromptCacheFacts } from '../../../../src/core/sessions/prompt-cache';
import { formatContextTokens, newerFacts } from './compact-offer';
import '@/styles/compact-context.css';

export const COMPACT_COMMAND = '/compact';

export const COMPACT_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
  </svg>
);

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

/** Whether one of Walnut's own compactions runs in this session now (web/src/stores/idle-compacting-store.ts). */
export function useIdleCompacting(sessionId: string | null | undefined): boolean {
  return useWalnutCompacting(sessionId) !== null;
}

/** The working line while Walnut compacts a conversation that no longer fits (the same event, `reason: 'context'`). */
export const CONTEXT_COMPACTING_TEXT = 'Walnut is compacting this conversation so it fits again\u2026';

/** Which of Walnut's own compactions runs in the session now, if one does: the working line says which. */
export function useWalnutCompacting(sessionId: string | null | undefined): WalnutCompaction | null {
  return useWalnutCompactingSession(sessionId, true);
}

/** How long a click holds the row off when its turn never shows (a send that failed). */
const REQUEST_HOLD_MS = 30_000;

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
}

export function useCompactContext({ sessionId, session, acp, running, send, historyFacts }: UseCompactContextArgs): CompactContextParts {
  const live = useLivePromptCache(sessionId ?? null);
  // The newer of the two: a compaction brings no live usage after it, so the live facts can still be the
  // ones from before it while the record already says compacted (2026-11-04 review: a second click went out).
  const facts = newerFacts(live, session?.promptCache) ?? historyFacts;
  // Read at click time, so the row keeps its identity while the record re-renders.
  const latest = useRef(send);
  latest.current = send;
  // Clicked, and its turn has not shown yet: the row is off from the click, not from the server's word.
  const [requested, setRequested] = useState(false);
  const sawRun = useRef(false);
  useEffect(() => { setRequested(false); sawRun.current = false; }, [sessionId]);
  useEffect(() => {
    if (!requested) return;
    if (running) sawRun.current = true;
    else if (sawRun.current) { sawRun.current = false; setRequested(false); }
  }, [requested, running]);
  useEffect(() => {
    if (!requested) return;
    const t = setTimeout(() => { sawRun.current = false; setRequested(false); }, REQUEST_HOLD_MS);
    return () => clearTimeout(t);
  }, [requested]);
  const compact = useCallback(() => { setRequested(true); void latest.current(COMPACT_COMMAND); }, []);
  const lane = session?.lane;

  const tokensLine = facts && facts.tokens > 0 ? `${formatContextTokens(facts.tokens)} tokens in context` : undefined;
  // Just compacted, nothing said since: another pass would only summarize the summary.
  const compacted = !!facts?.compactedAt;
  const plusAction = useMemo<PlusMenuAction | undefined>(() => (acp || lane ? undefined : {
    id: 'compact-context',
    label: 'Compact context',
    title: requested
      ? 'Compacting\u2026'
      : running
      ? 'Available when the current turn ends'
      : compacted
        ? 'Already compacted; available again after the next message'
        : `Summarize the conversation so far into a short context (sends ${COMPACT_COMMAND})${tokensLine ? `. ${tokensLine}` : ''}`,
    disabled: requested || running || compacted,
    disabledHint: requested ? 'Compacting' : running ? 'After this turn' : compacted ? 'Just compacted' : undefined,
    icon: COMPACT_ICON,
    onSelect: compact,
  }), [acp, lane, requested, running, compacted, tokensLine, compact]);

  return { plusAction };
}
