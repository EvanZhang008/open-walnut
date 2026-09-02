/**
 * TierProjectLabelRow — the slim project label above each project run inside a
 * pinned tier ("By project" view). It is the tier's counterpart to the main
 * list's project header, and since 2026-09 it behaves like one: a click anywhere
 * on the row folds/unfolds that project's run, and a right-click opens the shared
 * project menu (ProjectContextMenu).
 *
 * Its OWN component rather than inline JSX in TodoPanel's tier loop for the same
 * reason FolderHeaderRow is: the right-click menu needs hooks, and the menu node
 * has to be a SIBLING of this row — one hook instance per rendered label is the
 * only shape that gives both without duplicating the menu node.
 *
 * Three constraints this row lives under, all of them load-bearing:
 *
 *  · The row is an HTML5 drag handle for project REORDERING (`dragProps`, owned
 *    by the caller — the drop splices `ordering.projects`). Chromium does not
 *    fire a click after a completed native drag, which is what lets the same row
 *    be both a fold target and a drag handle without a "did we just drag" flag.
 *  · `inert` = a dnd-kit CARD drag is live. The label stays visible (hiding the
 *    labels mid-drag collapsed the tier into a flat list, 2026-08-13) but every
 *    gesture is refused, fold included: folding a run out from under a pointer
 *    that is dragging a card into it is how indices shift.
 *  · The "+" lives in `.tier-project-label-actions`, which stops click and
 *    pointerdown itself — that IS the mechanism that keeps pressing "+" from
 *    folding the project, so no target sniffing is needed here.
 */
import { type HTMLAttributes } from 'react';
import * as ICONS from '../common/Icons';
import { ProjectPlusMenu } from './ProjectHeaderMenus';
import { useProjectContextMenu } from './ProjectContextMenu';

export interface TierProjectLabelRowProps {
  /** '' = Inbox (a legal drag participant and a legal fold target; it just has
   *  no registry row, so the menu's rename/delete/detail rows drop out). */
  project: string;
  /** Cards this project has in THIS tier. Tier-local on purpose, same rule as the
   *  folder chip's badge: a number counting rows the tier can't show at all would
   *  jump around for no visible reason. Rows hidden by a COLLAPSED folder still
   *  count, and a folded run keeps its full number, which is the point: the count
   *  is what tells you how much is behind the fold. */
  count: number;
  collapsed: boolean;
  /** A pinned card drag is live — read-only separator until the drop lands. */
  inert: boolean;
  /** Which edge to draw the project-reorder insertion line on (null = not a
   *  drop target right now). */
  dropIndicator: 'above' | 'below' | null;
  /** `draggable` + the five HTML5 drag handlers, built by the caller so the
   *  reorder logic stays in one place with `ordering.projects`. */
  dragProps: HTMLAttributes<HTMLDivElement> & { draggable: boolean };
  onToggleCollapse: (project: string) => void;
  /** Open this project's inline "add task" row in this tier. */
  onAddTask: (project: string) => void;
  onAddSeparator: (project: string) => void;
  onAddFolder?: (project: string) => void;
  /** Named projects only (a launch seeds the project's default folder). */
  onAddSession?: (project: string) => void;
  isFavorite?: boolean;
  onToggleFavorite?: (project: string) => void;
  onViewDetails?: (project: string) => void;
}

