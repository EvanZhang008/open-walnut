/**
 * The board's Sort mode: three cards at a time, each decided in one tap (a pin tier, a snooze, done,
 * a reply, or skip for this round), with Undo for every decision but a reply. Projects get the same:
 * one card per project, whose tier or snooze applies to its open tasks. What the deck holds is a filter
 * on screen (QuickSortFilter); the queue, ages and presets are quick-sort-model.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { useTasksContext } from '@/contexts/TasksContext';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import type { FocusTier } from '@/api/focus';
import { usePageView } from '@/utils/view-memory';
import { taskStatusLabel, taskUserState } from '@/utils/session-status';
import { shownState } from '@open-walnut/user-status';
import { useCursorFlyout } from './CursorFlyout';
import { SnoozeDateFlyout, SnoozeFlyout } from './SnoozeChoices';
import { QuickSortFilter } from './QuickSortFilter';
import { QuickSortReply } from './QuickSortReply';
import { folderSubtreeIds } from '@/hooks/useTasks';
import { homeBoardTier } from './home-board-model';
import {
  ageTags, buildSortProjects, buildSortQueue, DEFAULT_SORT_FILTER, isSortFilter, projectSnoozeTargets, snoozeUntilText, tierCounts,
  type SortFilter, type SortItem, type SortProject, type SortView,
} from './quick-sort-model';
import '@/styles/quick-sort.css';

const SHOWN = 3;
/** A project pick moving this many tasks asks once more first (the group menus' rule). */
const CONFIRM_FROM = 20;

/** One decision of this round. `write` resolves to the ids whose write the server took (none: it
 *  was refused, and the card comes back); Undo waits for it, then reverts exactly those. */
interface Decision { key: string; outcome: string; label: string; write: Promise<string[]>; revert: ((landed: string[]) => Promise<boolean>) | null }
type Target = { kind: 'task'; item: SortItem } | { kind: 'project'; project: SortProject };

const isView = (v: unknown): v is SortView => v === 'tasks' || v === 'projects';
const tierClass = (id: string) => `tier-${['focus', 'satellite', 'wait', 'unpinned'].includes(id) ? id : 'custom'}`;

const typing = (target: EventTarget | null) => !!(target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]');
/** Keys pressed in an open menu belong to it (its arrows walk its rows). */
const inMenu = () => !!document.activeElement?.closest?.('.task-kebab-project-flyout');

