/**
 * The org chart: Main and its VPs, one screen.
 *
 *   Main · CEO
 *   └ one card per VP: its name, its news in its tasks' own words, when that was, how many
 *     things need the user, and the projects it leads (its own included), each with its
 *     counts; a project opens to its tasks and where each stands, and a task opens beside
 *     the Org page (OrgChartProject.tsx)
 *
 * Drag a project onto another VP's card to put it under that VP (or use its ⋯ menu); drag it
 * onto "Own VP" to give it back. The card says what a drop would do before it happens, and
 * every change is confirmed first. No task changes project: the server only changes who
 * leads it (POST /api/v1/org/vp), and the VP that lets go sums up its work for the new one.
 * The cards are the Org page's own rows (org-chart-model.ts), so both say the same thing.
 * A click outside the sheet closes it, as × and Escape do; the move menu and the question
 * close first (the same order as Escape).
 */
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { setProjectVp } from '@/api/org';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { log } from '@/utils/log';
import { ContextMenu, type ContextMenuItem } from '@/components/common/ContextMenu';
import { OrgAvatar, shortAgo } from './OrgChannelList';
import { OrgChartProject } from './OrgChartProject';
import { cardOf, ceoLine, dropPlan, vpCards, type DropPlan, type VpCard, type VpProject } from './org-chart-model';
import type { ChannelRow } from './org-channels-model';
import '@/styles/org-chart.css';

interface Props {
  main: ChannelRow;
  /** One row per project (OrgChannels.projects). */
  rows: readonly ChannelRow[];
  tasks: readonly Task[];
  onClose: () => void;
  /** Open a card on the Org page (a channel row's key). */
  onPick: (key: string) => void;
  /** Open a task beside the Org page. */
  onOpenTask: (taskId: string) => void;
  /** The page's minute clock, for "23m". */
  now: number;
}

const DRAG_TYPE = 'application/x-walnut-org-project';

/** A clickable div: Enter and Space press it too. */
function pressable(onPress: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress(); }
    },
  };
}
const needsTitle = (n: number) => `${n} ${n === 1 ? 'needs' : 'need'} you`;
/** The drop zone that gives a project back its own VP. */
const OWN = '__own__';

/** "23m · Renew the permit": when the news was written, and the task it is about. */
const metaLine = (newsAt: number, task: string | undefined, now: number) => [shortAgo(newsAt, now), task].filter(Boolean).join(' · ');

