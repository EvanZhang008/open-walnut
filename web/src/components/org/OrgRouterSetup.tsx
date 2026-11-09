/**
 * The Org page's "New router" form (POST /api/v1/org/routers). A router is its own node beside the
 * VPs, not a VP: it may work closely with none, one or several VPs, and a link is preferred
 * collaboration, never ownership and never access to a VP's data. It is created paused; once made,
 * the page selects it and its own settings (OrgRouterSettings) edit its name, links and Paused.
 *
 * The fields are one draft (useDraftValue), so a failed create or a reload keeps what was typed.
 */
import { useState } from 'react';
import type { Task } from '@open-walnut/core';
import { apiPost } from '@/api/client';
import { useDraftValue } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { useRevealWhen } from './use-reveal';
import { LINK_FILTER_FROM, ROUTER_LINK_NOTE, ROUTER_NAME_MAX, isOpenVp, linkFilterMatches } from './OrgRouterSettings';

const SETUP_KEY = draftKey('org-router-setup', 'new');
export const ROUTER_SETUP_AREAS = [{ id: 'personal', name: 'Personal' }, { id: 'work', name: 'Work' }] as const;
const AREAS = ROUTER_SETUP_AREAS;

/** The open router an area already has (one per area): the form opens it instead of making another. */
export function existingRouterFor(tasks: readonly Task[], areaId: string): Task | undefined {
  return tasks.find((t) => t.org_role === 'router' && t.phase !== 'COMPLETE' && t.router_area_id === areaId);
}

export function OrgRouterSetup({ tasks, onDone, onCancel }: {
  tasks: readonly Task[]; onDone: (taskId: string) => void; onCancel: () => void;
}) {
  const draft = useDraftValue(SETUP_KEY, { name: '', area: 'personal', links: [] as string[] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRevealWhen<HTMLParagraphElement>(error);
  const leads = tasks.filter(isOpenVp);
  // The same finder and scrolling list as the router's settings: 20 VPs pushed Create far down.
  const [vpQuery, setVpQuery] = useState('');
  const shownLeads = linkFilterMatches(leads, draft.value.links, vpQuery);
  const existing = existingRouterFor(tasks, draft.value.area);
  const save = async () => {
    // An area that has its router opens it: no POST, and the typed draft stays for a new area.
    if (existing) { onDone(existing.id); return; }
    const name = draft.value.name.trim();
    if (busy || !name) return;
    const area = AREAS.find((a) => a.id === draft.value.area) ?? AREAS[0];
    // A link to a VP closed while the form was open is dropped, never sent.
    const links = draft.value.links.filter((id) => leads.some((l) => l.id === id));
    const sentText = JSON.stringify(draft.value);
    setBusy(true); setError('');
    try {
      const result = await apiPost<{ task: Task }>('/api/v1/org/routers', {
        name, area_id: area.id, area_name: area.name, host: '__local__', links, sources: [],
      });
      draft.clear(SETUP_KEY, sentText);
      onDone(result.task.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Router setup failed.');
    } finally { setBusy(false); }
  };
  // The area comes first: an area that already has its router offers to open it right there, and the
  // rest of the form (name, VP links) is for a new router only.
  return <form className="org-router-setup" data-testid="org-router-setup" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <h3>New router</h3>
    <p>A router sits beside the VPs, not under them. {ROUTER_LINK_NOTE}</p>
    <fieldset><legend>Area</legend>{AREAS.map((area) => <label key={area.id}>
      <input type="radio" name="router-area" checked={draft.value.area === area.id} data-draft-key={draft.key ?? undefined} onChange={() => draft.setValue((value) => ({ ...value, area: area.id }))} disabled={busy} />{area.name}
    </label>)}</fieldset>
    {existing ? <>
      <p data-testid="router-setup-existing" data-task-id={existing.id}>This area already has a router: <strong>{existing.org_name || existing.title}</strong>. Open it to change its name or VP links.</p>
      <div className="org-router-setup-actions">
        <button type="submit" className="btn btn-sm btn-primary" data-testid="router-setup-open-existing">Open router</button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </> : <>
      <label>Name<input value={draft.value.name} maxLength={ROUTER_NAME_MAX} data-draft-key={draft.key ?? undefined} onChange={(event) => draft.setValue((value) => ({ ...value, name: event.target.value }))} data-testid="router-name" disabled={busy} /></label>
      <fieldset><legend>Works closely with (optional)</legend>
        {leads.length === 0 && <p data-testid="router-setup-no-vps">No open VP yet. A router works on its own.</p>}
        {leads.length > LINK_FILTER_FROM && (
          <input type="search" className="org-router-link-filter" data-testid="router-setup-vp-filter" data-no-draft="search"
            placeholder="Find a VP" aria-label="Find a VP" value={vpQuery} disabled={busy} onChange={(event) => setVpQuery(event.target.value)} />
        )}
        <div className="org-router-link-list">
          {shownLeads.length === 0 && leads.length > 0 && <p className="org-router-hint" data-testid="router-setup-vp-none">No VP matches “{vpQuery.trim()}”.</p>}
          {shownLeads.map((lead) => <label key={lead.id} className="org-router-check" data-testid="router-setup-vp" data-task-id={lead.id}>
            <input type="checkbox" checked={draft.value.links.includes(lead.id)} data-draft-key={draft.key ?? undefined} disabled={busy} onChange={() => draft.setValue((value) => ({ ...value, links: value.links.includes(lead.id) ? value.links.filter((id) => id !== lead.id) : [...value.links, lead.id] }))} />{lead.org_name || lead.title}
          </label>)}
        </div>
      </fieldset>
      <p>Created paused. It reads a message only after you confirm that message's area, or a rule does.</p>
      {error && <p ref={errorRef} role="alert" data-testid="router-setup-error">{error}</p>}
      <div className="org-router-setup-actions">
        <button type="submit" className="btn btn-sm btn-primary" data-testid="router-setup-create" disabled={busy || !draft.value.name.trim()}>{busy ? 'Creating…' : 'Create router'}</button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </>}
  </form>;
}
