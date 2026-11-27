/**
 * What the user closed with a notice's × (NoticeClose), so it stays closed until what it says changes.
 *
 * A key is `${scope}|${signature}`: the scope names the notice and where it shows (a session's error
 * banner: `session-error:<session id>`), the signature what it says now (the error's text, the host's
 * state). Closed, the same words stay hidden, in every window (the `open-walnut-` prefix is what
 * ui-prefs-sync mirrors); new words show again. When the notice has nothing to say (signature null),
 * its scope's keys are dropped, so the same trouble coming back later shows again.
 *
 * localStorage `open-walnut-notice-dismissed`: a JSON array of keys, oldest first. A scope's family
 * (the scope up to its first ':', `session-error`, `approval-corner`) keeps its newest
 * NOTICE_DISMISS_MAX keys, so a family closed often (one key per request or per interrupted turn)
 * never pushes out the close of a state notice; NOTICE_DISMISS_TOTAL bounds the whole list.
 */
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useEffect, useState, useSyncExternalStore } from 'react';

export const NOTICE_DISMISS_KEY = 'open-walnut-notice-dismissed';
/** The keys kept per scope family. */
export const NOTICE_DISMISS_MAX = 300;
/** The keys kept in all. */
export const NOTICE_DISMISS_TOTAL = 2000;

let cache: readonly string[] | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch { return []; }
}

function read(): readonly string[] {
  if (cache) return cache;
  let raw: string | null = null;
  try { raw = localStorage.getItem(NOTICE_DISMISS_KEY); } catch { /* storage disabled */ }
  cache = parse(raw);
  return cache;
}

function write(next: readonly string[]): void {
  cache = next;
  try { localStorage.setItem(NOTICE_DISMISS_KEY, JSON.stringify(next)); } catch { /* storage full or disabled: this window still remembers */ }
  for (const l of listeners) l();
}

/** Another window wrote the list: one listener for the page, fanned out to every reader. */
function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== NOTICE_DISMISS_KEY) return;
  cache = null;
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/** A key's scope family: its scope up to the first ':' (`session-error:<id>` -> `session-error`). */
const familyOf = (key: string): string => {
  const scope = key.slice(0, Math.max(0, key.indexOf('|')));
  const at = scope.indexOf(':');
  return at < 0 ? scope : scope.slice(0, at);
};

/** The list under its caps: each family's newest NOTICE_DISMISS_MAX, then the newest TOTAL. */
export function cappedKeys(list: readonly string[]): string[] {
  const left = new Map<string, number>();
  const kept: string[] = [];
  for (let i = list.length - 1; i >= 0 && kept.length < NOTICE_DISMISS_TOTAL; i--) {
    const f = familyOf(list[i]!);
    const n = left.get(f) ?? NOTICE_DISMISS_MAX;
    if (n <= 0) continue;
    left.set(f, n - 1);
    kept.push(list[i]!);
  }
  return kept.reverse();
}

export const noticeKey = (scope: string, signature: string): string => `${scope}|${signature}`;

export function isNoticeDismissed(scope: string, signature: string): boolean {
  return read().includes(noticeKey(scope, signature));
}

/** Close a notice: its key moves to the newest end; its family's oldest go past the cap. */
export function dismissNotice(scope: string, signature: string): void {
  const key = noticeKey(scope, signature);
  const list = read().filter((k) => k !== key);
  list.push(key);
  write(cappedKeys(list));
}

/** The notice has nothing to say any more: forget what was closed in its scope. */
export function clearNoticeScope(scope: string): void {
  const prefix = `${scope}|`;
  const list = read();
  if (!list.some((k) => k.startsWith(prefix))) return;
  write(list.filter((k) => !k.startsWith(prefix)));
}

/** Keep only the closes of `scope` whose signature is still in `keep` (requests still waiting). */
export function pruneNoticeScope(scope: string, keep: ReadonlySet<string>): void {
  const prefix = `${scope}|`;
  const list = read();
  const next = list.filter((k) => !k.startsWith(prefix) || keep.has(k.slice(prefix.length)));
  if (next.length !== list.length) write(next);
}

