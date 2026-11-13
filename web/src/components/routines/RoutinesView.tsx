import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useRoutines, useExecutors } from '@/hooks/useRoutines';
import { usePersistentState, isStringArray } from '@/hooks/usePersistentState';
import { RoutineComposer } from './RoutineComposer';
import { RoutineForm } from './RoutineForm';
import { RoutineRow } from './RoutineRow';
import { changedSince, editKey, groupKeyOf, groupRoutines, keepShownOrder, routineHealth } from './routine-groups';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { discardDraft, draftKey, readDraft } from '@/utils/drafts';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { getRoutinesSnapshot, loadRoutines } from '@/stores/routines-store';
import { type Routine, type CreateRoutineInput } from '@/api/routines';
import '@/styles/routines-groups.css';

/** The groups the person folded, by key (`global`, `project:<name>`), kept across visits. */
const COLLAPSED_KEY = 'walnut:routines.collapsed.v1';

/**
 * Shared Routines surface, used by the homepage side panel and the /routines page.
 *
 * The first screen is the list, grouped: the global routines first, then one group
 * per project, each folding on its header (routine-groups.ts). Each routine is one
 * line until it is opened (RoutineRow). Making a new one starts from the New routine
 * button, which opens the plain-language composer; a draft the composer still holds
 * opens it again on the next visit, so unsent words are never out of sight.
 */
