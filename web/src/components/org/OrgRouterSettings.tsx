/**
 * A router node's settings. On the Org page (OrgNodeDetail) a router shows one line under its
 * header (its area, Paused or Ready for new items, how many VPs it works with) and a button that
 * opens the settings in their own dialog (RouterSettingsDialog, 2026-11-14, the user: a popup
 * window, not a drawer). Apps › Mail opens the same dialog for each mailbox's router, so there is
 * one form and one saved value.
 *
 * The dialog shows the area (set at creation, read only), the mailboxes it reads, the folders it
 * watches (picked from the mailboxes' own folder lists, RouterFolderPicker), which messages of each
 * chat account it takes (direct messages, mentions, watched channels), its name, Paused, and
 * the VPs it works with first; Save sends PATCH /api/v1/org/routers/:id with the changed fields only.
 *
 * A link is preferred collaboration, never ownership and never access to a VP's data. A link that
 * names a task which is no longer an open VP (closed, no longer a VP, or not found) is shown as such,
 * still checked, so the user sees it and can drop it.
 *
 * The edits are a draft (useDraftValue, per router), so closing the dialog, a failed save or a reload
 * keeps what was typed. A save that answers after the dialog moved to another router writes nothing
 * onto that router: its state is keyed by the router it was sent for.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { MicInput, type BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import type { Task } from '@open-walnut/core';
import { routerAreaFolders, routerAreaSources, useRouterAreaNames, type RouterAreaSourceRow } from './router-area-names';
import { setRouterSettingsOpen } from './router-settings-open';
import { areaIdWords, routerStateWord, vpLinkCount } from './org-channels-model';
import { RouterFolderPicker, ROUTER_NO_FOLDER_LINE, folderList, sameFolders } from './RouterFolderPicker';
import { RouterSettingsDialog } from './RouterSettingsDialog';


export interface RouterSettingsValue {
  name: string;
  links: string[];
  paused: boolean;
  /** The watched folders (a role or a folder id each; the default is the Inbox). A draft saved
   *  before the picker may hold them as one comma-separated string. */
  folders?: string[] | string;
  /** Set once the person changed the folders; while unset the folders follow the saved value (a
   *  save made in the other place included) and are never sent back. */
  foldersFrom?: string[] | string;
  /** Per chat account (`kind\naccount`), the labels of the arrivals it takes, as ticked. */
  filters?: Record<string, string[]>;
  /** Set once the person changed a filter; while unset the filters follow the saved value. */
  filtersTyped?: boolean;
}

export interface RouterSettingsPatch {
  name?: string;
  links?: string[];
  paused?: boolean;
  folders?: string[];
  filters?: Array<{ kind: string; account: string; include: string[] }>;
}

/** The kinds of chat arrival a filter ticks, by the label the chat source gives each. */
export const CHAT_FILTER_KINDS: ReadonlyArray<{ label: string; words: string }> = [
  { label: 'dm', words: 'Direct messages' },
  { label: 'mention', words: 'Mentions of you' },
  { label: 'watched', words: 'Watched channels' },
];
const CHAT_LABELS = CHAT_FILTER_KINDS.map((one) => one.label);

export const sourceKey = (src: { kind: string; account: string }) => `${src.kind}\n${src.account}`;

/** A saved `include` as the boxes show it: unset ticks every kind. */
export function filterTicks(include: readonly string[] | undefined): string[] {
  return include?.length ? [...new Set(include)] : [...CHAT_LABELS];
}

