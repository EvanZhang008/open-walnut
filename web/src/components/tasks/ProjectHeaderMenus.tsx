/**
 * ProjectHeaderMenus — the two hover actions on a project group header:
 *
 *   ProjectPlusMenu  ("+")  → new task / new task with session / add separator
 *   ProjectKebabMenu ("⋮")  → Details / Favorite / Rename… / Delete…
 *
 * The "+" adapts to how many things its host can actually offer (R9):
 *
 *   ONE action  → a DIRECT button, no menu. This is the R7 ruling: a menu that
 *                 always resolves to the same item is a wasted click.
 *   TWO or more → a menu, because now there IS a decision — "a task", "a task
 *                 with a session (draft column)", "a separator line". Right-click
 *                 on the button opens the same menu.
 *
 * So hosts that only know how to launch a session (the /tasks table) keep the
 * one-click behaviour untouched, while the TODO panel's tier and project headers
 * become the one control that carries all three verbs.
 *
 * The menus portal to <body> with useMenuPlacement — same pattern (and same
 * .task-kebab-menu styling) as TaskKebabMenu, so they inherit flip/clamp behavior
 * and the theme. The call site gates by group: the kebab is named-projects-only
 * (Inbox has no registry row to rename/delete/detail), and so is the SESSION item
 * (a session launch seeds the project's default folder, which Inbox cannot have)
 * — but a task or a separator works fine in Inbox, so its "+" still appears.
 */

import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useProjectActions } from '@/hooks/useProjectActions';
import * as ICONS from '../common/Icons';

/** Shared open/close + placement shell for one trigger button and its menu.
 *  Supports two anchor paths (same semantics as TaskKebabMenu): the trigger
 *  button, or a right-click cursor point (frozen viewport coords — close on
 *  any outside scroll since the point no longer tracks the row). */
function useHeaderMenu() {
  const [open, setOpen] = useState(false);
  const [cursorAnchor, setCursorAnchor] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => { setOpen(false); setCursorAnchor(null); }, []);
  const menuPos = useMenuPlacement(open, btnRef, menuRef, { anchorPoint: cursorAnchor, onAnchorLost: closeMenu });
  const openAtCursor = useCallback((x: number, y: number) => {
    setCursorAnchor({ x, y });
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    const handleScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (cursorAnchor) { closeMenu(); return; }
      const r = btnRef.current?.getBoundingClientRect();
      if (r && (r.bottom < 0 || r.top > window.innerHeight)) closeMenu();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, closeMenu, cursorAnchor]);

  return { open, setOpen, btnRef, menuRef, menuPos, closeMenu, openAtCursor, setCursorAnchor };
}

// ── "+" — new task / new task with session / add separator ──────────────────

/** Icons for the "+" menu items. Local to this file: a 14px hairline reads as
 *  "a divider line", which no shared icon in Icons.tsx expresses. */
const ICON_MENU_TASK = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6" /></svg>
);
const ICON_MENU_SESSION = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 3.5h11v7h-5l-3 2.5v-2.5h-3z" /></svg>
);
const ICON_MENU_SEPARATOR = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 8h12" /></svg>
);
// Same glyph the folder ROWS draw, at this menu's 14px size (Icons.tsx owns the path).
const ICON_MENU_FOLDER = ICONS.folderOutlineIcon(14);

export interface PlusAction {
  key: string;
  icon: ReactNode;
  label: string;
  /** Tooltip/aria text to use when this is the ONLY action, so a single-action
   *  host keeps the exact wording it had before the menu existed. */
  soloTitle?: string;
  run: () => void;
}

/**
 * The "+" control itself: direct button for a single action, menu for several.
 * Shared by the project header and the tier header so both read and behave the
 * same way.
 */