export function TierProjectLabelRow({
  project, count, collapsed, inert, dropIndicator, dragProps,
  onToggleCollapse, onAddTask, onAddSeparator, onAddFolder, onAddSession,
  isFavorite, onToggleFavorite, onViewDetails,
}: TierProjectLabelRowProps) {
  const projectMenu = useProjectContextMenu({
    onToggleCollapse,
    onNewTask: onAddTask,
    onNewFolder: onAddFolder,
    onNewSession: onAddSession,
    // Same verb the row's "+" carries: a right-click and the "+" must not offer
    // different actions on one row.
    onNewSeparator: onAddSeparator,
    onToggleFavorite,
    onViewDetails,
  });
  const className = [
    'tier-project-label',
    inert ? 'tier-project-label-inert' : 'tier-project-label-draggable tier-project-label-clickable',
    dropIndicator ? `tier-project-label-dropover dropover-${dropIndicator}` : '',
  ].filter(Boolean).join(' ');
  return (
    <>
      <div
        // The REAL project name, which the visible text isn't: Inbox renders as
        // "Inbox" but is stored as ''. Anything matching projects (a separator's
        // boundary, a test) needs the stored value.
        data-project={project}
        className={className}
        {...dragProps}
        title={inert
          ? 'Project'
          : `Project — click to ${collapsed ? 'expand' : 'collapse'}, drag to reorder projects`}
        onClick={() => { if (!inert) onToggleCollapse(project); }}
        onContextMenu={(e) => projectMenu.open(e, { project, collapsed, favorite: isFavorite })}
      >
        <button
          className={`collapse-chevron${collapsed ? '' : ' expanded'}`}
          onClick={(e) => { e.stopPropagation(); if (!inert) onToggleCollapse(project); }}
          // Same disarm trick the "+" uses, and needed for the same measured
          // reason: a 14px target lets the pointer slip past Chromium's native
          // drag threshold between press and release, and the ancestor's drag
          // then EATS the click. React's `draggable={false}` on this button does
          // not stop drag detection on the draggable ANCESTOR; toggling the DOM
          // property does.
          onPointerEnter={(e) => { const label = e.currentTarget.parentElement; if (label) label.draggable = false; }}
          onPointerLeave={(e) => { const label = e.currentTarget.parentElement; if (label) label.draggable = !inert; }}
          title={collapsed ? 'Expand project' : 'Collapse project'}
          aria-label={collapsed ? 'Expand project' : 'Collapse project'}
        >
          {ICONS.CHEVRON_GLYPH}{/* same glyph as every other collapse row; CSS rotates it when expanded */}
        </button>
        {/* SOLID icon + kind-tag = project; folders inside render with the
            hollow icon + indent, so the two levels never read the same. */}
        <span className="tier-project-label-icon">{ICONS.ICON_FOLDER_SOLID}</span>
        <span className="tier-project-label-name">{project || 'Inbox'}</span>
        <span className="project-kind-tag">project</span>
        {/* Same rule as the folder chip's badge: draw it only when there is
            something to count. */}
        {count > 0 && <span className="tier-project-label-count" aria-hidden="true">{count}</span>}
        {/* Project "+" (GAP-2) — the same control the All-view project header
            carries, so a by-project tier reads and behaves the same way: new
            task / new task with session / new folder / add separator.
            The label is an HTML5 drag handle, so a dragstart originating on the
            button is swallowed here — otherwise pressing "+" and twitching would
            arm a project reorder. */}
        <span
          className="tier-project-label-actions"
          draggable={false}
          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
          // The row folds on click: the actions area must never reach it (the
          // buttons stop their own clicks, this covers the padding around them).
          onClick={(e) => e.stopPropagation()}
          // Disarm the label's OWN draggability while the pointer is over the
          // "+": `draggable=false` here doesn't stop Chromium's native drag
          // detection on the draggable ANCESTOR, which silently eats the click
          // once the pointer slips ≥3px between press and release (measured; a
          // 16×12 target on a trackpad slips often). Toggled on the DOM node
          // directly — no re-render happens mid-hover, and a re-render outside
          // one re-applies React's value harmlessly.
          onPointerEnter={(e) => { const label = e.currentTarget.parentElement; if (label) label.draggable = false; }}
          // `!inert`, matching the chevron's own re-arm above: the row is only a
          // drag handle while no card drag is live, and restoring a bare `true`
          // would re-arm it mid-drag.
          onPointerLeave={(e) => { const label = e.currentTarget.parentElement; if (label) label.draggable = !inert; }}
        >
          <ProjectPlusMenu
            project={project}
            onAddSession={onAddSession}
            onAddTask={onAddTask}
            onAddSeparator={onAddSeparator}
            onAddFolder={onAddFolder}
          />
        </span>
      </div>
      {/* Sibling, not child — see the note in ProjectContextMenu.tsx. */}
      {projectMenu.node}
    </>
  );
}
