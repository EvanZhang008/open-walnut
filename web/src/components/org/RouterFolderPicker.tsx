/**
 * The folders a router watches, picked from the mailboxes' own folder lists (2026-11-14, the user:
 * the folders should load by themselves and be picked, not typed). One picker, in the one router settings dialog
 * (RouterSettingsDialog), opened from the Org page and from Apps › Mail alike; it saves the router's
 * own list (PATCH /api/v1/org/routers/:id `folders`), read back from GET /api/v1/router/areas.
 *
 * What a saved entry means is what the intake matches (src/integrations/mail/router-intake.ts
 * `watchesFolder`): a folder's role, name or id. So a role folder (Inbox, Sent, Archive...) is saved
 * as its role and covers that folder in every mailbox the router reads; any other folder is saved
 * as its id, which is exact. An entry saved earlier that names no folder listed now (a name typed
 * before the picker, a folder since removed) stays listed and ticked, so it is never dropped unseen.
 *
 * The lists come from each account's cached folder list (GET /api/plugins/mail/mailboxes), the one
 * the mail sync refreshes from the provider. A folder nests under another listed folder of the same
 * account whose id prefixes its own (`Projects/Alpha` under `Projects`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { listMailboxes, type MailboxDto } from '@/api/mail';
import '@/styles/router-settings.css';
import { MicInput } from '@/components/common/BoxMic';
import { Checkbox } from '@/components/controls';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';

export const ROUTER_NO_INBOX_LINE = 'Inbox is not ticked: new Inbox mail of these mailboxes goes to no one. Tick Inbox to keep it.';
export const ROUTER_NO_FOLDER_LINE = 'Pick at least one folder.';
/** More folders than this get a finder above the list. */
export const FOLDER_FILTER_FROM = 12;

const ROLE_ORDER = ['inbox', 'archive', 'sent', 'drafts', 'spam', 'trash'] as const;
const ROLE_LABEL: Record<string, string> = { inbox: 'Inbox', archive: 'Archive', sent: 'Sent', drafts: 'Drafts', spam: 'Spam', trash: 'Trash' };

const low = (s: string) => s.trim().toLowerCase();

/** A saved list as the server keeps it: trimmed, no blanks, no repeats (case-insensitive). */
export function folderList(entries: readonly string[] | string): string[] {
  const raw = typeof entries === 'string' ? entries.split(',') : entries;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const one of raw) {
    const t = one.trim();
    if (!t || seen.has(low(t))) continue;
    seen.add(low(t));
    out.push(t);
  }
  return out;
}

/** Whether two lists watch the same folders (order and case aside). */
export function sameFolders(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(folderList(a).map(low));
  const right = new Set(folderList(b).map(low));
  return left.size === right.size && [...left].every((one) => right.has(one));
}

/** Whether a list leaves the Inbox out (an empty one asks for a folder instead). */
export function foldersSkipInbox(entries: readonly string[]): boolean {
  const list = folderList(entries);
  return list.length > 0 && !list.some((one) => low(one) === 'inbox');
}

export interface FolderOption {
  /** What ticking it saves: the role for a role folder, else the folder's id. */
  token: string;
  label: string;
  depth: number;
  /** Other words a saved entry may use for it (a name typed earlier). */
  aliases: string[];
}

export interface FolderGroup {
  key: string;
  /** '' for the roles every mailbox shares. */
  account: string;
  title: string;
  options: FolderOption[];
}

/** The picker's rows: the roles of every mailbox first (Inbox always), then each account's own folders as a tree. */
export function folderGroups(lists: ReadonlyArray<{ account: string; label: string; mailboxes: readonly Pick<MailboxDto, 'mailboxId' | 'name' | 'role'>[] }>): FolderGroup[] {
  const roles = new Set<string>(['inbox']);
  for (const list of lists) for (const m of list.mailboxes) if (m.role !== 'other' && ROLE_LABEL[m.role]) roles.add(m.role);
  const shared: FolderGroup = {
    key: 'roles', account: '', title: lists.length > 1 ? 'Every mailbox' : 'Folders',
    options: ROLE_ORDER.filter((r) => roles.has(r)).map((r) => ({ token: r, label: ROLE_LABEL[r]!, depth: 0, aliases: [] })),
  };
  const own = lists.map((list) => {
    const others = list.mailboxes.filter((m) => m.role === 'other' || !ROLE_LABEL[m.role])
      .slice().sort((a, b) => a.mailboxId.localeCompare(b.mailboxId, undefined, { sensitivity: 'base' }));
    const ids = others.map((m) => m.mailboxId);
    return {
      key: `account:${list.account}`, account: list.account, title: list.label,
      options: others.map((m) => ({
        token: m.mailboxId,
        label: m.name || m.mailboxId,
        // How many listed folders of this account contain it.
        depth: ids.filter((id) => id !== m.mailboxId && (m.mailboxId.startsWith(`${id}/`) || m.mailboxId.startsWith(`${id}.`))).length,
        aliases: m.name && low(m.name) !== low(m.mailboxId) ? [m.name] : [],
      })),
    };
  }).filter((g) => g.options.length > 0);
  return [shared, ...own];
}

/** Whether a saved list ticks this row. */
export function optionTicked(option: FolderOption, entries: readonly string[]): boolean {
  const words = new Set([option.token, ...option.aliases].map(low));
  return entries.some((one) => words.has(low(one)));
}

/** The list after ticking or unticking one row (every entry that names it goes when it is unticked). */
export function toggleFolder(entries: readonly string[], option: FolderOption, on: boolean): string[] {
  const words = new Set([option.token, ...option.aliases].map(low));
  const rest = entries.filter((one) => !words.has(low(one)));
  return on ? [...rest, option.token] : rest;
}