/** The ticks as the saved `include`: every kind and nothing else is [] (takes all). */
export function filterInclude(ticks: readonly string[]): string[] {
  const set = [...new Set(ticks)];
  return CHAT_LABELS.every((label) => set.includes(label)) && set.every((label) => CHAT_LABELS.includes(label)) ? [] : set;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((one, i) => one === [...b].sort()[i]);

/** What a link points at now: an open VP, or something that is no longer one. */
export type RouterLinkState = 'open' | 'closed' | 'not-vp' | 'missing';

export interface RouterLinkRow {
  id: string;
  name: string;
  state: RouterLinkState;
}

export const ROUTER_NAME_MAX = 60;
export const ROUTER_PAUSED_LINE = 'Paused. It reads no incoming items until you turn Paused off.';
export const ROUTER_READY_LINE = 'Ready. It reads each new item of its accounts and hands it straight to the task or VP that owns it.';
/** Window event (detail: the router's task id) that opens that router's settings section. */
export const ROUTER_SETTINGS_OPEN_EVENT = 'org:router-settings-open';

/** What "Reads from" means: every new mail of these accounts, in the folders it watches. */
export const ROUTER_SOURCES_NOTE = 'It reads every new mail of these accounts in the folders it watches.';
/** With a chat account among them: what each one's ticks mean. */
export const ROUTER_CHAT_SOURCES_NOTE = 'It reads every new mail of these accounts in the folders it watches, and the ticked kinds of message of each chat account.';
const SOURCE_KIND_WORDS: Record<string, string> = { mail: 'Mail', slack: 'Slack', wechat: 'WeChat' };

export const ROUTER_NO_FILTER_LINE = 'Tick at least one kind of message for each chat account, or pause the router.';

export const ROUTER_LINK_NOTE = 'Links name the VPs it works with first. A link gives no ownership and no access to a VP\'s data.';

/** The router's saved settings, as the form's baseline. */
export function routerBaseline(task: Pick<Task, 'org_name' | 'title' | 'router_links' | 'router_paused'>, folders: readonly string[] = [],
  sources: readonly RouterAreaSourceRow[] = []): RouterSettingsValue {
  // Nothing saved means the plugin's default, the Inbox: shown as the Inbox ticked.
  const chats = sources.filter((src) => src.kind !== 'mail');
  return {
    name: task.org_name || task.title, links: [...(task.router_links ?? [])], paused: task.router_paused !== false, folders: folders.length ? folderList(folders) : ['inbox'],
    ...(chats.length ? { filters: Object.fromEntries(chats.map((src) => [sourceKey(src), filterTicks(src.include)])) } : {}),
  };
}

/** Only the fields that changed (null: nothing to save). Links compare as a set. */
export function routerPatch(saved: RouterSettingsValue, edited: RouterSettingsValue): RouterSettingsPatch | null {
  const patch: RouterSettingsPatch = {};
  const name = edited.name.trim();
  if (name !== saved.name.trim()) patch.name = name;
  const a = [...new Set(saved.links)].sort();
  const b = [...new Set(edited.links)].sort();
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) patch.links = [...new Set(edited.links)];
  if (edited.paused !== saved.paused) patch.paused = edited.paused;
  if (!sameFolders(folderList(saved.folders ?? []), folderList(edited.folders ?? []))) patch.folders = folderList(edited.folders ?? []);
  const filters = Object.entries(edited.filters ?? {}).flatMap(([key, ticks]) => {
    const before = saved.filters?.[key];
    if (!before || sameList(filterInclude(before), filterInclude(ticks))) return [];
    const [kind, ...rest] = key.split('\n');
    return [{ kind: kind!, account: rest.join('\n'), include: filterInclude(ticks) }];
  });
  if (filters.length) patch.filters = filters;
  return Object.keys(patch).length ? patch : null;
}

/** The form as shown: a draft holds the folders only once they were typed; untouched, they are
 *  the saved ones (a save in Apps › Mail included), so an older draft never sends them back. */
export function shownRouterValue(draft: RouterSettingsValue, saved: RouterSettingsValue): RouterSettingsValue {
  const shown = draft.foldersFrom === undefined ? { ...draft, folders: saved.folders } : { ...draft, folders: folderList(draft.folders ?? []) };
  // Untouched filters are the saved ones; a typed draft keeps only the accounts still read.
  if (!draft.filtersTyped) {
    if (saved.filters) shown.filters = saved.filters; else delete shown.filters;
  } else if (saved.filters) {
    shown.filters = Object.fromEntries(Object.keys(saved.filters).map((key) => [key, draft.filters?.[key] ?? saved.filters![key]!]));
  } else delete shown.filters;
  return shown;
}

