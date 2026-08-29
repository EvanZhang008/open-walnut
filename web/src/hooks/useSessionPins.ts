import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { updateSession } from '@/api/sessions';
import type { SessionPinnedMessage } from '@/types/session';
import type { SessionPinsApi } from '@/contexts/SessionPinsContext';
import { log } from '@/utils/log';

/** TOC row budget. Long enough to name the moment, short enough that the
 *  collapsed rail stays a rail. */
const LABEL_MAX = 90;

/** First non-empty line of the message, which is what a human recognizes. */
export function pinLabelFor(text: string | undefined, fallback: string): string {
  const line = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return fallback;
  // Strip the markdown that would render as literal punctuation in a one-line row.
  const plain = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/[*_`]/g, '')
    .trim();
  const label = plain || fallback;
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX)}…` : label;
}

/**
 * Should the record's copy of the pin list replace ours?
 *
 * Before our first local write, always — the record is the only source there is.
 * After it, only when the incoming list still contains every pin we confirmed. The
 * panel's fetch queue routinely holds tens of requests, so a `GET /api/sessions/:id`
 * issued before a pin resolves after it and arrives WITHOUT that pin; adopting it
 * emptied the outline in front of the user (measured — the pins were on disk the
 * whole time and came back on reload). A list that ADDS pins (another tab, another
 * device) is still adopted; one that only removes them waits for a reload, because
 * deleting what the user just made is the worse of the two errors.
 */
export function shouldAdoptServerPins(
  server: SessionPinnedMessage[],
  confirmed: SessionPinnedMessage[],
  wroteLocally: boolean,
): boolean {
  if (!wroteLocally) return true;
  const ids = new Set(server.map((p) => p.msgId));
  return confirmed.every((p) => ids.has(p.msgId));
}

/**
 * Pinned-message state for one session: optimistic locally, persisted on the
 * session record (`PATCH /api/sessions/:id { pinned_messages }`).
 *
 * Optimistic-first is deliberate: pinning is a navigation gesture and must feel
 * instant, and the server answer carries no information the client didn't already
 * have (the client owns the list). A failed write reverts to the last confirmed
 * list rather than leaving a pin that isn't really there.
 *
 * `serverPins` is the record's copy (arriving via the session-status store). It
 * seeds local state and re-syncs when the record changes, under two guards, both
 * of which were live bugs:
 *
 *  - not while a write of ours is in flight (the record still holds the pre-write
 *    list, so adopting it flickers the pin back off);
 *  - once we HAVE written, only adopt a list that still contains every pin we
 *    confirmed. The panel's fetch queue routinely holds tens of requests, so a
 *    `GET /api/sessions/:id` issued before a pin can resolve well after it and
 *    arrive missing that pin — measured: the outline emptied itself in front of the
 *    user (the pins were on disk the whole time and came back on reload). A list
 *    that ADDS pins (another tab, another device) is still adopted; one that only
 *    removes them waits for a reload rather than deleting what the user just made.
 *
 * `listRef` mirrors the newest list because two pin clicks can land in the same
 * render: a `pins` value captured in a closure would make the second write
 * overwrite the first.
 */
export function useSessionPins(sessionId: string, serverPins?: SessionPinnedMessage[]): SessionPinsApi {
  const [pins, setPins] = useState<SessionPinnedMessage[]>(serverPins ?? []);
  const listRef = useRef<SessionPinnedMessage[]>(serverPins ?? []);
  const confirmed = useRef<SessionPinnedMessage[]>(serverPins ?? []);
  const inFlight = useRef(0);
  const wroteLocally = useRef(false);

  const adopt = useCallback((next: SessionPinnedMessage[]) => {
    listRef.current = next;
    setPins(next);
  }, []);

  // Session switch: adopt the new session's list outright (never carry pins across).
  useEffect(() => {
    inFlight.current = 0;
    wroteLocally.current = false;
    confirmed.current = serverPins ?? [];
    adopt(serverPins ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session switch only; the serverPins effect below handles updates
  }, [sessionId]);

  useEffect(() => {
    if (inFlight.current > 0) return;
    const next = serverPins ?? [];
    if (JSON.stringify(next) === JSON.stringify(confirmed.current)) return;
    if (!shouldAdoptServerPins(next, confirmed.current, wroteLocally.current)) {
      log.info('session', 'ignoring a session record whose pin list is behind ours', {
        sessionId, ours: confirmed.current.length, theirs: next.length,
      });
      return;
    }
    confirmed.current = next;
    adopt(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionId only labels the log line
  }, [serverPins, adopt]);

  const persist = useCallback((next: SessionPinnedMessage[]) => {
    adopt(next);
    wroteLocally.current = true;
    inFlight.current += 1;
    updateSession(sessionId, { pinned_messages: next })
      .then(() => { confirmed.current = next; })
      .catch((err) => {
        log.warn('session', 'pin save failed — reverting', { sessionId, error: String(err) });
        adopt(confirmed.current);
      })
      .finally(() => { inFlight.current = Math.max(0, inFlight.current - 1); });
  }, [sessionId, adopt]);

  const pinnedIds = useMemo(() => new Set(pins.map((p) => p.msgId)), [pins]);

  const isPinned = useCallback(
    (msgId: string | undefined) => !!msgId && pinnedIds.has(msgId),
    [pinnedIds],
  );

  const toggle = useCallback<SessionPinsApi['toggle']>((message) => {
    const msgId = message.msgId;
    if (!msgId) return;
    const current = listRef.current;
    if (current.some((p) => p.msgId === msgId)) {
      persist(current.filter((p) => p.msgId !== msgId));
      return;
    }
    const entry: SessionPinnedMessage = {
      msgId,
      label: pinLabelFor(message.text, message.role === 'user' ? 'Your message' : 'Reply'),
      role: message.role,
      ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      pinnedAt: new Date().toISOString(),
    };
    persist([...current, entry]);
  }, [persist]);

  const unpin = useCallback((msgId: string) => {
    const current = listRef.current;
    if (!current.some((p) => p.msgId === msgId)) return;
    persist(current.filter((p) => p.msgId !== msgId));
  }, [persist]);

  return useMemo(() => ({ pins, isPinned, toggle, unpin }), [pins, isPinned, toggle, unpin]);
}
