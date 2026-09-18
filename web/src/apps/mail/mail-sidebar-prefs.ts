/**
 * How this person has arranged their own mail sidebar: which groups are open, which ordinary folders
 * they opened lately, and which row they were reading.
 *
 * In `localStorage` for the same reason as `mail-unread-filter.ts`: none of it is any server's answer,
 * and leaving Mail and coming back has to look the way they left it. ONE key for the whole blob, read
 * once, so the first paint of the pane is a single storage access rather than one per account.
 *
 * Every access is guarded. `localStorage` throws outright in some private windows and when the origin's
 * quota is full, and a reading preference is never worth taking the console down for: a parse failure or
 * a throw reads as everything collapsed with no recent folders, which is exactly the default view.
 *
 * Keys of accounts that no longer exist are PRUNED on read, so the next write persists the pruned shape.
 * Deleting an account otherwise leaves its expanded state and a list of its folder ids behind forever.
 */
import { SMART_ACCOUNT } from './mail-store';
// Imported rather than repeated: this file TRUNCATES the remembered list and the promotion rule READS
// it, so two copies of the number would let one store five ids the other silently ignores.
import { RECENT_CAP } from './mail-smart';

const KEY = 'walnut.mail.sidebar.v1';

export type SmartPrefId = 'inbox' | 'sent' | 'drafts';

export interface SidebarPrefs {
  /** Which smart rows are expanded. Absent means collapsed, which is the default view. */
  smart: Partial<Record<SmartPrefId, 1>>;
  /** Which accounts have their folder tail expanded. */
  tail: Record<string, 1>;
  /** Ordinary folder ids per account, newest first, capped. */
  recent: Record<string, string[]>;
  /** The row that was selected, validated by the caller before it is adopted. */
  selected?: { accountId: string; mailboxId: string };
}

function empty(): SidebarPrefs {
  return { smart: {}, tail: {}, recent: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The raw blob, or the collapsed default. Never throws and never returns a partial shape. */
function readRaw(): SidebarPrefs {
  try {
    const text = window.localStorage.getItem(KEY);
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!isRecord(parsed)) return empty();
    const prefs = empty();
    if (isRecord(parsed.smart)) {
      for (const id of ['inbox', 'sent', 'drafts'] as SmartPrefId[]) {
        if (parsed.smart[id] === 1) prefs.smart[id] = 1;
      }
    }
    if (isRecord(parsed.tail)) {
      for (const [accountId, on] of Object.entries(parsed.tail)) {
        if (on === 1 && accountId) prefs.tail[accountId] = 1;
      }
    }
    if (isRecord(parsed.recent)) {
      for (const [accountId, list] of Object.entries(parsed.recent)) {
        if (!accountId || !Array.isArray(list)) continue;
        const ids = list.filter((one): one is string => typeof one === 'string' && !!one);
        if (ids.length > 0) prefs.recent[accountId] = ids.slice(0, RECENT_CAP);
      }
    }
    if (isRecord(parsed.selected)) {
      const { accountId, mailboxId } = parsed.selected;
      if (typeof accountId === 'string' && accountId && typeof mailboxId === 'string' && mailboxId) {
        prefs.selected = { accountId, mailboxId };
      }
    }
    return prefs;
  } catch {
    return empty();
  }
}

function write(prefs: SidebarPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // A preference the browser refuses to keep is still applied to the pane on screen: an expand that
    // fails to persist still expands.
  }
}

/**
 * The whole blob, with the keys of accounts that no longer exist removed.
 *
 * Pruning happens on READ so the next write persists the pruned shape: `tail`, `recent` and `selected`
 * are all keyed by account id, and a deleted account would otherwise keep its expanded state and a list
 * of its folder ids for the life of the origin.
 *
 * An EMPTY `accountIds` prunes nothing. It means the accounts request has not landed yet (the pane's
 * first frame), and treating that as "there are no accounts" would erase a real preference on the next
 * write. A reserved smart selection is never pruned either: its account id belongs to no provider, and
 * whether the row is visible is decided against the mailbox rows by the caller.
 */
export function readSidebarPrefs(accountIds: string[]): SidebarPrefs {
  const prefs = readRaw();
  if (accountIds.length === 0) return prefs;
  const live = new Set(accountIds);
  for (const accountId of Object.keys(prefs.tail)) if (!live.has(accountId)) delete prefs.tail[accountId];
  for (const accountId of Object.keys(prefs.recent)) if (!live.has(accountId)) delete prefs.recent[accountId];
  if (prefs.selected && prefs.selected.accountId !== SMART_ACCOUNT && !live.has(prefs.selected.accountId)) {
    delete prefs.selected;
  }
  return prefs;
}

export function writeSmartExpanded(accountIds: string[], id: SmartPrefId, on: boolean): void {
  const prefs = readSidebarPrefs(accountIds);
  if (on) prefs.smart[id] = 1;
  else delete prefs.smart[id];
  write(prefs);
}

export function writeTailExpanded(accountIds: string[], accountId: string, on: boolean): void {
  if (!accountId) return;
  const prefs = readSidebarPrefs(accountIds);
  if (on) prefs.tail[accountId] = 1;
  else delete prefs.tail[accountId];
  write(prefs);
}

/**
 * Remember an ordinary folder this person just opened: newest first, deduped, capped at three.
 *
 * The cap is what keeps the promotion block small. A fourth entry pushes the oldest out, and that
 * folder goes back into the collapsed tail on the next render.
 */
export function noteRecentFolder(accountIds: string[], accountId: string, mailboxId: string): void {
  if (!accountId || !mailboxId) return;
  const prefs = readSidebarPrefs(accountIds);
  const held = (prefs.recent[accountId] ?? []).filter((one) => one !== mailboxId);
  prefs.recent[accountId] = [mailboxId, ...held].slice(0, RECENT_CAP);
  write(prefs);
}

export function readRecentFolders(accountIds: string[], accountId: string): string[] {
  return readSidebarPrefs(accountIds).recent[accountId] ?? [];
}

/** The row that was selected. Written on every selection change, into the same one key. */
export function writeSelectedPref(
  accountIds: string[],
  selected: { accountId: string; mailboxId: string } | null,
): void {
  const prefs = readSidebarPrefs(accountIds);
  if (selected && selected.accountId && selected.mailboxId) prefs.selected = { ...selected };
  else delete prefs.selected;
  write(prefs);
}

/**
 * What was selected last time, or null.
 *
 * Deliberately NOT validated here: whether a smart row is visible, and whether a real pair still exists,
 * are questions about the mailbox rows this file has never seen. The caller adopts it only when it is
 * still real, and falls back to the ordinary automatic selection otherwise.
 */
export function readSelectedPref(accountIds: string[]): { accountId: string; mailboxId: string } | null {
  return readSidebarPrefs(accountIds).selected ?? null;
}

export function readSmartExpanded(accountIds: string[]): Partial<Record<SmartPrefId, 1>> {
  return readSidebarPrefs(accountIds).smart;
}

export function readTailExpanded(accountIds: string[], accountId: string): boolean {
  return readSidebarPrefs(accountIds).tail[accountId] === 1;
}

/** Tests only: forget the blob. */
export function __clearSidebarPrefs(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* nothing to forget */ }
}