/** One edit of the draft; the first change to the folders marks them typed. */
export function editRouterValue(draft: RouterSettingsValue, saved: RouterSettingsValue, next: (v: RouterSettingsValue) => RouterSettingsValue): RouterSettingsValue {
  const shown = shownRouterValue(draft, saved);
  let edited = next(shown);
  if (!shown.filtersTyped && JSON.stringify(edited.filters ?? null) !== JSON.stringify(shown.filters ?? null)) edited = { ...edited, filtersTyped: true };
  return shown.foldersFrom === undefined && !sameFolders(folderList(edited.folders ?? []), folderList(shown.folders ?? []))
    ? { ...edited, foldersFrom: folderList(saved.folders ?? []) } : edited;
}

/** Why the form cannot be sent as it is ('' = it can). */
export function routerFormProblem(edited: RouterSettingsValue): string {
  const name = edited.name.trim();
  if (!name) return 'Give the router a name.';
  if (name.length > ROUTER_NAME_MAX) return `A router name is at most ${ROUTER_NAME_MAX} characters.`;
  if (edited.folders !== undefined && folderList(edited.folders).length === 0) return ROUTER_NO_FOLDER_LINE;
  if (Object.values(edited.filters ?? {}).some((ticks) => ticks.length === 0)) return ROUTER_NO_FILTER_LINE;
  return '';
}

export const isOpenVp = (t: Task | undefined): t is Task => !!t && t.org_role === 'lead' && t.phase !== 'COMPLETE';

/** Each link the router holds (saved or edited), with what it points at now. */
export function routerLinkRows(links: readonly string[], tasks: readonly Task[]): RouterLinkRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  return [...new Set(links)].map((id) => {
    const t = byId.get(id);
    if (!t) return { id, name: '', state: 'missing' as const };
    const name = t.org_name || t.title;
    if (t.org_role !== 'lead') return { id, name, state: 'not-vp' as const };
    return { id, name, state: t.phase === 'COMPLETE' ? 'closed' as const : 'open' as const };
  });
}

/** The folded line: its area, Paused or Ready for new items, its VP links (and how many of
 *  them no longer name an open VP). */
export function routerSummary(area: string, saved: RouterSettingsValue, staleLinks: number): string {
  const parts = [area || 'Area not configured', routerStateWord(saved.paused), vpLinkCount(new Set(saved.links).size)];
  if (staleLinks > 0) parts.push(`${staleLinks} not an open VP`);
  return parts.join(' · ');
}

/** The line under links that no longer name an open VP and are still checked. */
export function staleNote(n: number): string {
  return `${n === 1 ? 'One link no longer names an open VP' : `${n} links no longer name an open VP`}. Uncheck to drop ${n === 1 ? 'it' : 'them'}.`;
}

/** The words for a link that is no longer an open VP. */
export function staleLinkLabel(row: RouterLinkRow): string {
  if (row.state === 'closed') return `${row.name} (VP closed)`;
  if (row.state === 'not-vp') return `${row.name} (no longer a VP)`;
  return 'A VP that was closed or removed';
}

interface Props {
  router: Task;
  tasks: readonly Task[];
  /** The task list is still loading: a link not found yet is not called removed. */
  tasksLoading?: boolean;
}

