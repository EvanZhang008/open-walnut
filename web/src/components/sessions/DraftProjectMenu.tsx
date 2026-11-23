/**
 * The Project field's menu (experiment `project_first_start`, v6): a search, the projects used
 * last, then every project (favourites, then the ones with a code source, then the rest) and "No
 * project", and "Customize Walnut" (a session in Walnut's own code) where the owner offers it. Each row says what its Auto makes and where; a pick restores the project's last place
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
import { autoWhat, ownHostOf, projectMenuOrder, recentPlaces } from './draft-work-in';
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
    .slice(0, RECENT);
  const all = projectMenuOrder(where.rows, (n) => favoriteByName.has(n.toLowerCase()), query, projectDisplayName);
  const inboxShown = !q || 'no project inbox'.includes(q);
  const pick = (name: string) => { where.pickProject(name); onDone(); };
  const first = recent[0]?.name ?? all[0]?.name ?? (inboxShown ? '' : undefined);
  const row = (r: ProjectRegistryRow, group: string) => {
    const current = r.name.toLowerCase() === where.project.toLowerCase();
    const kind = r.startSource ? whereKindOf(r.startSource) : 'folder';
    return (
      <button key={`${group}:${r.name}`} type="button" role="option" aria-selected={current} className={`draft-v6-option${current ? ' is-current' : ''}`}
        data-testid={`draft-v6-project-${r.name}`} onClick={() => pick(r.name)}>
        <span className={`draft-v6-project-icon is-${kind}`}><WhereIcon kind={kind} size={14} /></span>
        <span className="draft-v6-option-text">
          <span className="draft-v6-option-name wn-title">{projectDisplayName(r.name)}</span>
          <span className="draft-v6-option-line">{autoWhat(r).words} · {where.hostName(ownHostOf(r))}</span>
        </span>
        {current && <span className="draft-v6-check">{ICONS.ICON_CHECK}</span>}
      </button>
    );
  };
  return (
    <>
      <div className="draft-v6-wm-search is-small">
        <SearchField small fieldClassName="draft-v6-wm-field"
          data-no-draft="search"
          data-testid="draft-v6-project-search"
          placeholder="Search projects"
          aria-label="Search projects"
          value={query}
          setText={setQuery}
          onClear={() => setQuery('')}
          onKeyDown={(e) => { if (e.key === 'Enter' && first !== undefined) { e.preventDefault(); pick(first); } }}
          autoFocus
        />
      </div>
      <div className="draft-v6-menu-list" role="listbox" aria-label="Project">
        {recent.length > 0 && <div className="draft-v6-menu-title">Recent</div>}
        {recent.map((r) => row(r, 'recent'))}
        {all.length > 0 && <div className="draft-v6-menu-title">{q ? 'Matching' : 'All projects'}</div>}
        {all.map((r) => row(r, 'all'))}
        {inboxShown && (
          <button type="button" role="option" aria-selected={isInboxProject(where.project)}
            className={`draft-v6-option${isInboxProject(where.project) ? ' is-current' : ''}`} data-testid="draft-v6-project-none" onClick={() => pick('')}>
            <span className="draft-v6-project-icon is-home"><WhereIcon kind="home" size={14} /></span>
            <span className="draft-v6-option-text">
              <span className="draft-v6-option-name wn-title">No project</span>{/* empty-state-ok: an option's name */}
              <span className="draft-v6-option-line">The Inbox · works in a folder you pick</span>
            </span>
            {isInboxProject(where.project) && <span className="draft-v6-check">{ICONS.ICON_CHECK}</span>}
          </button>
        )}
        {!all.length && !inboxShown && <EmptyState size="row" title="No matching project" />}
        {onCustomizeWalnut && !q && (
          <button type="button" role="option" aria-selected={false} className="draft-v6-option" data-testid="draft-customize-walnut"
            title="Open a session in Walnut's own source code to change or fix Walnut" onClick={() => { onDone(); onCustomizeWalnut(); }}>
            <span className="draft-v6-project-icon"><span aria-hidden="true">{ICONS.ICON_SLIDERS}</span></span>
            <span className="draft-v6-option-text">
              <span className="draft-v6-option-name wn-title">Customize Walnut</span>
              <span className="draft-v6-option-line">A session in Walnut's own code, to change or fix it</span>
            </span>
          </button>
        )}
      </div>
    </>
  );
}
