/**
 * A router node's own settings, folded inline under its header on the Org page (OrgNodeDetail).
 * A router is its own Org node (Task.org_role 'router'): not a VP and not a task under one. Only a
 * router's detail draws this section; a VP never gets any of it.
 *
 *   folded   one line: its area, Paused or Ready for assigned items, how many VPs it works with
 *   open     its area (set at creation, read only here), its name, Paused, and the VPs it works
 *            with first; Save sends PATCH /api/v1/org/routers/:id with the changed fields only
 *
 * A link is preferred collaboration, never ownership and never access to a VP's data. A link that
 * names a task which is no longer an open VP (closed, no longer a VP, or not found) is shown as such,
 * still checked, so the user sees it and can drop it.
 *
 * Inline, never a menu or popover (web/src/AGENTS.md "Menus & overlays"): the section grows in the
 * page, so nothing has to be placed against the viewport. The edits are a draft (useDraftValue,
 * per router), so a failed save or a reload keeps what was typed; whether the section is open is a
 * kept view (usePageViewOf, per router). A save that answers after the page moved to another router
 * writes nothing onto that router: its state is keyed by the router it was sent for.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { apiPatch } from '@/api/client';
import { refreshRouterAreas, routerAreaSources, useRouterAreaNames } from './router-area-names';
import { setRouterSettingsOpen } from './router-settings-open';
import { listMailAccounts } from '@/api/mail';
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { isBoolean, usePageViewOf } from '@/utils/view-memory';
import { areaIdWords, routerStateWord, vpLinkCount } from './org-channels-model';
import { OrgRouterRules } from './OrgRouterRules';

export interface RouterSettingsValue {
  name: string;
  links: string[];
  paused: boolean;
}

export type RouterSettingsPatch = Partial<RouterSettingsValue>;

/** What a link points at now: an open VP, or something that is no longer one. */
export type RouterLinkState = 'open' | 'closed' | 'not-vp' | 'missing';

export interface RouterLinkRow {
  id: string;
  name: string;
  state: RouterLinkState;
}

export const ROUTER_NAME_MAX = 60;
export const ROUTER_PAUSED_LINE = 'Paused. It reads no incoming items until you turn Paused off.';
export const ROUTER_READY_LINE = 'Ready for assigned items. It reads only items routed to its own area, and some source accounts may not be readable yet.';
/** Window event (detail: the router's task id) that opens that router's settings section. */
export const ROUTER_SETTINGS_OPEN_EVENT = 'org:router-settings-open';

/** What "Reads from" means: an account listed here gives the router only the messages chosen for this area. */
export const ROUTER_SOURCES_NOTE = 'From these accounts it reads only the messages you chose for this area, never the rest of the account.';

export const ROUTER_LINK_NOTE = 'Links name the VPs it works with first. A link gives no ownership and no access to a VP\'s data.';

/** The router's saved settings, as the form's baseline. */
export function routerBaseline(task: Pick<Task, 'org_name' | 'title' | 'router_links' | 'router_paused'>): RouterSettingsValue {
  return { name: task.org_name || task.title, links: [...(task.router_links ?? [])], paused: task.router_paused !== false };
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
  return Object.keys(patch).length ? patch : null;
}