/** The saved settings of a router as the page knows them, and the links that no longer name an open VP. */
export function useRouterSaved(router: Task, tasks: readonly Task[], tasksLoading: boolean) {
  const area = router.router_area_id || '';
  // The area's own name ("Personal"), never its id; the id stays until the areas list answers.
  const areaNames = useRouterAreaNames([area]);
  const savedFolders = (routerAreaFolders()[area] ?? []).join('\n');
  const savedSources = JSON.stringify(routerAreaSources()[area] ?? []);
  const baseline = useMemo(() => routerBaseline(router, savedFolders ? savedFolders.split('\n') : [], JSON.parse(savedSources) as RouterAreaSourceRow[]),
    [router, savedFolders, savedSources, areaNames]);
  const areaLabel = (area && (areaNames[area] || areaIdWords(area))) || area;
  const savedStale = routerLinkRows(baseline.links, tasks).filter((r) => r.state !== 'open' && !(tasksLoading && r.state === 'missing')).length;
  return { area, areaLabel, baseline, savedStale };
}

export function OrgRouterSettings({ router, tasks, tasksLoading = false }: Props) {
  const id = router.id;
  const [open, setOpen] = useState(false);
  const { areaLabel, baseline, savedStale } = useRouterSaved(router, tasks, tasksLoading);
  useEffect(() => { setOpen(false); }, [id]);
  useEffect(() => { setRouterSettingsOpen(id, open); return () => setRouterSettingsOpen(id, false); }, [open, id]);
  // The idle router's "Open settings" (OrgNodeStart) and Mail's From Mail line open the dialog.
  useEffect(() => {
    const show = (event: Event) => { if ((event as CustomEvent<string>).detail === id) setOpen(true); };
    window.addEventListener(ROUTER_SETTINGS_OPEN_EVENT, show);
    return () => window.removeEventListener(ROUTER_SETTINGS_OPEN_EVENT, show);
  }, [id]);

  return (
    <section className="org-router-settings" data-testid="org-router-settings" data-router-id={id} aria-label="Router settings">
      <button
        type="button"
        className="org-router-settings-head"
        data-testid="org-router-settings-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="org-router-settings-title">Router settings</span>
        <span className="org-router-settings-summary" data-testid="org-router-summary">
          {routerSummary(areaLabel, baseline, savedStale)}
        </span>
        <span className="org-router-settings-open" aria-hidden="true">Open</span>
      </button>
      {open && <RouterSettingsDialog router={router} tasks={tasks} tasksLoading={tasksLoading} onClose={() => setOpen(false)} />}
    </section>
  );
}