/** Forget the closes of `scope` for these signatures (requests that were answered). */
export function forgetNotices(scope: string, gone: Iterable<string>): void {
  const drop = new Set([...gone].map((sig) => noticeKey(scope, sig)));
  const list = read();
  const next = list.filter((k) => !drop.has(k));
  if (next.length !== list.length) write(next);
}

/** Only for tests: forget the cached list (a test that writes localStorage itself). */
export function resetNoticeDismissCache(): void { cache = null; }

/**
 * A notice's × state. `signature` is what it says now; null once it is known to have nothing to say
 * (that drops its scope's closed keys, so the next time the trouble comes it shows); undefined while
 * that is not known yet (loading, a host not heard from), which keeps them. `hidden` is true while
 * the user closed these exact words.
 */
export function useNoticeDismiss(scope: string, signature: string | null | undefined): { hidden: boolean; dismiss: () => void } {
  const list = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (signature === null) clearNoticeScope(scope);
  }, [scope, signature]);
  const hidden = typeof signature === 'string' && list.includes(noticeKey(scope, signature));
  const dismiss = useLeanCallback(() => {
    if (typeof signature === 'string') dismissNotice(scope, signature);
  }, [scope, signature]);
  return { hidden, dismiss };
}

/** The words of a notice's content, for its signature: every string and number under it, in order. */
export function noticeText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(noticeText).join('');
  if (typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    const props = (node as { props?: { children?: unknown; text?: unknown } }).props;
    return noticeText(props?.children) + (typeof props?.text === 'string' ? props.text : '');
  }
  return '';
}

/**
 * A transient line's × (kind 2: a receipt, a "same result" line): it goes now, and the next one
 * (any new value, after this one went or changed) shows again, in the render that brings it.
 * `value` is the line's text or null.
 */
export function useLineClose(value: string | null | undefined): { shown: boolean; close: () => void } {
  const [closedFor, setClosedFor] = useState<string | null>(null);
  // Its words changed or went: the close is spent, so the same words coming back show.
  useEffect(() => { if (closedFor !== null && closedFor !== value) setClosedFor(null); }, [closedFor, value]);
  return { shown: !!value && closedFor !== value, close: () => { if (value) setClosedFor(value); } };
}

/**
 * The × of a notice over a group that changes while it shows (the hosts a connect card lists):
 * closed, it stays hidden while every member shown now was in the group it was closed on, so one
 * that finishes and leaves never brings it back; a new member shows it again, and the group
 * emptying forgets the close.
 */
export function useGroupClose(members: readonly string[]): { shown: boolean; close: () => void } {
  const [closed, setClosed] = useState<ReadonlySet<string> | null>(null);
  const covered = closed !== null && members.length > 0 && members.every((m) => closed.has(m));
  useEffect(() => { if (closed && !covered) setClosed(null); }, [closed, covered]);
  return { shown: members.length > 0 && !covered, close: () => setClosed(new Set(members)) };
}

/**
 * useLineClose for a set of lines kept by key (a file tree's stale notes, one per folder): each
 * line's × hides its words; a line whose words change or go forgets its close, so the same words
 * coming back show again.
 */
export function useKeyedLineClose(lines: ReadonlyMap<string, string>): { shown: (key: string) => boolean; close: (key: string) => void } {
  const [closed, setClosed] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    setClosed((prev) => {
      let next: Map<string, string> | null = null;
      for (const [key, words] of prev) if (lines.get(key) !== words) (next ??= new Map(prev)).delete(key);
      return next ?? prev;
    });
  }, [lines]);
  return {
    shown: (key) => lines.has(key) && closed.get(key) !== lines.get(key),
    close: (key) => {
      const words = lines.get(key);
      if (words !== undefined) setClosed((prev) => new Map(prev).set(key, words));
    },
  };
}