/** Why the form cannot be sent as it is ('' = it can). */
export function routerFormProblem(edited: RouterSettingsValue): string {
  const name = edited.name.trim();
  if (!name) return 'Give the router a name.';
  if (name.length > ROUTER_NAME_MAX) return `A router name is at most ${ROUTER_NAME_MAX} characters.`;
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

/** The folded line: its area, Paused or Ready for assigned items, its VP links (and how many of
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

export function OrgRouterSettings({ router, tasks, tasksLoading = false }: Props) {
  const id = router.id;
  // The VP finder's words: a typed search, so it starts empty for each router.
  const [vpQuery, setVpQuery] = useState('');
  useEffect(() => { setVpQuery(''); }, [id]);
  const [expanded, setExpanded] = usePageViewOf<boolean>('org', 'router.settings', id, false, isBoolean);
  /** The router as the last save here answered it, until the task list catches up. */
  const [saved, setSaved] = useState<Task | null>(null);
  /** Which router a save is on its way for (null: none). */
  const [pendingFor, setPendingFor] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const [savedAt, setSavedAt] = useState<{ id: string; at: number } | null>(null);
  const currentId = useRef(id);
  currentId.current = id;
  const seq = useRef(0);
  useEffect(() => () => { seq.current++; }, []);

  const fresh = saved && saved.id === id && (saved.updated_at ?? '') >= (router.updated_at ?? '') ? saved : router;
  const baseline = useMemo(() => routerBaseline(fresh), [fresh]);
  const form = useDraftValue<RouterSettingsValue>(draftKey('org-router-settings', id), baseline);
  const value = form.value;
  const busy = pendingFor === id;
  const error = failure?.id === id ? failure.text : '';
  const patch = routerPatch(baseline, value);
  const problem = routerFormProblem(value);

  const leads = useMemo(() => tasks.filter(isOpenVp), [tasks]);
  // Links that no longer name an open VP: the saved ones, and any still checked in the draft. While
  // the list loads, a link not found yet is not called removed.
  const stale = routerLinkRows([...baseline.links, ...value.links], tasks)
    .filter((r) => r.state !== 'open' && !(tasksLoading && r.state === 'missing'));
  const savedStale = stale.filter((r) => baseline.links.includes(r.id)).length;

  const toggleLink = (linkId: string) => form.setValue((v) => ({
    ...v, links: v.links.includes(linkId) ? v.links.filter((x) => x !== linkId) : [...v.links, linkId],
  }));

  const save = async () => {
    if (busy || !patch || problem) return;
    const forId = id;
    const sentKey = form.key;
    const sentText = JSON.stringify(value);
    const mine = ++seq.current;
    setPendingFor(forId);
    setFailure(null);
    try {
      const res = await apiPatch<{ task?: Task }>(`/api/v1/org/routers/${encodeURIComponent(forId)}`, patch);
      // The draft was saved whatever is on screen now; clear only that router's copy (useDraft's
      // sentKey rule leaves another router's words alone).
      form.clear(sentKey, sentText);
      if (mine !== seq.current || currentId.current !== forId) return;
      if (res?.task && res.task.id === forId) setSaved(res.task);
      setSavedAt({ id: forId, at: Date.now() });
    } catch (err) {
      if (mine !== seq.current || currentId.current !== forId) return;
      setFailure({ id: forId, text: err instanceof Error ? err.message : 'The router settings were not saved.' });
    } finally {
      if (mine === seq.current && currentId.current === forId) setPendingFor(null);
    }
  };

  const area = fresh.router_area_id || '';
  // Opening the settings reads the areas again: choosing this area for a message in Mail or Slack
  // adds its account on the server, and "Reads from" must show it without a reload.
  useEffect(() => { if (expanded) refreshRouterAreas(); }, [expanded, id]);
  useEffect(() => { setRouterSettingsOpen(id, expanded); return () => setRouterSettingsOpen(id, false); }, [expanded, id]);
  // "Reads from" names a mail account by its address, the way Mail shows it, never by its id.
  const [mailNames, setMailNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    listMailAccounts()
      .then((r) => { if (live) setMailNames(mailAccountNames(r?.accounts ?? [])); })
      .catch(() => { /* the id stays */ });
    return () => { live = false; };
  }, [expanded]);
  // The idle router's "Open settings" (OrgNodeStart) opens this section.
  useEffect(() => {
    const open = (event: Event) => { if ((event as CustomEvent<string>).detail === id) setExpanded(true); };
    window.addEventListener(ROUTER_SETTINGS_OPEN_EVENT, open);
    return () => window.removeEventListener(ROUTER_SETTINGS_OPEN_EVENT, open);
  }, [id, setExpanded]);
  // The area's own name ("Personal"), never its id; the id stays until the areas list answers.
  const areaNames = useRouterAreaNames([area]);
  const areaLabel = (area && (areaNames[area] || areaIdWords(area))) || area;
  const regionId = `org-router-settings-${id}`;
  const justSaved = savedAt?.id === id && !patch;

  return (
    <section className={`org-router-settings${expanded ? ' is-open' : ''}`} data-testid="org-router-settings" data-router-id={id} aria-label="Router settings">
      <button
        type="button"
        className="org-router-settings-head"
        data-testid="org-router-settings-toggle"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="org-router-settings-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="org-router-settings-title">Router settings</span>
        <span className="org-router-settings-summary" data-testid="org-router-summary">
          {routerSummary(areaLabel, baseline, savedStale)}
        </span>
      </button>
      {expanded && (
        <div className="org-router-settings-scroll">
          <RouterSettingsBody
            id={regionId} draftKey={form.key} area={areaLabel} sources={routerAreaSources()[area] ?? []} sourceNames={mailNames} value={value} leads={leads} stale={stale}
            busy={busy} error={error} problem={problem} dirty={!!patch} justSaved={justSaved} tasksLoading={tasksLoading}
            linkFilter={vpQuery} onLinkFilter={setVpQuery}
            onEdit={form.setValue} onToggleLink={toggleLink} onSave={() => { void save(); }} onDiscard={() => { form.clear(); setFailure(null); }}
          />
          <OrgRouterRules key={id} areaId={area} />
        </div>
      )}
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

/** The open section: no hooks and no fetch of its own, so it renders from its props alone. */
export function RouterSettingsBody({ id, draftKey: key, area, sources = [], value, leads, stale, busy, error, problem, dirty, justSaved, tasksLoading, onEdit, onToggleLink, onSave, onDiscard, linkFilter = '', onLinkFilter, sourceNames = {} }: RouterSettingsBodyProps) {
  const draftAttr = key ?? undefined;
  const staleChecked = stale.filter((r) => value.links.includes(r.id)).length;
  const shownLeads = linkFilterMatches(leads, value.links, linkFilter);
  return (
    <form
      id={id}
      className="org-router-settings-body"
      data-testid="org-router-settings-body"
      onSubmit={(e) => { e.preventDefault(); onSave(); }}
    >
      <div className="org-router-field">
        <span className="org-router-label">Area</span>
        <span data-testid="org-router-area">{area || 'Not configured'}</span>
        <span className="org-router-hint">Set when the router was made. It reads only items routed to this area.</span>
      </div>
      <div className="org-router-field" data-testid="org-router-sources">
        <span className="org-router-label">Reads from</span>
        {sources.length
          ? <ul className="org-router-sources">{sources.map((src) => <li key={`${src.kind}\n${src.account}`} data-account={src.account}>{(src.kind === 'mail' && sourceNames[src.account]) || src.account} <span className="org-router-hint">({src.kind === 'slack' ? 'Slack' : 'Mail'})</span></li>)}</ul>
          : <span className="org-router-hint">No account yet. When you choose this area for a message in Mail or Slack, its account shows here.</span>}
        <span className="org-router-hint">{ROUTER_SOURCES_NOTE}</span>
      </div>
      <label className="org-router-field">
        <span className="org-router-label">Name</span>
        <input
          value={value.name}
          maxLength={ROUTER_NAME_MAX}
          data-draft-key={draftAttr}
          data-testid="org-router-name"
          disabled={busy}
          onChange={(e) => { const name = e.target.value; onEdit((v) => ({ ...v, name })); }}
        />
      </label>
      <div className="org-router-field">
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
      <fieldset className="org-router-links" data-testid="org-router-links">
        <legend>Works closely with</legend>
        <p className="org-router-hint">{ROUTER_LINK_NOTE}</p>
        {leads.length === 0 && stale.length === 0 && (
          <p className="org-router-hint" data-testid="org-router-no-vps">{tasksLoading ? 'Loading the VPs…' : 'No open VP yet. A router works on its own.'}</p>
        )}
        {leads.length > LINK_FILTER_FROM && onLinkFilter && (
          <input
            type="search"
            className="org-router-link-filter"
            data-testid="org-router-link-filter"
            data-no-draft="search"
            placeholder="Find a VP"
            aria-label="Find a VP"
            value={linkFilter}
            disabled={busy}
            onChange={(e) => onLinkFilter(e.target.value)}
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
      </fieldset>
      {error && <p className="org-router-error" role="alert" data-testid="org-router-error">{error}</p>}
      {!error && problem && dirty && <p className="org-router-error" data-testid="org-router-problem">{problem}</p>}
      <div className="org-router-actions">
        <button type="submit" className="btn btn-sm btn-primary" data-testid="org-router-save" disabled={busy || !dirty || !!problem}>
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
