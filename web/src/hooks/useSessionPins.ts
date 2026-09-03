import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { updateSession } from '@/api/sessions';
import type { SessionPinnedMessage, SessionPinnedQuote } from '@/types/session';
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

/** NUL, the one separator that cannot appear inside a msgId or a passage. */
const PIN_KEY_SEP = '\u0000';

/**
 * The one identity of a pin, everywhere: its own `id` when it has one (quote
 * pins), else its msgId (whole-message pins, including every record written
 * before quote pins existed).
 *
 * A message can now hold several pins, so msgId alone stopped identifying a row:
 * keying the TOC or an unpin on it would remove the wrong passage.
 *
 * ⚠️ A quote pin with NO `id` still has to get its own key. This client always
 * mints one, but `pinned_messages` is a plain PATCH field, so anything else that
 * writes the session record (a script, a plugin, an older or future client) can
 * store a passage without an id — and the server accepts it. Falling through to
 * msgId there made every passage on one message share the whole-message pin's
 * key: measured on the fixture session, two id-less passages produced duplicate
 * React keys, only ONE of the two got painted, and removing either outline row
 * deleted BOTH pins. The passage itself is the identity in that case.
 */
export function pinKeyOf(pin: SessionPinnedMessage): string {
  if (pin.id) return pin.id;
  // NUL-joined, the same key shape the server uses to dedup them
  // (session-lifecycle.ts): any separator that can legally appear inside a msgId
  // or a passage would let two different pins collapse onto one key.
  if (pin.quote?.exact) {
    return [pin.msgId, pin.quote.exact, pin.quote.prefix ?? '', pin.quote.suffix ?? ''].join(PIN_KEY_SEP);
  }
  return pin.msgId;
}

/** Same passage in the same message = the same pin (a double-clicked "Pin"
 *  generates two uuids but must not make two identical outline rows). */
function sameQuote(a: SessionPinnedMessage, msgId: string, quote: SessionPinnedQuote): boolean {
  return !!a.quote && a.msgId === msgId
    && a.quote.exact === quote.exact
    && (a.quote.prefix ?? '') === (quote.prefix ?? '')
    && (a.quote.suffix ?? '') === (quote.suffix ?? '');
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
  const keys = new Set(server.map(pinKeyOf));
  return confirmed.every((p) => keys.has(pinKeyOf(p)));
}

/** Pin identity for a new quote pin. `crypto.randomUUID` needs a secure context
 *  (localhost counts), so a plain-http host falls back to a random string of the
 *  same shape rather than losing the whole feature. */
function newPinId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `qp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

  // WHOLE-message pins only: the meta-row icon must not read as "pinned" because
  // some phrase inside the message is pinned (pressing it would then unpin a
  // passage the user never aimed at).
  const pinnedIds = useMemo(
    () => new Set(pins.filter((p) => !p.quote).map((p) => p.msgId)),
    [pins],
  );

  const isPinned = useCallback(
    (msgId: string | undefined) => !!msgId && pinnedIds.has(msgId),
    [pinnedIds],
  );

  const toggle = useCallback<SessionPinsApi['toggle']>((message) => {
    const msgId = message.msgId;
    if (!msgId) return;
    const current = listRef.current;
    if (current.some((p) => !p.quote && p.msgId === msgId)) {
      // Only the whole-message pin goes: this message's quote pins are separate
      // marks the user made on purpose.
      persist(current.filter((p) => !(!p.quote && p.msgId === msgId)));
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

  const pinQuote = useCallback<SessionPinsApi['pinQuote']>(({ msgId, role, timestamp, quote }) => {
    if (!msgId || !quote.exact.trim()) return;
    const current = listRef.current;
    if (current.some((p) => sameQuote(p, msgId, quote))) return;
    const entry: SessionPinnedMessage = {
      id: newPinId(),
      msgId,
      label: pinLabelFor(quote.exact, 'Quoted passage'),
      role,
      ...(timestamp ? { timestamp } : {}),
      pinnedAt: new Date().toISOString(),
      quote,
    };
    log.info('session', 'quote pin added', {
      sessionId, msgId, pinId: entry.id, chars: quote.exact.length,
    });
    persist([...current, entry]);
  }, [persist, sessionId]);

  const unpin = useCallback((pinKey: string) => {
    const current = listRef.current;
    if (!current.some((p) => pinKeyOf(p) === pinKey)) return;
    persist(current.filter((p) => pinKeyOf(p) !== pinKey));
  }, [persist]);

  return useMemo(
    // canPinQuote: this hook IS the real store — a session record to PATCH exists.
    () => ({ pins, isPinned, toggle, pinQuote, unpin, canPinQuote: true }),
    [pins, isPinned, toggle, pinQuote, unpin],
  );
}
