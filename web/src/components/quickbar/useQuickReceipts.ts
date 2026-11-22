/**
 * What the quick bar shows after a send: one receipt per message, following its NDJSON answer
 * (api/quick.ts) from "Sending" through "Sent" (in its queue), "Delivered" (its session took it)
 * and "Thinking" to the reply's first line.
 * A send that never reached Walnut (it was down, a restart) waits for it and goes out by itself
 * once it answers again, under the same user line, so the server keeps one copy
 * (hooks/send-auto-retry.ts, the chat's rule; src/core/sessions/send-once.ts). Any other send that
 * never went out says so, stays, and can be sent again or put back into the bar; a reply lost on
 * the way says it is in the chat. Any other finished receipt leaves by itself after a while unless
 * it is open.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { quickSendFollow, walnutAnswers, type QuickFollowLine, type QuickImage, type QuickSendLine } from '@/api/quick';
import { wsClient } from '@/api/ws';
import { isConnectionFailure, pastAutoRetryAge, waitsForConnectionAfter } from '@/hooks/send-auto-retry';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { newUserUuid } from '@/utils/thread-tree';
import type { QuickPerson } from './quickbar-people';

export type ReceiptState = 'sending' | 'waiting' | 'sent' | 'delivered' | 'thinking' | 'replied' | 'held' | 'failed' | 'lost';

export interface Receipt {
  id: string;
  person: Pick<QuickPerson, 'id' | 'title' | 'kind'>;
  text: string;
  images: QuickImage[];
  state: ReceiptState;
  /** The send's own user line: every try of it carries this, so the server knows it is one send. */
  userUuid?: string;
  /** When it was first tried (ms): past AUTO_RETRY_MAX_AGE_MS it is no longer sent by itself. */
  sentAt?: number;
  /** How many times it was sent again by itself (at most AUTO_RETRY_MAX). */
  autoTries?: number;
  /** The failure's code (api/quick.ts), so Send again knows whether the first may have gone out. */
  failCode?: string;
  /** Closed with its × before the send ended: the send still goes out, and the card comes back only if it fails. */
  hidden?: boolean;
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

/** Words that never went out (refused, held behind a prompt, waiting for Walnut) stay until sent, put back or dismissed. */
export function staysUntilDismissed(r: Pick<Receipt, 'state'>): boolean {
  return r.state === 'failed' || r.state === 'held' || r.state === 'waiting';
}
const MAX_RECEIPTS = 4;

const FINAL: ReadonlySet<ReceiptState> = new Set(['replied', 'held', 'failed', 'lost']);

/** One answer line applied to its receipt (pure: tests/web/quickbar-receipts.test.ts). */
export function applyLine(r: Receipt, line: QuickFollowLine, now = Date.now()): Receipt {
  // A waiting receipt has no answer open: only its next try's lines move it, after resentNow.
  if (FINAL.has(r.state) || r.state === 'waiting') return r;
  switch (line.type) {
    case 'sent': return { ...r, state: 'sent', taskId: line.taskId, ...(line.sessionId ? { sessionId: line.sessionId } : {}), started: line.started };
    case 'held': return { ...r, state: 'held', taskId: line.taskId, endedAt: now };
    case 'delivered': return r.state === 'sent' ? { ...r, state: 'delivered' } : r;
    // Sent out of a focus space: the reply is not followed into it (shown "Sent · ...", muted).
    case 'kept': return { ...r, state: 'lost', error: 'its reply waits outside your focus', endedAt: now };
    case 'text': return { ...r, state: 'thinking', reply: r.reply + line.delta };
    case 'reset': return { ...r, reply: '' };
    case 'activity': return { ...r, state: 'thinking', activity: line.detail };
    case 'result': {
      const reply = line.text.trim() ? line.text : r.reply;
      return { ...r, state: 'replied', reply, unfinished: line.unfinished, activity: undefined, endedAt: now };
    }
    case 'error':
      if (r.state !== 'sending') return { ...r, state: 'lost', error: line.message, endedAt: now };
      // Before the send answered nothing went out. Walnut could not be reached: it goes out by
      // itself once Walnut answers (the same user line, so never twice), within the rule's limits.
      if (waitsForConnectionAfter(line, { userUuid: r.userUuid, timestamp: r.sentAt }, r.autoTries ?? 0, now)) {
        return { ...r, state: 'waiting', error: line.message, failCode: line.code };
      }
      return { ...r, state: 'failed', error: line.message, failCode: line.code, endedAt: now };
  }
}

