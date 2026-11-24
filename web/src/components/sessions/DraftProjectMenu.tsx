/**
 * The "Repo or package" field's menu (experiment `project_first_start`, v6; named for the code a
 * start works on, Evan 2026-11-23): a search, the ones used last, then the repos and packages (a
 * project with a code source), then the projects with no code (they work in a folder), "None" (the
 * Inbox) and "Customize Walnut" (a session in Walnut's own code) where the owner offers it. Each
 * row says what its Auto makes and where; a pick restores the project's last place
 * (useDraftWhere.pickProject). Mounted per open, so the search starts empty.
 */
import { useState } from 'react';
import * as ICONS from '@/components/common/Icons';
import { SearchField } from '@/components/common/SearchField';
import { useProjectRegistry, type ProjectRegistryRow } from '@/hooks/useProjectRegistry';
import { projectDisplayName } from '@/utils/project-display';
import { isInboxProject } from '@open-walnut/core';
import { WhereIcon, whereKindOf } from './DraftWhereIcons';
import type { DraftWhere } from './useDraftWhere';
import { autoWhat, ownHostOf, projectMenuOrder, recentPlaces, sourceNames } from './draft-work-in';
import { EmptyState } from '@/components/common/EmptyState';

/** Recent projects shown above the list. */
const RECENT = 5;

export function DraftProjectMenu({ where, onDone, onCustomizeWalnut }: { where: DraftWhere; onDone: () => void; onCustomizeWalnut?: () => void }) {
  const [query, setQuery] = useState('');
  const { favoriteByName } = useProjectRegistry();
  const q = query.trim().toLowerCase();
  const byName = new Map(where.rows.map((r) => [r.name.toLowerCase(), r]));
  const recent = q ? [] : recentPlaces(where.dirs, (n) => byName.get(n.toLowerCase())?.name ?? null)
    .flatMap((p) => (p.kind === 'project' ? [byName.get(p.project.toLowerCase())!] : []))
    // Recent lists repos and packages only; a project with no code stays in its own group below.
    .filter((r) => !!r.startSource)
    .slice(0, RECENT);
  const all = projectMenuOrder(where.rows, (n) => favoriteByName.has(n.toLowerCase()), query, projectDisplayName);
  const sourced = all.filter((r) => !!r.startSource);
  const plain = all.filter((r) => !r.startSource);
  const inboxShown = !q || 'none no project inbox'.includes(q);
  const pick = (name: string) => { where.pickProject(name); onDone(); };
  const first = recent[0]?.name ?? sourced[0]?.name ?? plain[0]?.name ?? (inboxShown ? '' : undefined);
  // A row found by one of its repos or packages, not its name, says which one.
  const matchedBy = (r: ProjectRegistryRow): string | undefined =>
    q && !r.name.toLowerCase().includes(q) && !projectDisplayName(r.name).toLowerCase().includes(q)
      ? sourceNames(r.startSource).find((w) => w.toLowerCase().includes(q)) : undefined;
  const row = (r: ProjectRegistryRow, group: string) => {
    const current = r.name.toLowerCase() === where.project.toLowerCase();
    const kind = r.startSource ? whereKindOf(r.startSource) : 'folder';
    return (
      <button key={`${group}:${r.name}`} type="button" role="option" aria-selected={current} className="draft-v6-option wn-pick-row"
        data-testid={`draft-v6-project-${r.name}`} onClick={() => pick(r.name)}>
        <span className={`draft-v6-project-icon is-${kind}`}><WhereIcon kind={kind} size={14} /></span>
        <span className="draft-v6-option-text">
          <span className="draft-v6-option-name wn-title wn-pick-name">{projectDisplayName(r.name)}</span>
          <span className="draft-v6-option-line">{matchedBy(r) ? `Has ${matchedBy(r)} · ` : ''}{autoWhat(r).words} · {where.hostName(ownHostOf(r))}</span>
        </span>
      </button>
    );
  };
  return (
    <>
      <div className="draft-v6-wm-search is-small">
        <SearchField small fieldClassName="draft-v6-wm-field"
          data-no-draft="search"
          data-testid="draft-v6-project-search"
          placeholder="Search repos and packages"
          aria-label="Search repos and packages"
          value={query}
          setText={setQuery}
          onClear={() => setQuery('')}
          onKeyDown={(e) => { if (e.key === 'Enter' && first !== undefined) { e.preventDefault(); pick(first); } }}
          autoFocus
        />
      </div>
      <div className="draft-v6-menu-list" role="listbox" aria-label="Repo or package">
        {recent.length > 0 && <div className="draft-v6-menu-title">Recent</div>}
        {recent.map((r) => row(r, 'recent'))}
        {/* Repos and packages (a code source: a fresh workspace each start) first; projects with no code
            after them under their own title, so none of them reads as a repo (review, 2026-11-24). */}
        {sourced.length > 0 && <div className="draft-v6-menu-title">{q ? 'Matching repos and packages' : 'Repos and packages'}</div>}
        {sourced.map((r) => row(r, 'all'))}
        {plain.length > 0 && <div className="draft-v6-menu-title">{q ? 'Matching projects with no code' : 'Projects with no code: work in a folder'}</div>}
        {plain.map((r) => row(r, 'plain'))}
        {inboxShown && (
          <button type="button" role="option" aria-selected={isInboxProject(where.project)}
            className="draft-v6-option wn-pick-row" data-testid="draft-v6-project-none" onClick={() => pick('')}>
            <span className="draft-v6-project-icon is-home"><WhereIcon kind="home" size={14} /></span>
            <span className="draft-v6-option-text">
              <span className="draft-v6-option-name wn-title wn-pick-name">None</span>{/* empty-state-ok: an option's name */}
              <span className="draft-v6-option-line">The Inbox · works in a folder you pick</span>
            </span>
          </button>
        )}
        {!all.length && !inboxShown && <EmptyState size="row" title="No matching repo or package" />}
        {onCustomizeWalnut && !q && (
          <button type="button" role="option" aria-selected={false} className="draft-v6-option" data-testid="draft-customize-walnut"
            title="Open a session in Walnut's own source code to change or fix Walnut" onClick={() => { onDone(); onCustomizeWalnut(); }}>
            <span className="draft-v6-project-icon"><span aria-hidden="true">{ICONS.ICON_SLIDERS}</span></span>
            <span className="draft-v6-option-text">
              <span className="draft-v6-option-name wn-title wn-pick-name">Customize Walnut</span>
              <span className="draft-v6-option-line">A session in Walnut's own code, to change or fix it</span>
            </span>
          </button>
        )}
      </div>
    </>
  );
}
