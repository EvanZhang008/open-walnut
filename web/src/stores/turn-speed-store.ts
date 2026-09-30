/**
 * One browser, one copy of every session's turn speed readout.
 *
 * The server measures each turn on its own clock (`session:turn-speed`, see
 * SessionTurnSpeed in core) and writes the final copy of the last turn onto
 * the session record (`lastTurnSpeed`). Both land here so every panel of the
 * same session reads one merge, and so an event arriving before the record's
 * first fetch has somewhere to land. Same shape as the recap tip store.
 *
 * Resolution: a live snapshot wins while it is newer than the record's copy
 * (a running turn, or the final of a turn the record fetch has not caught up
 * with). The record's copy is the cold-load fallback and also what remains
 * once the live map is cleared for that session.
 */
import { useSyncExternalStore } from 'react';
import type { SessionTurnSpeed } from '@open-walnut/core';
import { wsClient } from '@/api/ws';

class TurnSpeedStore {
  private live = new Map<string, SessionTurnSpeed>();
  /** Browser clock at which each session's current frame arrived. */
  private liveAt = new Map<string, number>();
  private listeners = new Set<() => void>();
  private revision = 0;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getRevision = (): number => this.revision;

  /** The live frame of one session (same object until a new frame lands, so a
   *  subscriber keyed on it re-renders only for its own session). */
  getLive = (sessionId: string): SessionTurnSpeed | undefined => this.live.get(sessionId);

  /** When the session's current frame arrived (browser clock); 0 when none. */
  receivedAt(sessionId: string): number {
    return this.liveAt.get(sessionId) ?? 0;
  }

  private bump(): void {
    this.revision++;
    for (const fn of this.listeners) fn();
  }

  ingestEvent(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as { sessionId?: unknown; speed?: unknown };
    if (typeof d.sessionId !== 'string' || !d.sessionId) return;
    const speed = d.speed;
    if (!speed || typeof speed !== 'object' || typeof (speed as SessionTurnSpeed).final !== 'boolean') return;
    const prev = this.live.get(d.sessionId);
    // A live (non-final) frame that arrives after the turn's final frame is a
    // late throttled emit of the same turn: the final stays.
    if (prev?.final && !(speed as SessionTurnSpeed).final && sameTurn(prev, speed as SessionTurnSpeed)) return;
    this.live.set(d.sessionId, speed as SessionTurnSpeed);
    this.liveAt.set(d.sessionId, Date.now());
    this.bump();
  }

  resolve(sessionId: string, record: SessionTurnSpeed | null | undefined): SessionTurnSpeed | undefined {
    return resolveWith(this.live.get(sessionId), record);
  }

  /** Test seam. */
  reset(): void {
    this.live.clear();
    this.liveAt.clear();
    this.bump();
  }
}

/** Merge a session's live frame with its record copy (the record only ever
 *  holds finals). A live frame of a LATER turn, or the same turn's own final,
 *  outranks the record; a record refetched after the final can be the same
 *  turn, and either copy is fine then. */
export function resolveWith(live: SessionTurnSpeed | undefined, record: SessionTurnSpeed | null | undefined): SessionTurnSpeed | undefined {
  if (!live) return record ?? undefined;
  if (!record) return live;
  return newerOf(live, record);
}

function sameTurn(a: SessionTurnSpeed, b: SessionTurnSpeed): boolean {
  return a.startedAt !== undefined && a.startedAt === b.startedAt;
}

function stamp(s: SessionTurnSpeed): number {
  return s.endedAt ?? s.startedAt ?? 0;
}

function newerOf(live: SessionTurnSpeed, record: SessionTurnSpeed): SessionTurnSpeed {
  if (!live.final) return live;
  return stamp(record) > stamp(live) ? record : live;
}

export const turnSpeedStore = new TurnSpeedStore();

let initialized = false;
/** Wire the ONE WS subscription. Called from main.tsx at boot. */
export function initTurnSpeedStore(): void {
  if (initialized) return;
  initialized = true;
  wsClient.onEvent('session:turn-speed', (data) => turnSpeedStore.ingestEvent(data));
}

/** The readout for a session: the live frame when a turn runs, else the
 *  record's last final. */
export function useTurnSpeed(sessionId: string, record: SessionTurnSpeed | null | undefined): SessionTurnSpeed | undefined {
  // The snapshot is this session's own frame, so another panel's stream of
  // frames (every 400ms while it runs) does not re-render this one.
  const live = useSyncExternalStore(
    turnSpeedStore.subscribe,
    () => turnSpeedStore.getLive(sessionId),
    () => turnSpeedStore.getLive(sessionId),
  );
  return resolveWith(live, record);
}