function PlusControl({ actions, restLabel, wrapClassName }: {
  actions: PlusAction[];
  /** Tooltip / aria text ("Immigration", "Focus"). */
  restLabel: string;
  wrapClassName?: string;
}) {
  const { open, setOpen, btnRef, menuRef, menuPos, closeMenu, openAtCursor, setCursorAnchor } = useHeaderMenu();
  if (actions.length === 0) return null;
  const single = actions.length === 1 ? actions[0] : null;
  const title = single ? (single.soloTitle ?? `${single.label}: ${restLabel}`) : `Add to ${restLabel}`;
  return (
    <span className={wrapClassName ?? 'todo-group-action-wrap'} data-menu-open={open || undefined}>
      <button
        ref={btnRef}
        // `-plus` modifier: the "+" is legible AT REST (muted, full on hover) while
        // the kebab stays hover-only. A discoverability call — a control nobody can
        // see until they happen to hover the right row may as well not exist.
        className="todo-group-action-btn todo-group-action-btn-plus"
        onClick={(e) => {
          e.stopPropagation();
          if (single) { single.run(); return; }
          setCursorAnchor(null);
          setOpen(!open);
        }}
        // Right-click lands on the same menu — the button is the one control in
        // the panel with more than one verb, so it owns its context menu.
        onContextMenu={(e) => {
          if (single) return;
          e.preventDefault();
          e.stopPropagation();
          openAtCursor(e.clientX, e.clientY);
        }}
        // Header rows are click-to-collapse AND dnd-kit drag handles, so both
        // events must stop here: the click would fold the section, the pointerdown
        // would arm a reorder while the user is just pressing "+".
        onPointerDown={(e) => e.stopPropagation()}
        // ONLY the keys the host row itself acts on (a tier sublabel toggles its
        // collapse on Enter/Space). A blanket stopPropagation here also swallowed
        // ESCAPE — the button keeps focus after opening the menu, so the document
        // keydown listener that closes it never saw the key and the menu could only
        // be dismissed by clicking away.
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
        title={title}
        aria-label={title}
        aria-expanded={single ? undefined : open}
        data-testid="plus-menu-trigger"
      >
        +
      </button>
      {open && !single && createPortal(
        <div
          ref={menuRef}
          className="task-kebab-menu"
          style={menuPlacementStyle(menuPos)}
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="plus-menu"
        >
          {actions.map((a) => (
            <button
              key={a.key}
              className="task-kebab-item"
              onClick={(e) => { e.stopPropagation(); closeMenu(); a.run(); }}
            >
              <span className="task-kebab-icon">{a.icon}</span>
              <span>{a.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
}

export function ProjectPlusMenu({ project, onAddSession, onAddTask, onAddSeparator, onAddFolder }: {
  project: string;
  /** Open a new draft session column seeded with this project (and its default
   *  cwd/host, patched in when the project detail resolves). Omit for Inbox —
   *  it has no registry row to carry a default folder. */
  onAddSession?: (project: string) => void;
  /** Open this project's inline "add task" row. */
  onAddTask?: (project: string) => void;
  /** Drop a divider line at the top of this project's run. */
  onAddSeparator?: (project: string) => void;
  /** Create an empty folder inside this project (name prompted inline). */
  onAddFolder?: (project: string) => void;
}) {
  const label = project || 'Inbox';
  const actions: PlusAction[] = [];
  if (onAddTask) actions.push({ key: 'task', icon: ICON_MENU_TASK, label: 'New task', run: () => onAddTask(project) });
  if (onAddSession) actions.push({ key: 'session', icon: ICON_MENU_SESSION, label: 'New task with session', soloTitle: `New session in ${label}`, run: () => onAddSession(project) });
  if (onAddFolder) actions.push({ key: 'folder', icon: ICON_MENU_FOLDER, label: 'New folder', run: () => onAddFolder(project) });
  if (onAddSeparator) actions.push({ key: 'separator', icon: ICON_MENU_SEPARATOR, label: 'Add separator', run: () => onAddSeparator(project) });
  return <PlusControl actions={actions} restLabel={label} />;
}

// ── "+" — same control on a tier header (R8) ─────────────────────────────────

export function TierPlusButton({ tier, label, onAddSession, onAddTask, onAddSeparator }: {
  /** Built-in tier name ('focus' | 'satellite' | 'backlog' | 'wait') or a custom
   *  tier id (`ct_*`) — whatever `meta.pinTier` accepts. */
  tier: string;
  /** Human label for the tooltip ("Focus", "Satellite", a custom tier's name). */
  label: string;
  /** Open a draft session column with this tier preset. */
  onAddSession?: (tier: string) => void;
  /** Open this tier's inline "add task" row. */
  onAddTask?: (tier: string) => void;
  /** Drop a divider line at the top of this tier's list. */
  onAddSeparator?: (tier: string) => void;
}) {
  const actions: PlusAction[] = [];
  if (onAddTask) actions.push({ key: 'task', icon: ICON_MENU_TASK, label: 'New task', run: () => onAddTask(tier) });
  if (onAddSession) actions.push({ key: 'session', icon: ICON_MENU_SESSION, label: 'New task with session', soloTitle: `New session in ${label}`, run: () => onAddSession(tier) });
  if (onAddSeparator) actions.push({ key: 'separator', icon: ICON_MENU_SEPARATOR, label: 'Add separator', run: () => onAddSeparator(tier) });
  return <PlusControl actions={actions} restLabel={label} wrapClassName="todo-group-action-wrap todo-tier-action-wrap" />;
}

// ── "⋮" — project management ────────────────────────────────────────────────

export function ProjectKebabMenu({ project, isFavorite, onToggleFavorite, onViewDetails, onChanged, rowSelector, wrapClassName, btnClassName }: {
  project: string;
  isFavorite?: boolean;
  onToggleFavorite?: (project: string) => void;
  onViewDetails?: (project: string) => void;
  /** Fired after a successful rename/delete so hosts without the task:updated
   *  broadcast in view (the /tasks rail) can refresh their registry copy and
   *  fix a now-stale selection. */
  onChanged?: (kind: 'rename' | 'delete', project: string, newName?: string) => void;
  /** When set, right-clicking the closest ancestor matching this selector opens
   *  this same menu at the cursor (the row is an app object, not a document, so
   *  the browser context menu is replaced — same pattern as TaskKebabMenu). */
  rowSelector?: string;
  /** Class overrides so non-TodoPanel hosts (the /tasks rail, group headers)
   *  can restyle the trigger without a second menu definition. */
  wrapClassName?: string;
  btnClassName?: string;
}) {
  const { open, setOpen, btnRef, menuRef, menuPos, closeMenu, openAtCursor, setCursorAnchor } = useHeaderMenu();
  // Rename/Delete are SHARED with the project right-click menu (see
  // hooks/useProjectActions.ts) — the dialog copy and the local-claim vs
  // provider-claim delete semantics have exactly one definition.
  const { busy, rename, remove } = useProjectActions({ onChanged });

  // Right-click on the owning row opens this kebab menu at the cursor.
  useEffect(() => {
    if (!rowSelector) return;
    const row = btnRef.current?.closest<HTMLElement>(rowSelector);
    if (!row) return;
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Keep the native menu inside text-editing surfaces.
      if (target.isContentEditable || target.closest('input, textarea')) return;
      // Nested/overlapping rows: only the innermost row owns the right-click.
      if (target.closest(rowSelector) !== row) return;
      e.preventDefault();
      openAtCursor(e.clientX, e.clientY);
    };
    row.addEventListener('contextmenu', handleContextMenu);
    return () => row.removeEventListener('contextmenu', handleContextMenu);
    // btnRef is a stable ref; the row is resolved once per selector.
  }, [rowSelector, openAtCursor, btnRef]);

  // Both flows close the menu FIRST: their dialog owns the screen from here, and
  // a menu left open behind a modal reads as two competing surfaces.
  const handleRename = useCallback(() => { closeMenu(); void rename(project); }, [closeMenu, rename, project]);
  const handleDelete = useCallback(() => { closeMenu(); void remove(project); }, [closeMenu, remove, project]);

  return (
    <span className={wrapClassName ?? 'todo-group-action-wrap'} data-menu-open={(open || busy) || undefined}>
      <button
        ref={btnRef}
        className={btnClassName ?? 'todo-group-action-btn'}
        onClick={(e) => { e.stopPropagation(); setCursorAnchor(null); setOpen(!open); }}
        onPointerDown={(e) => e.stopPropagation()}
        title="Project actions"
        aria-label={`Actions for ${project}`}
        aria-expanded={open}
        aria-busy={busy || undefined}
        disabled={busy}
      >
        {busy ? '…' : '⋮'}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="task-kebab-menu"
          style={menuPlacementStyle(menuPos)}
          // Rail rows are dnd-kit sortables — a pointerdown inside the menu
          // bubbles through the portal to the row's PointerSensor and arms a
          // drag. Same guard as TaskKebabMenu.
          onPointerDown={(e) => e.stopPropagation()}
        >
          {onViewDetails && (
            <button
              className="task-kebab-item"
              onClick={(e) => { e.stopPropagation(); closeMenu(); onViewDetails(project); }}
            >
              <span className="task-kebab-icon">{ICONS.ICON_INFO}</span>
              <span>Details</span>
            </button>
          )}
          {onToggleFavorite && (
            <button
              className={`task-kebab-item${isFavorite ? ' task-kebab-item-active' : ''}`}
              onClick={(e) => { e.stopPropagation(); closeMenu(); onToggleFavorite(project); }}
            >
              <span className="task-kebab-icon">{isFavorite ? ICONS.ICON_STAR_FILLED : ICONS.ICON_STAR_EMPTY}</span>
              <span>{isFavorite ? 'Unfavorite' : 'Favorite'}</span>
            </button>
          )}
          <button className="task-kebab-item" onClick={(e) => { e.stopPropagation(); handleRename(); }}>
            <span className="task-kebab-icon">✎</span>
            <span>Rename…</span>
          </button>
          <div className="task-kebab-divider" />
          <button
            className="task-kebab-item task-kebab-item-danger"
            onClick={(e) => { e.stopPropagation(); handleDelete(); }}
          >
            <span className="task-kebab-icon">🗑</span>
            <span>Delete…</span>
          </button>
        </div>,
        document.body,
      )}
    </span>
  );
}