/** Saved entries no listed folder answers to: kept and shown, never dropped unseen. */
export function unlistedEntries(entries: readonly string[], groups: readonly FolderGroup[]): string[] {
  const known = new Set(groups.flatMap((g) => g.options.flatMap((o) => [o.token, ...o.aliases])).map(low));
  return folderList(entries).filter((one) => !known.has(low(one)));
}

type Load = { state: 'loading' } | { state: 'ok'; mailboxes: MailboxDto[] } | { state: 'failed'; error: string };

interface Props {
  /** The mail accounts the router reads, with the words Mail shows for each. */
  accounts: ReadonlyArray<{ account: string; label: string }>;
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  testId?: string;
}

export function RouterFolderPicker({ accounts, value, onChange, disabled, testId = 'router-folders' }: Props) {
  const [loads, setLoads] = useState<Record<string, Load>>({});
  const [filter, setFilter] = useState('');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const accountKey = accounts.map((a) => a.account).join('\n');
  const load = useLeanCallback((ids: readonly string[]) => {
    if (!ids.length) return;
    setLoads((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, { state: 'loading' } as Load])) }));
    for (const id of ids) {
      listMailboxes(id)
        .then((r) => { if (live.current) setLoads((prev) => ({ ...prev, [id]: { state: 'ok', mailboxes: r?.mailboxes ?? [] } })); })
        .catch((err: unknown) => {
          if (live.current) setLoads((prev) => ({ ...prev, [id]: { state: 'failed', error: err instanceof Error ? err.message : 'The folder list could not be read.' } }));
        });
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(accounts.map((a) => a.account)); }, [accountKey, load]);

  // Rebuilt when a read answers or a mailbox's words change (accounts is a fresh array every render).
  const labelKey = accounts.map((a) => `${a.account}\t${a.label}`).join('\n');
  const groups = useMemo(() => folderGroups(accounts.flatMap((a) => {
    const one = loads[a.account];
    return one?.state === 'ok' ? [{ account: a.account, label: a.label, mailboxes: one.mailboxes }] : [];
  })), [loads, labelKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const loading = accounts.some((a) => (loads[a.account]?.state ?? 'loading') === 'loading');
  const failed = accounts.filter((a) => loads[a.account]?.state === 'failed');
  const allRead = !loading && failed.length === 0;
  const unlisted = allRead ? unlistedEntries(value, groups) : [];
  const total = groups.reduce((n, g) => n + g.options.length, 0);
  const words = low(filter);
  const shownGroups = words
    ? groups.map((g) => ({ ...g, options: g.options.filter((o) => low(o.label).includes(words) || low(o.token).includes(words) || optionTicked(o, value)) })).filter((g) => g.options.length)
    : groups;
  const skips = foldersSkipInbox(value);
  const empty = folderList(value).length === 0;

  const row = (option: FolderOption, group: string) => {
    const ticked = optionTicked(option, value);
    return (
      <label
        key={`${group}\n${option.token}`}
        className={`router-folder${ticked ? ' is-on' : ''}`}
        style={option.depth ? { paddingLeft: 8 + option.depth * 18 } : undefined}
        data-testid={`${testId}-option`}
        data-token={option.token}
      >
        <Checkbox checked={ticked} disabled={disabled} onChange={(on) => onChange(toggleFolder(value, option, on))} />
        <span className="router-folder-name wn-title">{option.label}</span>
      </label>
    );
  };

  return (
    <div className="router-folder-picker" data-testid={testId} aria-busy={loading || undefined}>
      {total > FOLDER_FILTER_FROM && (
        <MicInput
          type="search"
          className="router-folder-filter"
          placeholder="Find a folder"
          aria-label="Find a folder"
          data-no-draft="search"
          data-testid={`${testId}-filter`}
          value={filter}
          setText={setFilter}
          onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
        />
      )}
      <div className="router-folder-list" role="group" aria-label="Folders it watches">
        {shownGroups.map((g) => (
          <div key={g.key} className="router-folder-group" data-testid={`${testId}-group`} data-account={g.account}>
            {(g.account || shownGroups.length > 1) && <div className="router-folder-group-title wn-title">{g.title}</div>}
            {g.options.map((o) => row(o, g.key))}
          </div>
        ))}
        {unlisted.length > 0 && (
          <div className="router-folder-group" data-testid={`${testId}-unlisted`}>
            <div className="router-folder-group-title wn-title">Saved earlier, not found now</div>
            {unlisted.map((entry) => row({ token: entry, label: entry, depth: 0, aliases: [] }, 'unlisted'))}
          </div>
        )}
        {loading && <LoadingState size="row" title="Reading the folders…" testId={`${testId}-loading`} />}
        {failed.map((a) => (
          <UnavailableState
            key={a.account} size="row" title={`Could not read the folders of ${a.label}`} testId={`${testId}-error`} data={{ account: a.account }}
            action={{ label: 'Try again', onClick: () => load([a.account]), testId: `${testId}-retry` }}
          />
        ))}
        {words && shownGroups.length === 0 && <EmptyState size="row" title={`No folder matches “${filter.trim()}”`} />}
      </div>
      {skips && <p className="router-folder-warn" role="status" data-testid={`${testId}-no-inbox`}>{ROUTER_NO_INBOX_LINE}</p>}
      {empty && <p className="router-folder-warn" role="status" data-testid={`${testId}-none`}>{ROUTER_NO_FOLDER_LINE}</p>}
    </div>
  );
}