export interface RouterSettingsBodyProps {
  id: string;
  draftKey: string | null;
  area: string;
  /** The accounts its area may read (mail or Slack); empty until a message's area is confirmed. */
  sources?: ReadonlyArray<{ kind: string; account: string }>;
  value: RouterSettingsValue;
  /** The open VPs a link may name. */
  leads: readonly Task[];
  /** Links that no longer name an open VP. */
  stale: readonly RouterLinkRow[];
  busy: boolean;
  error: string;
  problem: string;
  dirty: boolean;
  justSaved: boolean;
  tasksLoading: boolean;
  onEdit: (next: (v: RouterSettingsValue) => RouterSettingsValue) => void;
  onToggleLink: (id: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  /** Mail account ids to the address Mail shows for them. */
  sourceNames?: Readonly<Record<string, string>>;
  /** The words in the VP finder, shown once there are more than LINK_FILTER_FROM VPs. */
  linkFilter?: string;
  onLinkFilter?: (next: string) => void;
}

/** Each mail account's address (else its display name), by account id. */
export function mailAccountNames(accounts: ReadonlyArray<{ accountId?: string; address?: string; displayName?: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of accounts) {
    const name = (a.address || a.displayName || '').trim();
    if (a.accountId && name) out[a.accountId] = name;
  }
  return out;
}

/** More VPs than this get a finder above the list. */
export const LINK_FILTER_FROM = 8;

/** The VPs the list shows for the finder's words: every linked one, and the others whose name holds the words. */
export function linkFilterMatches(leads: readonly Task[], linked: readonly string[], filter: string): Task[] {
  const words = filter.trim().toLowerCase();
  if (!words) return [...leads];
  return leads.filter((lead) => linked.includes(lead.id) || (lead.org_name || lead.title || '').toLowerCase().includes(words));
}

/** The dialog's form: no hooks and no fetch of its own (the folder picker reads its folder lists), so it renders from its props. */
export function RouterSettingsBody({ id, draftKey: key, area, sources = [], value, leads, stale, busy, error, problem, dirty, justSaved, tasksLoading, onEdit, onToggleLink, onSave, onDiscard, linkFilter = '', onLinkFilter, sourceNames = {} }: RouterSettingsBodyProps) {
  const draftAttr = key ?? undefined;
  const staleChecked = stale.filter((r) => value.links.includes(r.id)).length;
  const shownLeads = linkFilterMatches(leads, value.links, linkFilter);
  // Save waits for a name still being dictated; another router's form never takes that wait.
  const nameMic = useRef<BoxMicHandle | null>(null);
  const gate = useSendAfterDictation([nameMic], () => onSave(), key);
  return (
    <form
      id={id}
      className="org-router-settings-body"
      data-testid="org-router-settings-body"
      onSubmit={(e) => { e.preventDefault(); gate.send(); }}
    >
      <div className="org-router-row">
        <span className="org-router-label">Area</span>
        <div className="org-router-value">
          <span data-testid="org-router-area">{area || 'Not configured'}</span>
          <span className="org-router-hint">Set when the router was made.</span>
        </div>
      </div>
      <div className="org-router-row" data-testid="org-router-sources">
        <span className="org-router-label">Reads from</span>
        <div className="org-router-value">
          {sources.length
            ? <ul className="org-router-sources">{sources.map((src) => (
              <li key={sourceKey(src)} data-account={src.account} data-kind={src.kind}>
                {(src.kind === 'mail' && sourceNames[src.account]) || src.account} <span className="org-router-kind">{SOURCE_KIND_WORDS[src.kind] ?? src.kind}</span>
                {src.kind !== 'mail' && value.filters?.[sourceKey(src)] && (
                  <span className="org-router-filter" role="group" aria-label={`Messages it takes from ${src.account}`} data-testid="org-router-filter">
                    {CHAT_FILTER_KINDS.map((one) => {
                      const ticks = value.filters![sourceKey(src)]!;
                      return (
                        <label key={one.label} className="org-router-check" data-label={one.label}>
                          <input type="checkbox" checked={ticks.includes(one.label)} data-draft-key={draftAttr} disabled={busy}
                            onChange={(e) => {
                              const on = e.target.checked;
                              onEdit((v) => {
                                const now = v.filters?.[sourceKey(src)] ?? ticks;
                                const next = on ? [...new Set([...now, one.label])] : now.filter((label) => label !== one.label);
                                return { ...v, filters: { ...(v.filters ?? {}), [sourceKey(src)]: next } };
                              });
                            }} />
                          {one.words}
                        </label>
                      );
                    })}
                  </span>
                )}
              </li>
            ))}</ul>
            : <span className="org-router-hint">No account yet. The Mail plugin adds each mailbox here.</span>}
          <span className="org-router-hint">{sources.some((src) => src.kind !== 'mail') ? ROUTER_CHAT_SOURCES_NOTE : ROUTER_SOURCES_NOTE}</span>
        </div>
      </div>
      {sources.some((src) => src.kind === 'mail') && (
        <div className="org-router-row" role="group" aria-labelledby={`${id}-folders`}>
          <span className="org-router-label" id={`${id}-folders`}>Watches folders</span>
          <div className="org-router-value">
            <RouterFolderPicker
              accounts={sources.filter((src) => src.kind === 'mail').map((src) => ({ account: src.account, label: sourceNames[src.account] || src.account }))}
              value={folderList(value.folders ?? [])}
              testId="org-router-folders"
              disabled={busy}
              onChange={(folders) => onEdit((v) => ({ ...v, folders }))}
            />
          </div>
        </div>
      )}
      <div className="org-router-row">
        <label className="org-router-label" htmlFor={`${id}-name`}>Name</label>
        <div className="org-router-value">
          <MicInput
            id={`${id}-name`}
            value={value.name}
            maxLength={ROUTER_NAME_MAX}
            data-draft-key={draftAttr}
            data-testid="org-router-name"
            disabled={busy}
            micRef={nameMic}
            target={key}
            setText={(name) => onEdit((v) => ({ ...v, name }))}
          />
        </div>
      </div>
      <div className="org-router-row">
        <span className="org-router-label">State</span>
        <div className="org-router-value">
          <label className="org-router-check">
            <input
              type="checkbox"
              checked={value.paused}
              data-draft-key={draftAttr}
              data-testid="org-router-paused"
              disabled={busy}
              onChange={(e) => { const paused = e.target.checked; onEdit((v) => ({ ...v, paused })); }}
            />
            Paused
          </label>
          <span className="org-router-hint" data-testid="org-router-state-line">{value.paused ? ROUTER_PAUSED_LINE : ROUTER_READY_LINE}</span>
        </div>
      </div>
      <div className="org-router-row org-router-links" role="group" aria-labelledby={`${id}-links`} data-testid="org-router-links">
        <span className="org-router-label" id={`${id}-links`}>Works closely with</span>
        <div className="org-router-value">
        <p className="org-router-hint">{ROUTER_LINK_NOTE}</p>
        {leads.length === 0 && stale.length === 0 && (
          <p className="org-router-hint" data-testid="org-router-no-vps">{tasksLoading ? 'Loading the VPs…' : 'No open VP yet. A router works on its own.'}</p>
        )}
        {leads.length > LINK_FILTER_FROM && onLinkFilter && (
          <MicInput
            type="search"
            className="org-router-link-filter"
            fieldClassName="org-router-link-filter-field"
            data-testid="org-router-link-filter"
            data-no-draft="search"
            placeholder="Find a VP"
            aria-label="Find a VP"
            value={linkFilter}
            disabled={busy}
            setText={onLinkFilter}
            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
          />
        )}
        <div className="org-router-link-list">
        {shownLeads.length === 0 && leads.length > 0 && <p className="org-router-hint" data-testid="org-router-link-none">No VP matches “{linkFilter.trim()}”.</p>}
        {shownLeads.map((lead) => (
          <label key={lead.id} className="org-router-check" data-testid="org-router-link" data-task-id={lead.id} data-link-state="open">
            <input type="checkbox" checked={value.links.includes(lead.id)} data-draft-key={draftAttr} disabled={busy} onChange={() => onToggleLink(lead.id)} />
            {lead.org_name || lead.title}
          </label>
        ))}
        {stale.map((row) => (
          <label key={row.id} className="org-router-check is-stale" data-testid="org-router-link" data-task-id={row.id} data-link-state={row.state}>
            <input type="checkbox" checked={value.links.includes(row.id)} data-draft-key={draftAttr} disabled={busy} onChange={() => onToggleLink(row.id)} />
            {staleLinkLabel(row)}
          </label>
        ))}
        </div>
        {staleChecked > 0 && (
          <p className="org-router-warn" data-testid="org-router-stale-note">{staleNote(staleChecked)}</p>
        )}
        </div>
      </div>
      {error && <p className="org-router-error" role="alert" data-testid="org-router-error">{error}</p>}
      {!error && problem && dirty && <p className="org-router-error" data-testid="org-router-problem">{problem}</p>}
      <div className="org-router-actions">
        <button type="submit" className="btn btn-sm btn-primary" data-testid="org-router-save" disabled={busy || ((!dirty || !!problem) && !gate.micBusy && !gate.waiting)} {...dictationWaitProps(gate)}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-sm" data-testid="org-router-discard" disabled={busy || !dirty} onClick={onDiscard}>
          Discard changes
        </button>
        <span className="org-router-hint" role="status" aria-live="polite" data-testid="org-router-saved">{justSaved ? 'Saved.' : ''}</span>
      </div>
    </form>
  );
}