export function OrgChartSheet({ main, rows, tasks, onClose, onPick, onOpenTask, now }: Props) {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [pending, setPending] = useState<DropPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [menu, setMenu] = useState<{ project: VpProject; x: number; y: number; from: HTMLElement } | null>(null);
  // Escape closes the innermost thing first: the menu, then the question, then the sheet.
  // (This listener runs before the menu's own and stops the key, so it closes the menu too.)
  useModalOverlay(() => {
    if (menu) { setMenu(null); menu.from.focus(); return; }
    if (pending) { if (!busy) setPending(null); return; }
    onClose();
  });
  useDialogFocus(panel, 'Org chart');
  const cards = vpCards(rows);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t] as const)), [tasks]);
  const pick = (key: string) => { onClose(); onPick(key); };
  const openTask = (taskId: string) => { onClose(); onOpenTask(taskId); };
  // A click outside the sheet: pressed and released on the backdrop itself (a press inside that
  // ends outside is a selection or a drag, not a click outside). What was open at the press
  // closes first, as Escape does: the menu (it closes itself on that press), then the question.
  const pressedOutside = useRef<{ menu: boolean; pending: boolean } | null>(null);
  const projectOf = (key: string | null) => (key ? cards.flatMap((c) => c.projects).find((p) => p.key === key) ?? null : null);
  const dragged = projectOf(dragKey);
  // The drag's project, known from dragstart on: the state above is set a tick later, and a
  // quick drop lands before it.
  const dragRef = useRef<string | null>(null);
  const planFor = (target: VpCard | null) => {
    const p = projectOf(dragRef.current ?? dragKey);
    return p ? dropPlan(cards, p, target) : null;
  };

  const ask = (plan: DropPlan | null) => {
    if (!plan) return;
    setError('');
    setPending(plan);
  };

  const apply = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await setProjectVp(pending.project, pending.vp);
      log.info('org-chart', 'project vp changed', { project: res.project, vp: res.vp, leadTaskId: res.lead?.id, moved: res.moved.length, handover: res.handover.length });
      setDone(res.vp ? `${res.project} is now under ${res.vp}'s VP.` : `${res.project} has its own VP again.`);
      setPending(null);
    } catch (err) {
      // The server's own words when it answered; a dropped connection is just "try again".
      const answered = typeof (err as { status?: unknown }).status === 'number';
      const detail = err instanceof Error ? err.message : String(err);
      log.warn('org-chart', 'project vp change failed', { project: pending.project, vp: pending.vp, error: detail });
      setError(answered ? detail : 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  const onDragStart = (e: DragEvent, p: VpProject) => {
    e.stopPropagation();
    e.dataTransfer.setData(DRAG_TYPE, p.key);
    // WebKit starts a drag only with some data set.
    e.dataTransfer.setData('text/plain', p.name);
    e.dataTransfer.effectAllowed = 'move';
    dragRef.current = p.key;
    // After the event: a render inside dragstart that moves the page under the pointer makes
    // Chromium drop the drag.
    window.setTimeout(() => {
      if (dragRef.current !== p.key) return;
      setDone('');
      setDragKey(p.key);
    }, 0);
  };
  // Enter/leave fire for every child the pointer crosses, and Safari gives dragleave no
  // relatedTarget: a count per zone says when the pointer really left it.
  const depth = useRef(new Map<string, number>());
  const endDrag = () => { dragRef.current = null; depth.current.clear(); setDragKey(null); setOverKey(null); };
  const dropZone = (key: string, target: VpCard | null) => ({
    onDragEnter: (e: DragEvent) => {
      if (!planFor(target)) return;
      e.preventDefault();
      depth.current.set(key, (depth.current.get(key) ?? 0) + 1);
      if (overKey !== key) setOverKey(key);
    },
    onDragOver: (e: DragEvent) => {
      if (!planFor(target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (overKey !== key) setOverKey(key);
    },
    onDragLeave: () => {
      const left = (depth.current.get(key) ?? 1) - 1;
      depth.current.set(key, left);
      if (left <= 0) setOverKey((k) => (k === key ? null : k));
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const plan = planFor(target);
      endDrag();
      ask(plan);
    },
  });

  const openMenu = (e: MouseEvent<HTMLButtonElement>, project: VpProject) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ project, x: r.left, y: r.bottom + 4, from: e.currentTarget });
  };
  const menuItems = (project: VpProject): ContextMenuItem[] => {
    const own = dropPlan(cards, project, null);
    const others = cards.filter((c) => dropPlan(cards, project, c));
    const items: ContextMenuItem[] = [{ key: 'head', section: true, label: `Move ${project.name} under` }];
    for (const c of others) items.push({ key: `vp:${c.key}`, label: `${c.name}'s VP`, onSelect: () => ask(dropPlan(cards, project, c)) });
    if (own) {
      if (others.length) items.push({ key: 'sep', divider: true });
      items.push({ key: 'own', label: 'Its own VP', onSelect: () => ask(own) });
    }
    if (!others.length && !own) items.push({ key: 'none', info: true, label: 'No other VP to move to' });
    return items;
  };

  const projectHandle = (p: VpProject) => (
    p.project ? (
      <button
        type="button"
        className="oc-more"
        data-testid="org-chart-project-menu"
        aria-label={`Move ${p.name} to another VP`}
        title="Move to another VP"
        onClick={(e) => openMenu(e, p)}
      >⋯</button>
    ) : null
  );

  const draggingUnder = dragged ? cardOf(cards, dragged.key) : undefined;
  // Shown while some VP leads more than its own project, so a drag never moves the cards.
  const hasGroups = cards.some((c) => c.projects.length > 1);
  const ownActive = !!(dragged && draggingUnder && draggingUnder.key !== dragged.key);

  const sheet = (
    <div
      className="org-sheet-layer"
      data-testid="org-chart"
      // Not part of the board: a pointer here must never start the home page's drag sensors.
      onPointerDown={(e) => {
        e.stopPropagation();
        pressedOutside.current = e.target === e.currentTarget ? { menu: !!menu, pending: !!pending } : null;
        if (pressedOutside.current?.menu) setMenu(null);
      }}
      onClick={(e) => {
        const press = pressedOutside.current;
        pressedOutside.current = null;
        if (!press || e.target !== e.currentTarget || press.menu) return;
        if (press.pending) { if (!busy) setPending(null); return; }
        onClose();
      }}
    >
      <div ref={setPanel} className="org-sheet" role="dialog" aria-modal="true" aria-label="Org chart" tabIndex={-1}>
        <header className="org-sheet-head">
          <div>
            <h2 className="org-sheet-title">Org chart</h2>
            <p className="org-sheet-hint">Drag a project onto another VP to put it under that VP. Nothing changes until you confirm.</p>
          </div>
          <button type="button" className="task-action-btn org-sheet-close" onClick={onClose} aria-label="Close the org chart" title="Close">&times;</button>
        </header>
        {done && <p className="oc-done" role="status" data-testid="org-chart-done">{done}</p>}

        <div className="oc-tree">
          <button type="button" className="oc-card oc-ceo" data-testid="org-chart-ceo" onClick={() => pick(main.key)} title="Open Main">
            <OrgAvatar row={main} size={34} />
            <span className="oc-card-text">
              <span className="oc-card-name"><span className="oc-card-title">Main</span><span className="oc-role">CEO</span></span>
              <span className="oc-card-line">{ceoLine(cards)}</span>
            </span>
            {main.alerts.length > 0 && <span className="oc-badge" title={needsTitle(main.alerts.length)}>{main.alerts.length}</span>}
          </button>
          <div className="oc-stem" aria-hidden="true" />
          {hasGroups && (
            <div
              className={`oc-own${ownActive ? ' is-active' : ''}${overKey === OWN ? ' is-over' : ''}`}
              data-testid="org-chart-own"
              {...dropZone(OWN, null)}
            >
              {overKey === OWN ? planFor(null)?.hint
                : ownActive ? `Drop here to give ${dragged!.name} its own VP`
                  : 'Drag a project here to give it its own VP'}
            </div>
          )}
          {cards.length === 0 ? (
            <p className="org-empty" data-testid="org-chart-empty">No open work yet. Ask Main to start something.</p>
          ) : (
            <ul className="oc-vps" data-testid="org-chart-vps">
              {cards.map((c) => {
                const plan = dragged ? planFor(c) : null;
                const over = overKey === c.key && !!plan;
                const single = c.projects.length === 1;
                const home = c.projects[0]!;
                return (
                  <li
                    key={c.key}
                    className={`oc-vp${over ? ' is-over' : ''}${dragged && plan ? ' can-drop' : ''}${dragKey === c.key && single ? ' is-dragging' : ''}`}
                    data-testid="org-chart-vp"
                    data-key={c.key}
                    data-project={c.project}
                    {...(c.role === 'VP' ? dropZone(c.key, c) : {})}
                  >
                    <div
                      className="oc-vp-head"
                      draggable={!!c.project}
                      onDragStart={(e) => onDragStart(e, home)}
                      onDragEnd={endDrag}
                      data-testid="org-chart-vp-handle"
                    >
                      {/* A div, not a button: WebKit and Firefox start no drag from inside a button. */}
                      <div className="oc-card-btn" {...pressable(() => pick(c.key))} title={`Open ${c.name}`}>
                        <OrgAvatar row={c.row} size={30} />
                        <span className="oc-card-text">
                          <span className="oc-card-name">
                            <span className="oc-card-title">{c.name}</span>
                            <span className="oc-role">{c.role}</span>
                          </span>
                          <span className={`oc-card-news${c.needsYou > 0 ? ' is-alert' : ''}`} data-testid="org-chart-vp-news" title={c.newsTask ? `${c.newsTask}: ${c.news}` : c.news}>{c.news}</span>
                          <span className="oc-card-line" data-testid="org-chart-vp-meta">{metaLine(c.newsAt, c.newsTask, now)}</span>
                          {!single && <span className="oc-card-line" data-testid="org-chart-vp-line">{c.line}</span>}
                        </span>
                        {c.needsYou > 0 && <span className="oc-badge" data-testid="org-chart-vp-needs" title={needsTitle(c.needsYou)}>{c.needsYou}</span>}
                      </div>
                    </div>
                    <ul className="oc-projects" data-testid="org-chart-projects" aria-label={`Projects ${c.name}'s VP leads`}>
                      {c.projects.map((p) => (
                        <OrgChartProject
                          key={p.key}
                          project={p}
                          tasks={byId}
                          dragging={dragKey === p.key}
                          onDragStart={onDragStart}
                          onDragEnd={endDrag}
                          onOpenTask={openTask}
                          menu={projectHandle(p)}
                        />
                      ))}
                    </ul>
                    {over && <div className="oc-hint" data-testid="org-chart-hint" title={plan!.hint}>{plan!.hint}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {pending && (
          <div className="oc-confirm-layer">
            <div className="oc-confirm" role="alertdialog" aria-modal="true" aria-label={pending.title} data-testid="org-chart-confirm">
              <h3 className="oc-confirm-title">{pending.title}</h3>
              <ul className="oc-confirm-lines">
                {pending.lines.map((l) => <li key={l}>{l}</li>)}
              </ul>
              {error && <p className="oc-confirm-error" role="alert" data-testid="org-chart-error">Not changed. {error}</p>}
              <div className="oc-confirm-actions">
                <button type="button" className="btn btn-sm" onClick={() => setPending(null)} disabled={busy}>Cancel</button>
                <button type="button" className="btn btn-sm btn-primary" data-testid="org-chart-apply" onClick={() => { void apply(); }} disabled={busy} autoFocus>
                  {busy ? 'Working…' : pending.confirm}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      {menu && (
        <ContextMenu
          point={{ x: menu.x, y: menu.y }}
          items={menuItems(menu.project)}
          onClose={() => setMenu(null)}
          returnFocus={menu.from}
          testId="org-chart-move-menu"
        />
      )}
    </div>
  );
  return createPortal(sheet, document.body);
}
