/**
 * "Show me this thread": a click on a chat message's thread line (sessions/reply-thread-line.tsx)
 * asks the node's Threads to bring that thread into view and mark it a moment. Every view of that
 * node's threads takes the ask once when it shows (OrgThreads, the thread on show above the chat:
 * TopThread), whether it is already on screen or opens right after the click (the Org page's side
 * bar, a task's Threads beside its chat, another node). Kept a short while, so a view that mounts
 * after the click still takes it; once a view took it, only a moment more.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

const ASK_MS = 30_000;
/** After a view took the ask: how long one that opens because of the click may still take it. */
const TAKEN_MS = 3_000;
const asks = new Map<string, { thread: string; at: number; seq: number; until: number }>();
const listeners = new Set<() => void>();
let tick = 0;

export function askThreadFocus(node: string, thread: string, now = Date.now()): void {
  tick += 1;
  asks.set(node, { thread, at: now, seq: tick, until: now + ASK_MS });
  for (const l of listeners) l();
}

/** Changes with every new ask, so a view on screen looks again. */
export function useThreadFocusTick(): number {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => tick,
  );
}

/** The ask on this node, if any (still kept), without taking it. */
function askOf(node: string | undefined, now = Date.now()): { thread: string; seq: number } | null {
  const ask = node ? asks.get(node) : undefined;
  if (!ask) return null;
  if (now >= ask.until) { asks.delete(node!); return null; }
  return ask;
}

/** The thread asked for on this node, if any (still kept). */
export function threadFocusAsk(node: string | undefined, now = Date.now()): string | null {
  return askOf(node, now)?.thread ?? null;
}

/** A view took the ask: it is kept only a moment more, for a view the click is opening. */
export function takeThreadFocus(node: string, thread: string, now = Date.now()): void {
  const ask = asks.get(node);
  if (ask?.thread === thread) ask.until = Math.min(ask.until, now + TAKEN_MS);
}

/** The threads each node's chat shows on its top now (TopThread, not hidden): a line about one of them steps the top to it. */
const atTop = new Map<string, ReadonlySet<string>>();

export function setTopThreads(node: string, ids: readonly string[] | null): void {
  if (ids?.length) atTop.set(node, new Set(ids)); else atTop.delete(node);
}

export function topShows(node: string, thread: string): boolean {
  return !!atTop.get(node)?.has(thread);
}

/** How long a card a thread line opened stays marked. */
const FOCUS_MARK_MS = 2_400;

/**
 * A view's side of an ask (OrgThreads, TopThread): once its list holds the asked thread, `reveal`
 * makes it show (its section opens, the top steps to it), the card scrolls into view inside `root`,
 * and the id it returns marks it a moment. Each view takes one ask once.
 */
export function useFocusedThread<T extends { id: string }>(node: string | undefined, list: readonly T[] | null, root: RefObject<HTMLElement | null>, reveal: (t: T) => void): string | null {
  const askTick = useThreadFocusTick();
  const [focused, setFocused] = useState<{ id: string; seq: number } | null>(null);
  const handled = useRef(0);
  useEffect(() => {
    const ask = askOf(node);
    if (!node || !ask || !list || ask.seq <= handled.current) return;
    // A list read before the thread was there keeps the ask for the next read.
    const t = list.find((x) => x.id === ask.thread);
    if (!t) return;
    handled.current = ask.seq;
    takeThreadFocus(node, ask.thread);
    reveal(t);
    setFocused({ id: ask.thread, seq: ask.seq });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ask, on the list as it is then
  }, [askTick, node, list]);
  useEffect(() => {
    if (!focused) return;
    const raf = requestAnimationFrame(() => {
      root.current?.querySelector(`[data-thread-id="${CSS.escape(focused.id)}"]`)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    });
    const done = window.setTimeout(() => setFocused(null), FOCUS_MARK_MS);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(done); };
  }, [focused, root]);
  return focused?.id ?? null;
}
