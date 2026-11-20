/**
 * A task's asks, one page each (2026-11-20, the user: "also should max shoudl 1 decision, and can
 * left and right", then "each quesiton is jsut left and right, and each quesiton it selse have
 * options, and titme and descirption, don't mix them"). The block under a task's row shows ONE ask
 * at a time, with its own words, options and box; left and right page through the others.
 *
 * Each page is answered on its own. One answered here stays where it was, marked answered with what
 * was said, until no open ask is left; a failed send makes it open again. Where the block stands (the
 * page it shows, what was answered here) is kept per task for this page's life, one record for every
 * place that draws the task's asks (its row and its session's strip show the same page and the same
 * marks), so a status push, a row moving between sections or a strip opening again finds it as it was.
 */
import { useSyncExternalStore } from 'react';
import type { ActionItem } from '@open-walnut/user-status';
import { useLeanCallback } from '@/hooks/useLeanCallback';

/** One ask answered from here: the item as it was, what was said, its place among the pages, and
 *  the other asks shown with it (it stays only beside one of them: a later ask starts afresh). */
export interface AnsweredAsk { item: ActionItem; said?: string; index: number; peers: readonly string[] }
/** The page shown: its ask, and where it was (a page that left gives its place to the next). */
export interface AskPageAt { id: string; index: number }
interface Kept { at?: AskPageAt; answered: Readonly<Record<string, AnsweredAsk>> }

/** The pages: the task's asks in their order, with the ones answered here kept at their place. */
export function pagesOf(items: readonly ActionItem[], answered: Readonly<Record<string, AnsweredAsk>>): ActionItem[] {
  const open = new Set(items.map((i) => i.id));
  const pages = [...items];
  const gone = Object.values(answered)
    .filter((a) => !open.has(a.item.id) && a.peers.some((id) => open.has(id)))
    .sort((x, y) => x.index - y.index);
  for (const a of gone) pages.splice(Math.min(Math.max(a.index, 0), pages.length), 0, a.item);
  return pages;
}

/** The page to show: the one kept, else the one now at its place, never past the last. */
export function pageIndex(ids: readonly string[], at: AskPageAt | undefined): number {
  if (!ids.length || !at) return 0;
  const i = ids.indexOf(at.id);
  return i >= 0 ? i : Math.min(Math.max(at.index, 0), ids.length - 1);
}

/** True while a page still waits on the user: with none left the block has nothing to show. */
export function anyOpen(pages: readonly ActionItem[], answered: Readonly<Record<string, AnsweredAsk>>): boolean {
  return pages.some((p) => !answered[p.id]);
}

const KEPT_MAX = 300;
const NONE: Kept = { answered: {} };
const kept = new Map<string, Kept>();
const heard = new Set<() => void>();
const hear = (l: () => void) => { heard.add(l); return () => { heard.delete(l); }; };
function keep(taskId: string, next: Kept): void {
  kept.delete(taskId);
  kept.set(taskId, next);
  if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
  for (const l of [...heard]) l();
}

export interface AskPages {
  pages: ActionItem[];
  index: number;
  answered: Readonly<Record<string, AnsweredAsk>>;
  /** One page on (+1) or back (-1); false at either end. */
  go: (delta: number) => boolean;
  show: (id: string) => void;
  /** Answered from here: kept, marked, with what was said. */
  answer: (item: ActionItem, said?: string) => void;
  /** Its send failed: open again, and shown. */
  reopen: (id: string) => void;
}

export function useAskPages(taskId: string, items: readonly ActionItem[]): AskPages {
  const read = () => kept.get(taskId) ?? NONE;
  const now = useSyncExternalStore(hear, read, read);
  const pages = pagesOf(items, now.answered);
  const index = pageIndex(pages.map((p) => p.id), now.at);
  const write = (next: Kept) => keep(taskId, next);
  // Stable, and each call reads the latest render's pages and place (useLeanCallback).
  const go = useLeanCallback((delta: number): boolean => {
    const to = Math.min(Math.max(index + delta, 0), pages.length - 1);
    if (to === index || !pages[to]) return false;
    write({ ...now, at: { id: pages[to]!.id, index: to } });
    return true;
  }, []);
  const show = useLeanCallback((id: string) => {
    const i = pages.findIndex((p) => p.id === id);
    write({ ...now, at: { id, index: Math.max(i, 0) } });
  }, []);
  const answer = useLeanCallback((item: ActionItem, said?: string) => {
    const i = Math.max(pages.findIndex((p) => p.id === item.id), 0);
    const peers = pages.map((p) => p.id).filter((id) => id !== item.id);
    write({ at: { id: item.id, index: i }, answered: { ...now.answered, [item.id]: { item, index: i, peers, ...(said?.trim() ? { said: said.trim() } : {}) } } });
  }, []);
  const reopen = useLeanCallback((id: string) => {
    const { [id]: _gone, ...rest } = now.answered;
    const i = Math.max(pages.findIndex((p) => p.id === id), 0);
    write({ at: { id, index: i }, answered: rest });
  }, []);
  return { pages, index, answered: now.answered, go, show, answer, reopen };
}