/** The answer ended: a receipt still waiting on its reply has it only in the chat. */
export function endStream(r: Receipt, now = Date.now()): Receipt {
  if (FINAL.has(r.state) || r.state === 'waiting') return r;
  return r.state === 'sending'
    ? { ...r, state: 'failed', error: 'Walnut did not answer. Nothing was sent.', endedAt: now }
    : { ...r, state: 'lost', error: 'The reply is in the chat.', endedAt: now };
}

/** A waiting receipt sent again now: by the bar itself (`auto`, one of its tries) or by Send again. */
export function resentNow(r: Receipt, auto: boolean): Receipt {
  return { ...r, state: 'sending', error: undefined, failCode: undefined, endedAt: undefined, autoTries: (r.autoTries ?? 0) + (auto ? 1 : 0) };
}

/** A receipt that waited past the rule's age goes out by itself no more: an ordinary failure, shown. */
export function expireWaiting(r: Receipt, now = Date.now()): Receipt {
  if (r.state !== 'waiting' || !pastAutoRetryAge(r.sentAt, now)) return r;
  return { ...r, state: 'failed', endedAt: now, hidden: false };
}

/**
 * A receipt closed with its × while its send was still on its way: kept out of sight while it
 * sends or waits; shown again when it ended without going out (the words are not lost); gone once
 * it went out. Null: drop it.
 */
export function settleHidden(r: Receipt): Receipt | null {
  if (!r.hidden || r.state === 'sending' || r.state === 'waiting') return r;
  if (staysUntilDismissed(r)) return { ...r, hidden: false, endedAt: undefined };
  return null;
}

/** Hidden ones settled; at most MAX_RECEIPTS shown, never dropping one whose send is still on its way. */
export function settleReceipts(all: readonly Receipt[]): Receipt[] {
  const out: Receipt[] = [];
  let shown = 0;
  for (const r of all) {
    const s = settleHidden(r);
    if (!s) continue;
    const onItsWay = s.hidden || s.state === 'waiting' || s.state === 'sending';
    if (!s.hidden) shown += 1;
    if (shown > MAX_RECEIPTS && !onItsWay) continue;
    out.push(s);
  }
  return out;
}

/** Send again (the person's key): under the same user line when the first may have reached Walnut. */
export function sameLineOnSendAgain(r: Receipt): boolean {
  return !!r.userUuid && (r.state === 'waiting' || (r.state === 'failed' && isConnectionFailure({ message: r.error ?? '', code: r.failCode })));
}

/** How long the bar waits before it asks whether Walnut answers again: 2 s, 4 s, 8 s, then every 15 s. */
export function nextCheckDelay(misses: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, misses), 15_000);
}