export function QuickSortView({ query, tiers, onOpen, active }: {
  query: string;
  /** The board is on screen (its route is shown): only then do its keys and flyouts live. */
  active: boolean;
  /** Every pin tier in board order, Unpinned last. */
  tiers: { id: string; label: string }[];
  onOpen: (task: Task) => void;
}) {
  const { tasks, update, setPhase, folderMeta } = useTasksContext();
  const focus = useFocusBarContext();
  const [view, setView] = usePageView<SortView>('home-board', 'sortView', 'tasks', isView);
  const [filter, setFilterRaw] = usePageView<SortFilter>('home-board', 'sortFilter', DEFAULT_SORT_FILTER, isSortFilter);
  const [replying, setReplying] = useState<string | null>(null);
  const [toast, setToast] = useState<{ label: string; undo: boolean } | null>(null);
  const [taken, setTaken] = useState<ReadonlySet<string>>(() => new Set());
  const [decided, setDecided] = useState(0);
  const [tally, setTally] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState(0);
  const [undos, setUndos] = useState<Decision[]>([]);
  const [confirming, setConfirming] = useState<{ key: string; tier: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const snooze = useCursorFlyout<Target>();
  const pickDate = useCursorFlyout<Target>();
  const rootRef = useRef<HTMLDivElement>(null);

  const label = useCallback((tier: string) => tiers.find(t => t.id === tier)?.label ?? tier, [tiers]);
  const setFilter = (next: SortFilter) => { setFilterRaw(next); setCursor(0); setReplying(null); };
  // A kept folder that is gone (deleted) matches nothing, never everything; its pick says so.
  const folders = useMemo(() => filter.folder === null ? null : folderMeta[filter.folder] ? folderSubtreeIds(filter.folder, folderMeta) : new Set<string>(), [filter.folder, folderMeta]);
  // The Projects view sorts across projects, so its own project pick is left out.
  const viewFilter = view === 'projects' ? { ...filter, project: null } : filter;
  const items = useMemo(() => view === 'tasks'
    ? buildSortQueue(tasks, focus.customTiers, filter, { query, folders, exclude: taken })
    : [], [view, tasks, focus.customTiers, filter, query, folders, taken]);
  const projects = useMemo(() => view === 'projects'
    ? buildSortProjects(tasks, focus.customTiers, viewFilter, { query, folders, exclude: taken })
    : [], [view, tasks, focus.customTiers, filter, query, folders, taken]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => tierCounts(tasks, focus.customTiers, viewFilter, { folders }), [tasks, focus.customTiers, filter, view, folders]); // eslint-disable-line react-hooks/exhaustive-deps
  const left = view === 'tasks' ? items.length : projects.length;
  const shown = view === 'tasks' ? items.slice(0, SHOWN) : projects.slice(0, SHOWN);
  const at = Math.min(cursor, Math.max(0, shown.length - 1));

  const undosRef = useRef(undos);
  undosRef.current = undos;
  // A refused decision brings its card back with the error: nothing of it was sorted.
  const unrecord = useCallback((key: string) => {
    const list = undosRef.current;
    let i = list.length - 1;
    while (i >= 0 && list[i].key !== key) i--;
    if (i >= 0) {
      const gone = list[i];
      const rest = [...list.slice(0, i), ...list.slice(i + 1)];
      setUndos(rest);
      const now = rest.at(-1);
      setToast(t => t?.label === gone.label ? (now ? { label: now.label, undo: true } : null) : t);
      if (gone.outcome !== 'skip') setDecided(n => Math.max(0, n - 1));
      setTally(t => ({ ...t, [gone.outcome]: Math.max(0, (t[gone.outcome] ?? 0) - 1) }));
    }
    setTaken(s => { const next = new Set(s); next.delete(key); return next; });
  }, []);
  /** Takes the card out at once; `keep` says from the ids that landed whether it stays decided. */
  const record = (decision: Decision, keep: (landed: string[]) => boolean = landed => landed.length > 0) => {
    setTaken(s => new Set(s).add(decision.key));
    if (decision.outcome !== 'skip') setDecided(n => n + 1);
    setTally(t => ({ ...t, [decision.outcome]: (t[decision.outcome] ?? 0) + 1 }));
    // A reply cannot be taken back: it is counted and named, never offered to Undo.
    if (decision.revert) setUndos(u => [...u.slice(-19), decision]);
    setToast({ label: decision.label, undo: !!decision.revert });
    setConfirming(null);
    void decision.write.then(landed => { if (!keep(landed)) unrecord(decision.key); });
  };
  const undoLast = useCallback(() => {
    const last = undosRef.current.at(-1);
    if (!last?.revert) return;
    const revert = last.revert;
    // Taken off the ref at once too: a second key press before the next render undoes the one before.
    undosRef.current = undosRef.current.slice(0, -1);
    setUndos(u => u.slice(0, -1));
    const before = undosRef.current.at(-1);
    setToast(before ? { label: before.label, undo: true } : null);
    setTaken(s => { const next = new Set(s); next.delete(last.key); return next; });
    if (last.outcome !== 'skip') setDecided(n => Math.max(0, n - 1));
    setTally(t => ({ ...t, [last.outcome]: Math.max(0, (t[last.outcome] ?? 0) - 1) }));
    // The reverse write goes out only after the decision's own write answered, so it lands last.
    void last.write.then(async landed => {
      if (landed.length && !(await revert(landed))) setError(`Could not undo: ${last.label}`);
    });
  }, []);

  /** A tier write; resolves to the ids the server took. */
  const writeTier = useCallback(async (ids: string[], tier: string): Promise<string[]> => {
    if (!ids.length) return [];
    let failed: string[] | 'all' | null = null;
    await focus.setTierBulk(ids, tier === 'unpinned' ? null : tier as FocusTier, (message, failedIds) => {
      setError(message);
      failed = failedIds ?? 'all';
    });
    const refused = failed as string[] | 'all' | null;
    return refused === 'all' ? [] : refused ? ids.filter(id => !refused.includes(id)) : ids;
  }, [focus]);
  const landedIf = (ok: Promise<boolean>, ids: string[]) => ok.then(yes => yes ? ids : []);
  const skipped: Decision['write'] = Promise.resolve(['skip']);

  const taskTier = (item: SortItem, tier: string) => {
    setError(null);
    record({
      key: item.task.id, outcome: tier, label: `Moved "${item.task.title}" to ${label(tier)}`,
      write: writeTier(item.family, tier),
      revert: async landed => (await writeTier(landed, item.tier)).length === landed.length,
    }, landed => landed.includes(item.task.id));
  };
  const taskSnooze = (item: SortItem, date: string | null) => {
    if (!date) return;
    const before = item.task.start_date ?? '';
    record({
      key: item.task.id, outcome: 'snoozed', label: `Snoozed "${item.task.title}" until ${snoozeUntilText(date)}`,
      write: landedIf(update(item.task.id, { start_date: date }), [item.task.id]),
      revert: () => update(item.task.id, { start_date: before }),
    });
  };
  const taskDone = (item: SortItem) => {
    const before = item.task.phase;
    record({
      key: item.task.id, outcome: 'done', label: `Marked "${item.task.title}" done`,
      write: landedIf(setPhase(item.task.id, 'COMPLETE'), [item.task.id]),
      revert: () => setPhase(item.task.id, before),
    });
  };
  const taskSkip = (item: SortItem) => record({ key: item.task.id, outcome: 'skip', label: `Skipped "${item.task.title}"`, write: skipped, revert: async () => true });
  // The reply is already sent when this runs (QuickSortReply waits for it).
  const taskReplied = (item: SortItem) => {
    setReplying(null);
    record({ key: item.task.id, outcome: 'replied', label: `Sent your reply to "${item.task.title}"`, write: Promise.resolve([item.task.id]), revert: null });
  };

  const projectTier = (project: SortProject, tier: string) => {
    const moving = project.tasks.filter(t => homeBoardTier(t, focus.customTiers) !== tier);
    if (moving.length >= CONFIRM_FROM && confirming?.key !== project.key) { setConfirming({ key: project.key, tier }); return; }
    const was = new Map(moving.map(t => [t.id, homeBoardTier(t, focus.customTiers)]));
    setError(null);
    record({
      key: `project:${project.key}`, outcome: tier,
      label: `Moved ${moving.length} ${moving.length === 1 ? 'task' : 'tasks'} of ${project.label} to ${label(tier)}`,
      // Nothing to move still counts as decided: the whole project already sits there.
      write: moving.length ? writeTier(moving.map(t => t.id), tier) : Promise.resolve(['none']),
      revert: async landed => {
        const groups = new Map<string, string[]>();
        for (const id of landed) { const from = was.get(id); if (from) groups.set(from, [...(groups.get(from) ?? []), id]); }
        const back = await Promise.all([...groups].map(([from, ids]) => writeTier(ids, from)));
        return back.flat().length === [...groups.values()].flat().length;
      },
    });
  };
  const projectSnooze = (project: SortProject, date: string | null) => {
    if (!date) return;
    const targets = projectSnoozeTargets(project, date).map(t => ({ id: t.id, before: t.start_date ?? '' }));
    record({
      key: `project:${project.key}`, outcome: 'snoozed', label: `Snoozed ${project.label} until ${snoozeUntilText(date)}`,
      write: Promise.all(targets.map(t => landedIf(update(t.id, { start_date: date }), [t.id]))).then(r => r.flat()),
      revert: async landed => (await Promise.all(targets.filter(t => landed.includes(t.id)).map(t => update(t.id, { start_date: t.before })))).every(Boolean),
    });
  };
  const projectSkip = (project: SortProject) => record({ key: `project:${project.key}`, outcome: 'skip', label: `Skipped ${project.label}`, write: skipped, revert: async () => true });
  // A project's own tasks, every tier of it: that is what the user asked to sort.
  const sortProjectTasks = (project: SortProject) => { setFilter({ ...filter, project: project.key, tiers: [] }); setView('tasks'); };

  const onSnoozePick = (target: Target, date: string | null) => target.kind === 'task' ? taskSnooze(target.item, date) : projectSnooze(target.project, date);
  const openSnooze = (target: Target, from: HTMLElement) => {
    const box = from.getBoundingClientRect();
    snooze.open(target, { x: box.left, y: box.bottom }, from);
  };

  // Escape closes an open snooze flyout, never the board under it (the sheet leaves on an Escape
  // nobody prevented).
  const flyoutOpen = !!(snooze.state || pickDate.state);
  useEffect(() => {
    if (!flyoutOpen) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      const origin = snooze.state?.origin ?? pickDate.state?.origin;
      snooze.close();
      pickDate.close();
      if (origin?.isConnected) origin.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [flyoutOpen, snooze, pickDate]);

  // Keys act on the highlighted card while nothing is being typed and no flyout is open. The board is
  // modal, so a key used here is taken before the panels under it (their key router reads arrows).
  const keyState = useRef({ shown, at, view });
  const tierChoices = useCallback((current: string) => tiers.map(t => t.id).filter(id => id !== current), [tiers]);
  keyState.current = { shown, at, view };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target) || inMenu() || snooze.state || pickDate.state) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); undoLast(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { shown: cards, at: index, view: mode } = keyState.current;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (!cards.length) return;
        e.preventDefault();
        e.stopPropagation();
        setCursor(Math.max(0, Math.min(cards.length - 1, index + (e.key === 'ArrowRight' ? 1 : -1))));
        return;
      }
      // A held key decides one card, never every card that slides under it.
      if (e.repeat) return;
      const card = rootRef.current?.querySelector<HTMLElement>(`[data-sort-card-index="${index}"]`);
      if (!card) return;
      const press = (selector: string) => { const b = card.querySelector<HTMLButtonElement>(selector); if (b && !b.disabled) { e.preventDefault(); e.stopPropagation(); b.click(); } };
      const key = e.key.toLowerCase();
      if (/^[1-9]$/.test(key)) press(`[data-sort-key="${key}"]`);
      else if (key === 's') press('[data-sort-action="snooze"]');
      else if (key === 'd' && mode === 'tasks') press('[data-sort-action="done"]');
      else if (key === 'r' && mode === 'tasks') press('[data-sort-action="reply"]');
      else if (key === 'x') press('[data-sort-action="skip"]');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, undoLast, snooze.state, pickDate.state]);
  useEffect(() => { if (!active) { snooze.close(); pickDate.close(); } }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = decided + left;
  const tallyRows = Object.entries(tally).filter(([k, n]) => n > 0 && k !== 'skip');
  const tierKeyed = (choices: string[]) => choices.map((id, i) => ({ id, key: i < 9 ? String(i + 1) : undefined }));
  const narrowed = filter.tiers.length > 0 || filter.project !== null || filter.folder !== null || filter.idleDays > 0;

  return <div ref={rootRef} className="quick-sort" data-testid="quick-sort" data-view={view}>
    <div className="quick-sort-bar">
      <QuickSortFilter filter={filter} setFilter={setFilter} tiers={tiers} counts={counts} showProject={view === 'tasks'} />
      <div className="home-board-switch quick-sort-view" aria-label="Sort tasks or projects">
        <button type="button" aria-pressed={view === 'tasks'} onClick={() => { setView('tasks'); setCursor(0); }}>Tasks</button>
        <button type="button" aria-pressed={view === 'projects'} onClick={() => { setView('projects'); setCursor(0); setReplying(null); }}>Projects</button>
      </div>
    </div>
    <div className="quick-sort-progress" aria-hidden="true"><i style={{ width: `${total ? Math.round(decided / total * 100) : 0}%` }} /></div>
    <div className="quick-sort-progress-text"><span>{decided} sorted this round</span><span data-testid="quick-sort-left">{left} left</span></div>
    {error && <div className="home-board-error quick-sort-error" role="alert"><span>{error}</span></div>}
    {shown.length === 0 ? <div className="quick-sort-empty" data-testid="quick-sort-empty">
      <h2>{decided ? 'All sorted' : 'Nothing to sort here'}</h2>
      <p>{view === 'tasks' ? 'No open task left under this filter.' : 'No project left in this round.'}</p>
      {narrowed && <button type="button" onClick={() => setFilter({ tiers: [], project: null, folder: null, idleDays: 0 })}>Sort every open task</button>}
    </div> : <div className="quick-sort-cards">
      {view === 'tasks'
        ? (shown as SortItem[]).map((item, i) => {
            const state = shownState(taskUserState(item.task));
            const sub = item.family.length - 1;
            const tags = ageTags(item.tier, label(item.tier), item.ages);
            return <article key={item.task.id} className={`quick-sort-card${i === at ? ' is-current' : ''}`} data-sort-card={item.task.id} data-sort-card-index={i} onPointerDown={() => setCursor(i)} onFocus={() => setCursor(i)}>
              <div className="quick-sort-card-proj">{item.task.project?.trim() || 'Inbox'}{sub > 0 && ` · ${sub} ${sub === 1 ? 'subtask moves' : 'subtasks move'} with it`}</div>
              <button type="button" className="quick-sort-card-title" onClick={() => onOpen(item.task)}>{item.task.title}</button>
              <div className="quick-sort-card-meta"><span className={`home-board-state home-board-state-${state}`}><i />{taskStatusLabel(item.task)}</span><span>{label(item.tier)}</span></div>
              {tags.length > 0 && <div className="quick-sort-tags">{tags.map(t => <span key={t.kind} className={`quick-sort-tag is-${t.kind}${t.kind === 'idle' && item.ages.idle >= 7 ? ' is-old' : ''}`} data-sort-age={t.kind}>{t.text}</span>)}</div>}
              {item.line && <div className="quick-sort-card-line" title={item.line}>{item.line}</div>}
              {replying === item.task.id ? <QuickSortReply task={item.task} onSent={() => taskReplied(item)} onClose={() => setReplying(null)} /> : <div className="quick-sort-actions"><div className="quick-sort-tiers">
                {tierKeyed(tierChoices(item.tier)).map(({ id, key }) => <button key={id} type="button" className={`quick-sort-btn ${tierClass(id)}`} data-sort-tier={id} data-sort-key={key} onClick={() => taskTier(item, id)}>{label(id)}{key && <small>{key}</small>}</button>)}
                </div><div className="quick-sort-moves">
                <button type="button" className="quick-sort-btn is-reply" data-sort-action="reply" onClick={() => { setCursor(i); setReplying(item.task.id); }}>Reply<small>R</small></button>
                <button type="button" className="quick-sort-btn is-snooze" data-sort-action="snooze" aria-haspopup="dialog" onClick={e => openSnooze({ kind: 'task', item }, e.currentTarget)}>Snooze<small>S</small></button>
                <button type="button" className="quick-sort-btn is-done" data-sort-action="done" onClick={() => taskDone(item)}>Done<small>D</small></button>
                <button type="button" className="quick-sort-btn is-skip" data-sort-action="skip" onClick={() => taskSkip(item)}>Skip<small>X</small></button>
              </div></div>}
            </article>;
          })
        : (shown as SortProject[]).map((project, i) => {
            const open = project.tasks.length;
            const ask = confirming?.key === project.key ? confirming : null;
            return <article key={project.key} className={`quick-sort-card is-project${i === at ? ' is-current' : ''}`} data-sort-project={project.key} data-sort-card-index={i} onPointerDown={() => setCursor(i)} onFocus={() => setCursor(i)}>
              <div className="quick-sort-card-proj">Project · {open} open{project.snoozed ? ` · ${project.snoozed} snoozed` : ''}</div>
              <div className="quick-sort-card-title is-static">{project.label}</div>
              <div className="quick-sort-mix" aria-label={tiers.map(t => `${project.tiers[t.id] ?? 0} ${t.label}`).join(', ')}>
                {tiers.map(t => (project.tiers[t.id] ?? 0) > 0 && <i key={t.id} className={tierClass(t.id)} style={{ flexGrow: project.tiers[t.id] }} />)}
              </div>
              <div className="quick-sort-card-meta">{tiers.filter(t => project.tiers[t.id]).map(t => <span key={t.id}>{project.tiers[t.id]} {t.label}</span>)}</div>
              <ul className="quick-sort-card-list">{project.roots.slice(0, 3).map(t => <li key={t.id} title={t.title}>{t.title}</li>)}{project.roots.length > 3 && <li className="more">and {project.roots.length - 3} more</li>}</ul>
              {ask ? <div className="quick-sort-confirm" role="alert">
                <span>Move {project.tasks.filter(t => homeBoardTier(t, focus.customTiers) !== ask.tier).length} tasks of {project.label} to {label(ask.tier)}?</span>
                <button type="button" className="quick-sort-btn" data-sort-confirm="yes" onClick={() => projectTier(project, ask.tier)}>Move</button>
                <button type="button" className="quick-sort-btn is-skip" onClick={() => setConfirming(null)}>Cancel</button>
              </div> : <div className="quick-sort-actions"><div className="quick-sort-tiers">
                {tierKeyed(tiers.map(t => t.id).filter(id => (project.tiers[id] ?? 0) < open)).map(({ id, key }) => <button key={id} type="button" className={`quick-sort-btn ${tierClass(id)}`} data-sort-tier={id} data-sort-key={key} onClick={() => projectTier(project, id)}>All {label(id)}{key && <small>{key}</small>}</button>)}
                </div><div className="quick-sort-moves">
                <button type="button" className="quick-sort-btn is-snooze" data-sort-action="snooze" aria-haspopup="dialog" onClick={e => openSnooze({ kind: 'project', project }, e.currentTarget)}>Snooze all ▾<small>S</small></button>
                <button type="button" className="quick-sort-btn" data-sort-action="tasks" onClick={() => sortProjectTasks(project)}>Sort its tasks ▸</button>
                <button type="button" className="quick-sort-btn is-skip" data-sort-action="skip" onClick={() => projectSkip(project)}>Skip<small>X</small></button>
              </div></div>}
            </article>;
          })}
    </div>}
    <div className="quick-sort-foot">
      {toast && <div className="quick-sort-toast" role="status"><span>{toast.label}</span>{toast.undo && <><button type="button" onClick={undoLast}>Undo</button><kbd>⌘Z</kbd></>}</div>}
      {tallyRows.length > 0 && <div className="quick-sort-tally" data-testid="quick-sort-tally"><span>This round:</span>{tallyRows.map(([k, n]) => <span key={k}>{k === 'snoozed' ? 'Snoozed' : k === 'done' ? 'Done' : k === 'replied' ? 'Replied' : label(k)} {n}</span>)}</div>}
    </div>
    {active && snooze.state && <SnoozeFlyout point={snooze.state.point} anchorRef={snooze.noTrigger}
      onSnooze={date => onSnoozePick(snooze.state!.payload, date)}
      onPickDate={() => { const s = snooze.state!; snooze.close(); pickDate.open(s.payload, s.point, s.origin); }}
      onClose={snooze.close} />}
    {active && pickDate.state && <SnoozeDateFlyout point={pickDate.state.point} anchorRef={pickDate.noTrigger}
      onPick={date => onSnoozePick(pickDate.state!.payload, date)} onClose={pickDate.close} />}
  </div>;
}
