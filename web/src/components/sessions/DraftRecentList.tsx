/**
 * The places used before, under the v6 draft's lower row (experiment `project_first_start`):
 *
 *   (the lower row: Save as task, Task settings)
 *   [Recent | Most used]                                               Browse folders ›
 *   [⑂] Walnut                                                 [This Mac]  1d ago
 *       Auto · New worktree
 *   [▭] workdir                                                [Build box]  4h ago
 *       ~/teammate/state
 *   …five rows, always five rows high; Most used says the starts instead of the time
 *
 * Evan, 11-25: "I want at least 5 but in a nice way. like before right recently, most used also".
 * A row is the Where picker's own row (DraftPlaceRow), so the two lists read as one. A project's
 * row names the place its pick restores (where.placeOf, the same answer pickProject uses), a
 * folder's row that folder; one row at most reads picked. Recent / Most used is the Where picker's
 * own choice (usePlaceOrder), so "Browse folders" opens it in the same order. One Tab stop; ↑↓
 * move, Enter or Space picks.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { SegmentedControl } from '@/components/controls';
import { projectDisplayName } from '@/utils/project-display';
import { knownHomeOf, shownFolderName, tildePath } from '@/utils/home-folder';
import { timeAgo } from '@/utils/time';
import type { ProjectRegistryRow } from '@/hooks/useProjectRegistry';
import { DraftPlaceRow, placeMeta, usePlaceOrder, type PlaceOrder } from './DraftPlaceRow';
import { whereKindOf } from './DraftWhereIcons';
import type { DraftColumn } from './draft-column';
import type { DraftWhere } from './useDraftWhere';
import { autoWhat, draftHostFor, mostUsedPlaces, placeKey, whereHostKey, type RecentPlace } from './draft-work-in';

/** Rows shown: the user asked for at least five. */
export const RECENT_ROWS = 5;

export function RecentKindSwitch({ value, onChange }: { value: PlaceOrder; onChange: (v: PlaceOrder) => void }) {
  return (
    <SegmentedControl size="sm" horizontalKeys aria-label="Which places" value={value} data-testid="draft-v6-recent-kind"
      options={[{ value: 'recent', label: 'Recent' }, { value: 'most', label: 'Most used' }]} onChange={onChange} />
  );
}

export function DraftRecentList({ draft, where, places, byName, onBrowse }: {
  draft: DraftColumn;
  where: DraftWhere;
  /** Every place, newest first (recentPlaces). */
  places: readonly RecentPlace[];
  byName: ReadonlyMap<string, ProjectRegistryRow>;
  /** Every folder: the Where picker. */
  onBrowse: () => void;
}) {
  const [kind, setKind] = usePlaceOrder();
  const rows = useMemo(() => (kind === 'most' ? mostUsedPlaces(places) : places).slice(0, RECENT_ROWS), [kind, places]);
  const homeOf = (host: string) => knownHomeOf(draftHostFor(host));
  const listRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(0);
  const at = Math.min(focus, rows.length - 1);
  const move = (e: KeyboardEvent<HTMLDivElement>, i: number, pick: () => void) => {
    const to = e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : e.key === 'ArrowUp' ? Math.max(i - 1, 0)
      : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : -1;
    if (to >= 0) {
      e.preventDefault();
      setFocus(to);
      listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[to]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
  };
  // One row reads picked: the folder in use when it is a row of its own, else the project's row
  // only when the place it names is the draft's place now (a "+" draft on its source, then a row
  // naming another folder of that project, is not "in use": review round 3).
  const keyOf = (p: RecentPlace) => (p.kind === 'project' ? `p:${p.project.toLowerCase()}` : `f:${p.host}:${p.cwd}`);
  const hostNow = whereHostKey(draft.host);
  const folderKey = !where.autoCurrent && draft.cwd ? `f:${hostNow}:${draft.cwd}` : '';
  const placeNow = placeKey(where.autoCurrent ? { auto: true, host: hostNow } : { auto: false, host: hostNow, cwd: draft.cwd ?? '' });
  const projectKey = where.project && placeKey(where.placeOf(where.project)) === placeNow ? `p:${where.project.toLowerCase()}` : '';
  const currentKey = rows.some((p) => keyOf(p) === folderKey) ? folderKey : projectKey;
  return (
    <div className="draft-v6-rl-box">
    <div className="draft-v6-rl-top">
      <RecentKindSwitch value={kind} onChange={(v) => { setKind(v); setFocus(0); }} />
      <button type="button" className="btn btn-sm draft-v6-rl-browse" data-testid="draft-v6-recent-more" aria-haspopup="dialog" title="Every folder on every machine: the Where picker"
        onMouseDown={(e) => e.preventDefault()} onClick={onBrowse}>Browse folders</button>
    </div>
    <div ref={listRef} className="draft-v6-rl" role="listbox" aria-label={kind === 'most' ? 'Most used places' : 'Recent places'}
      data-testid="draft-v6-recent-list" style={{ ['--draft-v6-rl-rows' as string]: RECENT_ROWS }}>
      {rows.map((p, i) => {
        const project = p.kind === 'project' ? byName.get(p.project.toLowerCase()) : undefined;
        const place = p.kind === 'project' ? where.placeOf(p.project) : null;
        const host = place ? place.host : p.host;
        const cwd = place ? place.cwd ?? '' : p.cwd;
        const name = p.kind === 'project' ? projectDisplayName(p.project) : shownFolderName(p.cwd, draftHostFor(p.host));
        const line = place?.auto ? `Auto · ${autoWhat(project).words}` : tildePath(cwd, homeOf(host));
        const current = keyOf(p) === currentKey;
        const hostName = where.hostName(host);
        const pick = () => (p.kind === 'project' ? where.pickProject(p.project) : where.pickFolder(p.cwd, p.host, p.hostLabel));
        return (
          <DraftPlaceRow key={keyOf(p)} compact
            kind={project?.startSource ? whereKindOf(project.startSource) : 'folder'} name={name} line={line} hostName={hostName}
            meta={placeMeta(kind, p.count, p.at ? timeAgo(p.at) : '')} current={current}
            title={`${current ? 'In use now' : 'Use'}: ${name} (${hostName}: ${line})`} onPick={pick}
            testId="draft-v6-recent-row" data={{ kind: p.kind }} tabIndex={i === at ? 0 : -1} onKeyDown={(e) => move(e, i, pick)} />
        );
      })}
    </div>
    </div>
  );
}
