/**
 * The plain lines under a queued bubble that has waited too long, or that the
 * queue lost track of (queued-wait.ts). Each keeps its own clock, so the "N min"
 * stays true without re-rendering the whole chat history.
 */
import { useEffect, useState } from 'react';
import { leftQueueLine, queuedWaitLine, type WaitLineInput } from './queued-wait';

const TICK_MS = 10_000;

/** Now, re-read every TICK_MS while `active`. */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const isWaiting = (status: string) => status === 'pending' || status === 'received';

/** " Queued 3 min ago." after a held note's server reason, once past the bound. */
export function HeldSince({ m }: { m: WaitLineInput }) {
  const now = useClock(isWaiting(m.status));
  const line = queuedWaitLine({ ...m, heldReason: m.heldReason || 'held' }, { now, turnRunning: false });
  return line ? <> {line}</> : null;
}

export interface QueuedWaitNoteProps {
  m: WaitLineInput & { queueId: string };
  turnRunning: boolean;
  syncError?: string;
  /** Send now was pressed and nothing has answered yet. */
  sending: boolean;
  onSendNow: () => void;
}

/** Why a bubble with no server reason still waits, past the bound. */
export function QueuedWaitNote({ m, turnRunning, syncError, sending, onSendNow }: QueuedWaitNoteProps) {
  // The clock runs only while the bubble waits; a young one needs it to cross the bound.
  const now = useClock(isWaiting(m.status));
  const line = queuedWaitLine(m, { now, turnRunning, syncError });
  if (!line) return null;
  const clientOnly = m.queueId.startsWith('temp-');
  return (
    <div className="thread-queue-note session-msg-wait-note" role="status">
      {line}
      {!m.afterTurn && !clientOnly && !sending && (
        <button type="button" className="session-msg-send-now-btn" onClick={onSendNow}>Send now</button>
      )}
      {sending && <span className="session-msg-send-now-sent"> Sending…</span>}
    </div>
  );
}

export interface LeftQueueNoteProps {
  m: { status: string; leftQueueAt?: number };
  /** A turn runs: a message handed into it is not in history yet, which is normal. */
  turnRunning: boolean;
  /** When the session last went quiet (its turn ended); the bound counts from the later of this and leftQueueAt. */
  quietSince: number;
  onSendAgain: () => void;
  onDismiss: () => void;
}

/** A bubble that left the queue, that history still lacks well after the session went quiet. */
export function LeftQueueNote({ m, turnRunning, quietSince, onSendAgain, onDismiss }: LeftQueueNoteProps) {
  const active = m.status === 'delivered' && m.leftQueueAt !== undefined && !turnRunning;
  const now = useClock(active);
  if (!active) return null;
  const line = leftQueueLine({ status: m.status, leftQueueAt: Math.max(m.leftQueueAt!, quietSince) }, now);
  if (!line) return null;
  return (
    <div className="thread-queue-note session-msg-left-queue-note" role="status">
      {line}
      <span className="session-msg-queued-actions session-msg-left-queue-actions">
        <button type="button" onClick={onSendAgain}>Send again</button>
        <button type="button" onClick={onDismiss}>Dismiss</button>
      </span>
    </div>
  );
}

