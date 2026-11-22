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
import { useEffect, useSyncExternalStore } from 'react';
import type { ActionItem } from '@open-walnut/user-status';
import { useLeanCallback } from '@/hooks/useLeanCallback';

/** One ask answered from here: the item as it was, what was said, its place among the pages, and
 *  the other asks shown with it (it stays only beside one of them: a later ask starts afresh).
 *  `gone`: the status has dropped it since, so the same id coming back is a new ask. */
export interface AnsweredAsk { item: ActionItem; said?: string; index: number; peers: readonly string[]; gone?: boolean }
/** The page shown: its ask, and where it was (a page that left gives its place to the next). */
export interface AskPageAt { id: string; index: number }
interface Kept { at?: AskPageAt; answered: Readonly<Record<string, AnsweredAsk>> }

const ALL = () => true;

/** A mark that no longer holds: its id is asked again (back after the status dropped it, or the
 *  same id reworded). That ask is a new one, open. */
function stale(mark: AnsweredAsk, now: ActionItem | undefined): boolean {
  return !!now && (!!mark.gone || now.summary !== mark.item.summary || (now.detail ?? '') !== (mark.item.detail ?? ''));
}

/** The marks that still hold for these items. */
export function liveMarks(items: readonly ActionItem[], answered: Readonly<Record<string, AnsweredAsk>>): Record<string, AnsweredAsk> {
  const byId = new Map(items.map((i) => [i.id, i]));
  return Object.fromEntries(Object.entries(answered).filter(([id, a]) => !stale(a, byId.get(id))));
}

/** The pages: the task's asks in their order, with the ones answered here kept at their place.
 *  `accepts`: the asks this place shows at all (a session's top leaves out the ones that are
 *  threads); a kept page it would not show stays out. */
export function pagesOf(items: readonly ActionItem[], answered: Readonly<Record<string, AnsweredAsk>>, accepts: (item: ActionItem) => boolean = ALL): ActionItem[] {
  const open = new Set(items.map((i) => i.id));
  const pages = [...items];
  const gone = Object.values(answered)
    .filter((a) => !open.has(a.item.id) && a.peers.some((id) => open.has(id)) && accepts(a.item))
    .sort((x, y) => x.index - y.index);
  // After the last page that came before it when it was answered: the same place in every list,
  // whichever asks a place leaves out.
  for (const a of gone) {
    const before = new Set(a.peers.slice(0, a.index));
    let at = 0;
    pages.forEach((p, j) => { if (before.has(p.id)) at = j + 1; });
    pages.splice(at, 0, a.item);
  }
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

/** The open page a folded place leads with: the one shown when it still waits on the user, else the
 *  next open one after it (from the first again past the last); -1 with none open. `waits`: the
 *  unanswered pages that count at all (a folded line leaves out the snoozed ones). */
export function openPageFrom(pages: readonly ActionItem[], answered: Readonly<Record<string, AnsweredAsk>>, index: number, waits: (item: ActionItem) => boolean = ALL): number {
  for (let k = 0; k < pages.length; k++) {
    const j = (index + k) % pages.length;
    if (!answered[pages[j]!.id] && waits(pages[j]!)) return j;
  }
  return -1;
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
  /** Its send failed: open again where it is (the page shown stays the one he is on). */
  reopen: (id: string) => void;
}

/** `all`: every ask of the task's status (what a mark is judged against, the same in every place);
 *  `accepts`: the ones this place shows. */
export function useAskPages(taskId: string, all: readonly ActionItem[], accepts: (item: ActionItem) => boolean = ALL): AskPages {
  const items = accepts === ALL ? all : all.filter(accepts);
  const read = () => kept.get(taskId) ?? NONE;
  const stored = useSyncExternalStore(hear, read, read);
  const marks = liveMarks(all, stored.answered);
  const now: Kept = { ...stored, answered: marks };
  const pages = pagesOf(items, marks, accepts);
  // Keep the record true to the status: a mark whose ask was dropped learns it is gone (so the
  // same id asked again is new), and a mark that no longer holds is dropped for good.
  const ids = all.map((i) => `${i.id}\t${i.summary}`).join('\n');
  useEffect(() => {
    const cur = kept.get(taskId);
    if (!cur) return;
    const open = new Set(all.map((i) => i.id));
    const live = liveMarks(all, cur.answered);
    let changed = Object.keys(live).length !== Object.keys(cur.answered).length;
    const next: Record<string, AnsweredAsk> = {};
    for (const [id, a] of Object.entries(live)) {
      if (!open.has(id) && !a.gone) { next[id] = { ...a, gone: true }; changed = true; } else next[id] = a;
    }
    if (changed) keep(taskId, { ...cur, answered: next });
  }, [taskId, ids]); // eslint-disable-line react-hooks/exhaustive-deps
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
    // A send that fails late, while he is on another page, never pulls him back: the page says
    // "1 not sent" and the failed one shows its reason when he comes to it.
    const { [id]: _gone, ...rest } = now.answered;
    write({ ...now, answered: rest });
  }, []);
  return { pages, index, answered: now.answered, go, show, answer, reopen };
}
