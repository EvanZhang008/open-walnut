/**
 * What the quick bar shows after a send: one receipt per message, following its NDJSON answer
 * (api/quick.ts) from "Sending" through "Sent" (in its queue), "Delivered" (its session took it)
 * and "Thinking" to the reply's first line.
 * A send that never went out says so, stays, and can be put back into the bar; a reply lost on the
 * way says it is in the chat. Any other finished receipt leaves by itself after a while unless it
 * is open.
 */
import { useEffect, useRef, useState } from 'react';
import { quickSendFollow, type QuickFollowLine, type QuickImage } from '@/api/quick';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import type { QuickPerson } from './quickbar-people';

export type ReceiptState = 'sending' | 'sent' | 'delivered' | 'thinking' | 'replied' | 'held' | 'failed' | 'lost';

export interface Receipt {
  id: string;
  person: Pick<QuickPerson, 'id' | 'title' | 'kind'>;
  text: string;
  images: QuickImage[];
  state: ReceiptState;
  /** The task the words went to (the CEO's id once the send answered). */
  taskId?: string;
  /** The session the reply is written in, so a path in it opens on that session's machine. */
  sessionId?: string;
  started?: boolean;
  reply: string;
  activity?: string;
  error?: string;
  unfinished?: boolean;
  open?: boolean;
  /** When it reached a state with nothing more to come (ms), for the timed exit. */
  endedAt?: number;
}

/** A finished receipt stays this long, then leaves (never while open or pointed at). */
export const RECEIPT_STAY_MS = 8_000;

/** Words that never went out (refused, or held behind a prompt) stay until put back or dismissed. */
export function staysUntilDismissed(r: Pick<Receipt, 'state'>): boolean {
  return r.state === 'failed' || r.state === 'held';
}
const MAX_RECEIPTS = 4;

const FINAL: ReadonlySet<ReceiptState> = new Set(['replied', 'held', 'failed', 'lost']);

/** One answer line applied to its receipt (pure: tests/web/quickbar-receipts.test.ts). */
export function applyLine(r: Receipt, line: QuickFollowLine, now = Date.now()): Receipt {
  if (FINAL.has(r.state)) return r;
  switch (line.type) {
    case 'sent': return { ...r, state: 'sent', taskId: line.taskId, ...(line.sessionId ? { sessionId: line.sessionId } : {}), started: line.started };
    case 'held': return { ...r, state: 'held', taskId: line.taskId, endedAt: now };
    case 'delivered': return r.state === 'sent' ? { ...r, state: 'delivered' } : r;
    case 'text': return { ...r, state: 'thinking', reply: r.reply + line.delta };
    case 'reset': return { ...r, reply: '' };
    case 'activity': return { ...r, state: 'thinking', activity: line.detail };
    case 'result': {
      const reply = line.text.trim() ? line.text : r.reply;
      return { ...r, state: 'replied', reply, unfinished: line.unfinished, activity: undefined, endedAt: now };
    }
    case 'error':
      // Before the send answered nothing went out; after it, only the reply was lost.
      return r.state === 'sending'
        ? { ...r, state: 'failed', error: line.message, endedAt: now }
        : { ...r, state: 'lost', error: line.message, endedAt: now };
  }
}

/** The answer ended: a receipt still waiting on its reply has it only in the chat. */
export function endStream(r: Receipt, now = Date.now()): Receipt {
  if (FINAL.has(r.state)) return r;
  return r.state === 'sending'
    ? { ...r, state: 'failed', error: 'Walnut did not answer. Nothing was sent.', endedAt: now }
    : { ...r, state: 'lost', error: 'The reply is in the chat.', endedAt: now };
}

export function useQuickReceipts() {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const pinned = useRef(new Set<string>());
  const aborts = useRef(new Map<string, AbortController>());

  const update = useLeanCallback((id: string, fn: (r: Receipt) => Receipt) => {
    setReceipts((all) => all.map((r) => (r.id === id ? fn(r) : r)));
  }, []);

  const send = useLeanCallback((person: Pick<QuickPerson, 'id' | 'title' | 'kind'>, text: string, images: QuickImage[]) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const receipt: Receipt = { id, person: { id: person.id, title: person.title, kind: person.kind }, text, images, state: 'sending', reply: '' };
    setReceipts((all) => [receipt, ...all].slice(0, MAX_RECEIPTS));
    const ctl = new AbortController();
    aborts.current.set(id, ctl);
    void quickSendFollow(person.kind === 'ceo' || !person.id ? null : person.id, text, images, (line) => update(id, (r) => applyLine(r, line)), ctl.signal)
      .finally(() => { aborts.current.delete(id); if (!ctl.signal.aborted) update(id, (r) => endStream(r)); });
  }, [update]);

  const dismiss = useLeanCallback((id: string) => {
    // Closing a receipt stops following its reply; the turn itself goes on in its chat.
    aborts.current.get(id)?.abort();
    aborts.current.delete(id);
    pinned.current.delete(id);
    setReceipts((all) => all.filter((r) => r.id !== id));
  }, []);

  /** Words that never went out, sent again as they were, to the same person: a new receipt follows them. */
  const resend = useLeanCallback((id: string) => {
    const r = receipts.find((x) => x.id === id);
    if (!r || !staysUntilDismissed(r)) return;
    dismiss(id);
    send(r.person, r.text, r.images);
  }, [receipts, dismiss, send]);

  const toggleOpen = useLeanCallback((id: string) => update(id, (r) => ({ ...r, open: !r.open })), [update]);
  const pin = useLeanCallback((id: string, on: boolean) => {
    if (on) pinned.current.add(id); else pinned.current.delete(id);
    // Pointing away restarts the stay, so a receipt never vanishes under the pointer's last move.
    if (!on) update(id, (r) => (r.endedAt ? { ...r, endedAt: Date.now() } : r));
  }, [update]);

  // The timed exit: one clock for all of them.
  useEffect(() => {
    if (!receipts.some((r) => r.endedAt)) return;
    const t = setInterval(() => {
      const now = Date.now();
      setReceipts((all) => {
        const keep = all.filter((r) => !r.endedAt || staysUntilDismissed(r) || r.open || pinned.current.has(r.id) || now - r.endedAt < RECEIPT_STAY_MS);
        return keep.length === all.length ? all : keep;
      });
    }, 500);
    return () => clearInterval(t);
  }, [receipts]);

  useEffect(() => () => { for (const c of aborts.current.values()) c.abort(); }, []);

  return { receipts, send, resend, dismiss, toggleOpen, pin };
}