export function RoutinesView({ compact = false }: { compact?: boolean }) {
  const { routines, loading, error, create, update, setEnabled, remove, runNow, catchUp, dismissMissed } = useRoutines(true);
  const { executors, options } = useExecutors();
  const [draft, setDraft] = useState<CreateRoutineInput | undefined>(undefined);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Routine | undefined>(undefined);
  const [composing, setComposing] = useState(() => readDraft(draftKey('routine-ask', 'new')).trim() !== '');
  // The open row survives a trip to its task and Back (2026-11-04, a review: Back
  // came to a closed list at the top).
  const [openId, setOpenId] = useState<string | null>(() => readOpenRow(compact));
  const [collapsed, setCollapsed] = usePersistentState<string[]>(COLLAPSED_KEY, [], isStringArray);
  // A switch or a delete the server refused, by routine: said on that row.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // The other save an edit was told about: a second Save goes through.
  const seenConflict = useRef<string | null>(null);
  const composeFocus = useRef(false);

  const executorLabels = useMemo(() => Object.fromEntries(executors.map((e) => [e.type, e.label])), [executors]);
  const listRef = useRef<HTMLDivElement>(null);
  // Failing routines lead their group when the page opens; after that every row keeps
  // the place it was shown in for the visit, whatever a switch, a run or the server
  // changes (2026-11-04, the iPhone gate: pausing a failing row moved it under the thumb).
  const shownOrder = useRef<Map<string, string[]>>(new Map());
  const groups = useMemo(() => keepShownOrder(groupRoutines(routines), shownOrder.current), [routines]);
  useLayoutEffect(() => {
    shownOrder.current = new Map(groups.map((g) => [g.key, g.routines.map((r) => r.id)]));
  }, [groups]);

  // Opening a row closes the one open above it, which would pull the clicked row up
  // out of sight: hold the clicked row where it was on screen.
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const rowElement = useLeanCallback((id: string) => (
    listRef.current?.querySelector<HTMLElement>(`[data-routine-id="${CSS.escape(id)}"]`) ?? null
  ), []);
  const openRow = useLeanCallback((id: string, open: boolean) => {
    const el = rowElement(id);
    anchor.current = el ? { id, top: el.getBoundingClientRect().top } : null;
    setOpenId(open ? id : null);
  }, [rowElement]);
  // A row opened near the bottom then shows its details: the page moves up by what
  // runs past the bottom edge, never so far that the row's own line leaves the top.
  useLayoutEffect(() => {
    const held = anchor.current;
    anchor.current = null;
    if (!held) return;
    const el = rowElement(held.id);
    if (!el) return;
    const scroller = scrollerOf(el);
    const moved = el.getBoundingClientRect().top - held.top;
    if (Math.abs(moved) > 1) scroller.scrollBy({ top: moved });
    if (openId !== held.id) return;
    const row = el.getBoundingClientRect();
    const view = scroller === window ? { top: 0, bottom: window.innerHeight } : (scroller as HTMLElement).getBoundingClientRect();
    const gap = 12;
    const past = row.bottom - (view.bottom - gap);
    // Glided, not jumped: the move reads as the row making room for what it opened
    // (2026-11-05, a review: an instant move up read as the row jumping).
    const glide = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (past > 1) scroller.scrollBy({ top: Math.min(past, row.top - (view.top + gap)), behavior: glide ? 'smooth' : 'auto' });
  }, [openId, rowElement]);

  // A routine just made: its group unfolded, the row opened, in view.
  const [reveal, setReveal] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!reveal) return;
    const el = rowElement(reveal);
    if (!el) return;
    // With its group's name when both fit, so the person sees where it went.
    const heading = el.closest('section.routine-group')?.querySelector<HTMLElement>('.routine-group-heading');
    const room = window.innerHeight - 24;
    if (heading && el.getBoundingClientRect().bottom - heading.getBoundingClientRect().top < room) {
      heading.scrollIntoView({ block: 'nearest' });
      el.scrollIntoView({ block: 'nearest' });
    } else {
      el.scrollIntoView({ block: 'nearest' });
    }
    const done = setTimeout(() => setReveal(null), 2400);
    return () => clearTimeout(done);
  }, [reveal, rowElement, groups]);
  useLayoutEffect(() => { writeOpenRow(compact, openId); }, [compact, openId]);
  // On the next frame: the shell puts a newly shown page back at its top after
  // the page's own effects have run.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || loading) return;
    restored.current = true;
    if (!openId) return;
    const frame = requestAnimationFrame(() => rowElement(openId)?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [loading, openId, rowElement]);

  const failing = groups.reduce((n, g) => n + g.failing, 0);
  const collapsedSet = useMemo(() => new Set(collapsed), [collapsed]);

  // The failing count takes the person to the first failing routine, opened (as on the iPhone).
  const showFirstFailing = useLeanCallback(() => {
    for (const g of groups) {
      const r = g.routines.find((x) => routineHealth(x) === 'error');
      if (!r) continue;
      setCollapsed((prev) => prev.filter((k) => k !== g.key));
      setOpenId(r.id);
      setReveal(r.id);
      return;
    }
  }, [groups, setCollapsed]);

  const toggleGroup = useLeanCallback((key: string) => {
    setCollapsed((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, [setCollapsed]);

  // A switch or a delete the server refused: the store has already put the row back
  // as it was; the reason shows on that row, naming what failed, until its next action
  // (2026-11-04, a review: a banner above the list pushed the flipped row off screen).
  const act = useLeanCallback(async (id: string, verb: string, fn: () => Promise<unknown>) => {
    setRowErrors((prev) => (id in prev ? omit(prev, id) : prev));
    try {
      await fn();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      setRowErrors((prev) => ({ ...prev, [id]: `Could not ${verb}: ${why}` }));
    }
  }, []);
  const handleToggle = useLeanCallback((id: string, enabled: boolean) => {
    void act(id, enabled ? 'turn it on' : 'pause it', () => setEnabled(id, enabled));
  }, [act, setEnabled]);
  const dismissRowError = useLeanCallback((id: string) => setRowErrors((prev) => omit(prev, id)), []);
  // The row shows what a run answered (RoutineRow): a refusal is not a page-level alert.
  const handleRunNow = useLeanCallback((id: string) => runNow(id), [runNow]);
  const handleDelete = useLeanCallback((id: string) => { void act(id, 'delete it', () => remove(id)); }, [act, remove]);

  const handleDraft = useLeanCallback((d: CreateRoutineInput) => {
    setDraft(d);
    setEditing(undefined);
    setShowForm(true);
  }, []);

  // The words typed in the box go into the form, so nothing is typed twice: when the
  // model could not draft it, and when the person builds it by hand.
  const handleManual = useLeanCallback((text: string) => {
    setDraft(text ? { name: '', schedule: undefined as unknown as CreateRoutineInput['schedule'], executor: { type: 'claude-code', config: { instructions: text } } } : undefined);
    setEditing(undefined);
    setShowForm(true);
  }, []);
  const handleDraftFailed = useLeanCallback((_error: string, text: string) => handleManual(text), [handleManual]);

  const handleSave = useLeanCallback(async (input: CreateRoutineInput) => {
    if (editing) {
      // Someone saved this routine after the form opened (another tab, the phone, an
      // agent): say what, keep the person's edits, and let a second Save replace it.
      // The store reads the list again (the only place that fetches it whole).
      await loadRoutines(true);
      const latest = (getRoutinesSnapshot().routines ?? routines).find((r) => r.id === editing.id);
      const changed = latest ? changedSince(editing, latest) : [];
      if (latest && changed.length > 0 && seenConflict.current !== editKey(latest)) {
        seenConflict.current = editKey(latest);
        throw new Error(`This routine's ${listWords(changed)} changed elsewhere after you opened it. Your edits are still here: Save again to replace that change, or Cancel to keep it.`);
      }
      // An edit can move the routine to another group (its task changed): unfold
      // that group, keep the row open and bring it into view, drawn out briefly.
      const saved = await update(editing.id, input);
      const key = groupKeyOf(saved ?? editing);
      setCollapsed((prev) => prev.filter((k) => k !== key));
      setOpenId(editing.id);
      setReveal(editing.id);
    } else {
      const made = await create(input);
      // Made: the box's words are used up, here and on every other device.
      discardDraft(draftKey('routine-ask', 'new'));
      setComposing(false);
      const key = groupKeyOf(made);
      setCollapsed((prev) => prev.filter((k) => k !== key));
      setOpenId(made.id);
      setReveal(made.id);
    }
    setShowForm(false);
    setDraft(undefined);
    setEditing(undefined);
  }, [editing, routines, create, update, setCollapsed]);

  const handleEdit = useLeanCallback((routine: Routine) => {
    seenConflict.current = null;
    setEditing(routine);
    setDraft(undefined);
    setShowForm(true);
  }, []);

  const handleCancel = useLeanCallback(() => {
    setShowForm(false);
    setDraft(undefined);
    setEditing(undefined);
  }, []);

  if (loading) return <LoadingSpinner />;

  const empty = routines.length === 0;

  return (
    <div className={`routines-view${compact ? ' routines-view-compact' : ''}`}>
      <div className="routines-toolbar">
        <span className="routines-summary">
          {empty ? 'No routines yet' : `${routines.length} ${routines.length === 1 ? 'routine' : 'routines'}`}
          {failing > 0 && (
            <button type="button" className="routines-summary-failing" onClick={showFirstFailing} title="Show the first failing routine">
              {failing} failing
            </button>
          )}
        </span>
        {!empty && (
          <button
            type="button"
            className={`btn btn-sm ${composing ? 'btn-secondary' : 'btn-primary'} routines-new-btn`}
            aria-expanded={composing}
            aria-pressed={composing}
            title={composing ? 'Hide the new routine box' : undefined}
            onClick={() => { composeFocus.current = true; setComposing((v) => !v); }}
          >
            New routine
          </button>
        )}
      </div>

      {(composing || empty) && (
        <RoutineComposer onDraft={handleDraft} onDraftFailed={handleDraftFailed} onManual={handleManual} autoFocus={composeFocus.current} />
      )}

      {showForm && (
        <RoutineForm
          draft={draft}
          routine={editing}
          executors={executors}
          options={options}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      )}

      {error && <div className="cron-form-error">{error}</div>}

      {empty ? (
        <div className="empty-state">
          <div className="empty-state-icon">&#9889;</div>
          <p>No routines yet</p>
          <p className="text-sm mt-2">Describe what you want automated above</p>
        </div>
      ) : (
        <div className="routine-groups routine-list" ref={listRef}>
          {groups.map((group) => {
            const folded = collapsedSet.has(group.key);
            const listId = `routine-group-${group.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
            return (
              <section key={group.key} className="routine-group" data-group={group.key} data-collapsed={folded ? 'true' : 'false'}>
                <h2 className="routine-group-heading">
                  <button
                    type="button"
                    className="routine-group-header"
                    aria-expanded={!folded}
                    aria-controls={listId}
                    onClick={() => toggleGroup(group.key)}
                    title={group.global ? 'Routines that belong to no project' : `Routines of tasks in ${group.name}`}
                  >
                    <svg className={`routine-row-chevron routine-group-chevron${folded ? '' : ' open'}`} viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="routine-group-name">{group.name}</span>
                    <span className="routine-group-count">{group.routines.length}</span>
                    {group.failing > 0 && <span className="routine-group-failing">{group.failing} failing</span>}
                  </button>
                </h2>
                {!folded && (
                  <ul className="routine-group-list cron-job-list" id={listId}>
                    {group.routines.map((r) => (
                      <RoutineRow
                        key={r.id}
                        routine={r}
                        executorLabels={executorLabels}
                        open={openId === r.id}
                        isNew={reveal === r.id}
                        onOpenChange={(open) => openRow(r.id, open)}
                        onToggle={handleToggle}
                        onRunNow={handleRunNow}
                        onCatchUp={catchUp}
                        onDismissMissed={dismissMissed}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        actionError={rowErrors[r.id]}
                        onDismissError={dismissRowError}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

const OPEN_ROW_KEY = 'walnut:routines.open.v1';

function readOpenRow(compact: boolean): string | null {
  try { return sessionStorage.getItem(`${OPEN_ROW_KEY}:${compact ? 'panel' : 'page'}`); } catch { return null; }
}

function writeOpenRow(compact: boolean, id: string | null): void {
  try {
    const key = `${OPEN_ROW_KEY}:${compact ? 'panel' : 'page'}`;
    if (id) sessionStorage.setItem(key, id); else sessionStorage.removeItem(key);
  } catch { /* storage refused: the row just starts closed */ }
}

function listWords(words: string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function omit(map: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _gone, ...rest } = map;
  return rest;
}

/** The element that scrolls this row: the page's own scroller, else the window. */
function scrollerOf(el: HTMLElement): HTMLElement | Window {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return window;
}