export function useQuickReceipts() {
  const [all, setAll] = useState<Receipt[]>([]);
  const allRef = useRef(all);
  allRef.current = all;
  const pinned = useRef(new Set<string>());
  const aborts = useRef(new Map<string, AbortController>());

  const update = useLeanCallback((id: string, fn: (r: Receipt) => Receipt) => {
    setAll((list) => settleReceipts(list.map((r) => (r.id === id ? fn(r) : r))));
  }, []);

  /** One try of a receipt's send, following its answer. */
  const post = useLeanCallback((r: Pick<Receipt, 'id' | 'person' | 'text' | 'images' | 'userUuid'>, resend?: QuickSendLine['resend']) => {
    const ctl = new AbortController();
    aborts.current.set(r.id, ctl);
    const line = r.userUuid ? { userUuid: r.userUuid, ...(resend ? { resend } : {}) } : undefined;
    void quickSendFollow(r.person.kind === 'ceo' || !r.person.id ? null : r.person.id, r.text, r.images, (l) => update(r.id, (x) => applyLine(x, l)), ctl.signal, line)
      .finally(() => {
        if (aborts.current.get(r.id) === ctl) aborts.current.delete(r.id);
        if (!ctl.signal.aborted) update(r.id, (x) => endStream(x));
      });
  }, [update]);

  const send = useLeanCallback((person: Pick<QuickPerson, 'id' | 'title' | 'kind'>, text: string, images: QuickImage[], again?: { userUuid: string }) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const userUuid = again?.userUuid ?? newUserUuid();
    const receipt: Receipt = {
      id, person: { id: person.id, title: person.title, kind: person.kind }, text, images, state: 'sending', reply: '',
      ...(userUuid ? { userUuid } : {}), sentAt: Date.now(), autoTries: 0,
    };
    setAll((list) => settleReceipts([receipt, ...list]));
    post(receipt, again ? 'person' : undefined);
  }, [post]);

  /** A waiting receipt sent now under its own user line; never two tries of one at once. */
  const sendWaitingNow = useLeanCallback((r: Receipt, auto: boolean) => {
    if (r.state !== 'waiting' || aborts.current.has(r.id)) return;
    update(r.id, (x) => resentNow(x, auto));
    post(r, auto ? 'auto' : 'person');
  }, [update, post]);

  /** Gone for good: its follow stopped and a waiting send never goes out. */
  const withdraw = useLeanCallback((id: string) => {
    aborts.current.get(id)?.abort();
    aborts.current.delete(id);
    pinned.current.delete(id);
    setAll((list) => list.filter((r) => r.id !== id));
  }, []);

  const dismiss = useLeanCallback((id: string) => {
    const r = allRef.current.find((x) => x.id === id);
    // Its × only hides a card whose send is still on its way: the message goes out all the same.
    if (r && (r.state === 'sending' || r.state === 'waiting') && r.userUuid) {
      pinned.current.delete(id);
      update(id, (x) => ({ ...x, hidden: true, open: false }));
      return;
    }
    // Closing a receipt stops following its reply; the turn itself goes on in its chat.
    withdraw(id);
  }, [update, withdraw]);

  /** Words that never went out, sent again as they were, to the same person. */
  const resend = useLeanCallback((id: string) => {
    const r = allRef.current.find((x) => x.id === id);
    if (!r || !staysUntilDismissed(r)) return;
    if (r.state === 'waiting') { sendWaitingNow(r, false); return; }
    withdraw(id);
    send(r.person, r.text, r.images, sameLineOnSendAgain(r) && r.userUuid ? { userUuid: r.userUuid } : undefined);
  }, [withdraw, send, sendWaitingNow]);

  const toggleOpen = useLeanCallback((id: string) => update(id, (r) => ({ ...r, open: !r.open })), [update]);
  const pin = useLeanCallback((id: string, on: boolean) => {
    if (on) pinned.current.add(id); else pinned.current.delete(id);
    // Pointing away restarts the stay, so a receipt never vanishes under the pointer's last move.
    if (!on) update(id, (r) => (r.endedAt ? { ...r, endedAt: Date.now() } : r));
  }, [update]);

  // Waiting for Walnut: ask whether it answers again (2 s, 4 s, ... 15 s; at once when the socket
  // is back), then send every waiting receipt under its own line. One that waited too long fails.
  const waitingKey = all.filter((r) => r.state === 'waiting').map((r) => r.id).join(',');
  useEffect(() => {
    if (!waitingKey) return;
    let stopped = false;
    let misses = 0;
    let checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void check(), nextCheckDelay(misses)); };
    const check = async () => {
      if (stopped || checking) return;
      const now = Date.now();
      if (allRef.current.some((r) => r.state === 'waiting' && pastAutoRetryAge(r.sentAt, now))) {
        setAll((list) => settleReceipts(list.map((r) => expireWaiting(r, now))));
      }
      checking = true;
      const up = await walnutAnswers();
      checking = false;
      if (stopped) return;
      if (!up) { misses += 1; schedule(); return; }
      let sent = 0;
      for (const r of allRef.current) {
        if (r.state === 'waiting' && !pastAutoRetryAge(r.sentAt) && !aborts.current.has(r.id)) { sendWaitingNow(r, true); sent += 1; }
      }
      // Nothing went (each already on its way): ask again later rather than stop asking.
      if (sent === 0) schedule();
    };
    schedule();
    const onState = (state: string) => { if (state === 'connected') { if (timer) clearTimeout(timer); void check(); } };
    wsClient.onConnectionChange(onState);
    return () => { stopped = true; if (timer) clearTimeout(timer); wsClient.offConnectionChange(onState); };
  }, [waitingKey, sendWaitingNow]);

  // The timed exit: one clock for all of them.
  useEffect(() => {
    if (!all.some((r) => r.endedAt)) return;
    const t = setInterval(() => {
      const now = Date.now();
      setAll((list) => {
        const keep = list.filter((r) => !r.endedAt || staysUntilDismissed(r) || r.open || pinned.current.has(r.id) || now - r.endedAt < RECEIPT_STAY_MS);
        return keep.length === list.length ? list : keep;
      });
    }, 500);
    return () => clearInterval(t);
  }, [all]);

  // A hidden receipt that went out is dropped: its follow stops with it.
  useEffect(() => {
    for (const [id, ctl] of aborts.current) {
      if (!all.some((r) => r.id === id)) { ctl.abort(); aborts.current.delete(id); }
    }
  }, [all]);

  useEffect(() => () => { for (const c of aborts.current.values()) c.abort(); }, []);

  const receipts = useMemo(() => all.filter((r) => !r.hidden), [all]);
  return { receipts, send, resend, dismiss, withdraw, toggleOpen, pin };
}
