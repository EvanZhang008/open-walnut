/**
 * ProjectHeaderMenus — the two hover actions on a project group header:
 *
 *   ProjectPlusMenu  ("+")  → opens a DRAFT SESSION column in this project
 *   ProjectKebabMenu ("⋮")  → Details / Favorite / Rename… / Delete…
 *
 * The "+" is a DIRECT button, not a menu (R7). It used to drop a two-item menu
 * (Add task / Add session), which cost a click on both branches for no decision
 * the header couldn't already make: "add a task" is already one click away as the
 * ghost row at the bottom of every group, so the header's "+" now means the OTHER
 * thing — start working in this project. The component name/export is unchanged
 * because the ~2 browser specs and the TodoPanel call site address it by name.
 *
 * The kebab still portals to <body> with useMenuPlacement — same pattern (and same
 * .task-kebab-menu styling) as TaskKebabMenu, so it inherits flip/clamp behavior
 * and the theme. The call site gates by group: the kebab is named-projects-only
 * (Inbox has no registry row to rename/delete/detail), and so is the "+" (a
 * session launch seeds the project's default folder, which Inbox cannot have).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useConfirm, useAlert, usePrompt } from '@/hooks/useConfirm';
import { fetchProjectDetail, renameProject, deleteProject } from '@/api/projects';
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

// ── "+" — start a session in this project (ONE click, no menu) ──────────────

export function ProjectPlusMenu({ project, onAddSession }: {
  project: string;
  /** Open a new draft session column seeded with this project (and its default
   *  cwd/host, patched in when the project detail resolves). Omit to render
   *  nothing — a group with no session route has no "+" at all. */
  onAddSession?: (project: string) => void;
}) {
  if (!onAddSession) return null;
  const label = project || 'Inbox';
  return (
    <span className="todo-group-action-wrap">
      <button
        // `-plus` modifier: the "+" is legible AT REST (muted, full on hover) while
        // the kebab stays hover-only. A discoverability call — a control nobody can
        // see until they happen to hover the right row may as well not exist, and
        // "start working here" is the header's primary verb.
        className="todo-group-action-btn todo-group-action-btn-plus"
        onClick={(e) => { e.stopPropagation(); onAddSession(project); }}
        // dnd-kit: the header IS the group's drag handle, so a pointerdown here
        // would otherwise arm a project reorder while the user is just clicking.
        onPointerDown={(e) => e.stopPropagation()}
        title={`New session in ${label}`}
        aria-label={`New session in ${label}`}
      >
        +
      </button>
    </span>
  );
}

// ── "+" — start a session pinned to this tier (R8; same control as above) ────

export function TierPlusButton({ tier, label, onAddSession }: {
  /** Built-in tier name ('focus' | 'satellite' | 'backlog' | 'wait') or a custom
   *  tier id (`ct_*`) — whatever `meta.pinTier` accepts. */
  tier: string;
  /** Human label for the tooltip ("Focus", "Satellite", a custom tier's name). */
  label: string;
  /** Open a draft session column with this tier preset. */
  onAddSession: (tier: string) => void;
}) {
  return (
    <span className="todo-group-action-wrap todo-tier-action-wrap">
      <button
        // Rest-visible like the project "+" — see the note there.
        className="todo-group-action-btn todo-group-action-btn-plus"
        // The tier sublabel is a click-to-collapse row, so BOTH events have to
        // stop here: the click would fold the section, the pointerdown would arm
        // the pinned area's drag sensors.
        onClick={(e) => { e.stopPropagation(); onAddSession(tier); }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        title={`New session in ${label}`}
        aria-label={`New session in ${label}`}
      >
        +
      </button>
    </span>
  );
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
  const confirm = useConfirm();
  const alert = useAlert();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);

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

  const handleRename = useCallback(async () => {
    closeMenu();
    const next = await prompt({
      title: `Rename project “${project}”`,
      message: 'Renaming onto an existing project merges them (case-insensitive).',
      defaultValue: project,
      confirmLabel: 'Rename',
    });
    const target = next?.trim();
    if (!target || target === project) return;
    setBusy(true);
    try {
      await renameProject(project, target);
      // Task rows refresh via the task:updated broadcast; onChanged covers
      // registry-driven hosts (rail selection, project list).
      onChanged?.('rename', project, target);
    } catch (err) {
      await alert({ title: 'Rename failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [project, prompt, alert, closeMenu, onChanged]);

  // Same semantics + copy as ProjectDetailPane.handleDelete: local claim = row
  // drop (tasks → Inbox); provider claim = ?remote=1 CASCADE, which deletes the
  // remote container itself (IRREVERSIBLE), so the confirm spells that out.
  // Source isn't threaded into the header, so fetch the detail lazily here.
  const handleDelete = useCallback(async () => {
    closeMenu();
    setBusy(true);
    let source = 'local';
    let total = 0;
    try {
      const detail = await fetchProjectDetail(project);
      source = detail.source;
      total = detail.counts.todo + detail.counts.active + detail.counts.done;
    } catch (err) {
      // Without the real source we can't pick the right confirm copy — a
      // provider-claimed project shown the harmless local copy would then hit
      // the route's 409 anyway. Abort instead of guessing.
      setBusy(false);
      await alert({ title: 'Delete unavailable', message: `Could not load project info: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    setBusy(false);
    const isClaimed = source !== 'local';
    const ok = await confirm({
      title: `Delete project “${project}”?`,
      message: isClaimed
        ? `This project is synced with ${source}. Deleting it ALSO DELETES the remote container (e.g. the MS To-Do list) — this cannot be undone. Local tasks are kept and move to the Inbox.`
        : `Its ${total} task${total === 1 ? '' : 's'} move to the Inbox (nothing is deleted).`,
      confirmLabel: isClaimed ? 'Delete here + remote' : 'Delete project',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteProject(project, isClaimed ? { remote: true } : undefined);
      onChanged?.('delete', project);
    } catch (err) {
      await alert({ title: 'Delete failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [project, confirm, alert, closeMenu, onChanged]);

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
          <button className="task-kebab-item" onClick={(e) => { e.stopPropagation(); void handleRename(); }}>
            <span className="task-kebab-icon">✎</span>
            <span>Rename…</span>
          </button>
          <div className="task-kebab-divider" />
          <button
            className="task-kebab-item task-kebab-item-danger"
            onClick={(e) => { e.stopPropagation(); void handleDelete(); }}
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
