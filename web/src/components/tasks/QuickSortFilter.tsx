/**
 * What Sort shows, on screen and editable (2026-11-07, the user: never every task on the board; a
 * default filter he can see and change): the pin tiers (Focus first by default), a project, a folder,
 * and how long a task has gone with no action. Project and folder pick from flyouts (a menu never
 * grows in place: web/src/AGENTS.md, Menus & overlays).
 */
import { useEffect, useMemo } from 'react';
import { useTasksContext } from '@/contexts/TasksContext';
import { OptionPickerFlyout, useCursorFlyout, type FlyoutOption } from './CursorFlyout';
import { IDLE_STEPS, projectKey, type SortFilter } from './quick-sort-model';

const ALL = '__all';

export function QuickSortFilter({ filter, setFilter, tiers, counts, showProject = true }: {
  filter: SortFilter;
  setFilter: (next: SortFilter) => void;
  tiers: { id: string; label: string }[];
  /** Open, unsnoozed tasks per tier under the rest of the filter. */
  counts: Record<string, number>;
  /** The Projects view sorts across projects: its filter has no project pick. */
  showProject?: boolean;
}) {
  const { tasks, taskGroups, folderMeta } = useTasksContext();
  const projectMenu = useCursorFlyout<null>();
  const folderMenu = useCursorFlyout<null>();
  // Escape closes an open menu, never the board under it.
  const menuOpen = !!(projectMenu.state || folderMenu.state);
  useEffect(() => {
    if (!menuOpen) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      const origin = projectMenu.state?.origin ?? folderMenu.state?.origin;
      projectMenu.close();
      folderMenu.close();
      if (origin?.isConnected) origin.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [menuOpen, projectMenu, folderMenu]);

  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of tasks) if (!seen.has(projectKey(t))) seen.set(projectKey(t), t.project?.trim() || 'Inbox');
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [tasks]);
  const folders = useMemo(() => Object.entries(taskGroups)
    .filter(([id]) => filter.project === null || (folderMeta[id]?.project ?? '').trim().toLowerCase() === filter.project)
    .sort((a, b) => a[1].localeCompare(b[1])), [taskGroups, folderMeta, filter.project]);
  const projectLabel = filter.project === null ? 'All projects' : projects.find(([k]) => k === filter.project)?.[1] ?? 'Inbox';
  const folderLabel = filter.folder === null ? 'All folders' : taskGroups[filter.folder] ?? 'Folder removed';
  const total = tiers.reduce((n, t) => n + (counts[t.id] ?? 0), 0);

  const toggleTier = (id: string) => setFilter({ ...filter, tiers: filter.tiers.includes(id) ? filter.tiers.filter(t => t !== id) : [...filter.tiers, id] });
  const openAt = (menu: typeof projectMenu, from: HTMLElement) => { const box = from.getBoundingClientRect(); menu.open(null, { x: box.left, y: box.bottom }, from); };
  const projectOptions: FlyoutOption<string>[] = [{ value: ALL, label: 'All projects' }, ...projects.map(([k, l]) => ({ value: `p:${k}`, label: l }))];
  const folderOptions: FlyoutOption<string>[] = [{ value: ALL, label: 'All folders' }, ...folders.map(([id, l]) => ({ value: `f:${id}`, label: l }))];

  return <div className="quick-sort-filter" data-testid="quick-sort-filter">
    <div className="quick-sort-chips" role="group" aria-label="Pin tiers to sort">
      <button type="button" aria-pressed={filter.tiers.length === 0} data-sort-filter-tier="" onClick={() => setFilter({ ...filter, tiers: [] })}>Every tier<b>{total}</b></button>
      {tiers.map(t => <button key={t.id} type="button" aria-pressed={filter.tiers.includes(t.id)} data-sort-filter-tier={t.id} onClick={() => toggleTier(t.id)}>{t.label}<b>{counts[t.id] ?? 0}</b></button>)}
    </div>
    <div className="quick-sort-chips">
      {showProject && <button type="button" className="quick-sort-pick" data-sort-filter="project" aria-haspopup="listbox" aria-pressed={filter.project !== null}
        onClick={e => openAt(projectMenu, e.currentTarget)}>{projectLabel} ▾</button>}
      <button type="button" className="quick-sort-pick" data-sort-filter="folder" aria-haspopup="listbox" aria-pressed={filter.folder !== null}
        onClick={e => openAt(folderMenu, e.currentTarget)}>{folderLabel} ▾</button>
      <span className="quick-sort-chips-label">No action for</span>
      <span className="quick-sort-chips" role="group" aria-label="No action for">
        {IDLE_STEPS.map(n => <button key={n} type="button" aria-pressed={filter.idleDays === n} data-sort-filter-idle={n}
          onClick={() => setFilter({ ...filter, idleDays: n })}>{n ? `${n}+ days` : 'Any time'}</button>)}
      </span>
    </div>
    {projectMenu.state && <OptionPickerFlyout anchorPoint={projectMenu.state.point} anchorRef={projectMenu.noTrigger} options={projectOptions}
      current={filter.project === null ? ALL : `p:${filter.project}`} ariaLabel="Sort which project"
      onPick={v => {
        const project = v === ALL ? null : v.slice(2);
        const keepFolder = filter.folder !== null && (project === null || (folderMeta[filter.folder]?.project ?? '').trim().toLowerCase() === project);
        setFilter({ ...filter, project, folder: keepFolder ? filter.folder : null });
        projectMenu.close();
      }} onClose={projectMenu.close} />}
    {folderMenu.state && <OptionPickerFlyout anchorPoint={folderMenu.state.point} anchorRef={folderMenu.noTrigger} options={folderOptions}
      current={filter.folder === null ? ALL : `f:${filter.folder}`} ariaLabel="Sort which folder"
      onPick={v => { setFilter({ ...filter, folder: v === ALL ? null : v.slice(2) }); folderMenu.close(); }} onClose={folderMenu.close} />}
  </div>;
}
