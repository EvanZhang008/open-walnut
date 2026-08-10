/**
 * ProjectHeaderMenus — the two hover actions on a project group header:
 *
 *   ProjectPlusMenu  ("+")  → Add task (opens the group's ghost row) / Add session (with task)
 *   ProjectKebabMenu ("⋮")  → Details / Favorite / Rename… / Delete…
 *
 * Both portal to <body> with useMenuPlacement — same pattern (and same
 * .task-kebab-menu styling) as TaskKebabMenu, so they inherit flip/clamp
 * behavior and the theme. The call site gates by group: the plus menu renders
 * for every group INCLUDING Inbox ('' — Add task is meaningful there; Add
 * session is omitted since it seeds project defaults), while the kebab is
 * named-projects-only (Inbox has no registry row to rename/delete/detail).
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useConfirm, useAlert, usePrompt } from '@/hooks/useConfirm';
import { fetchProjectDetail, renameProject, deleteProject } from '@/api/projects';
import * as ICONS from '../common/Icons';

/** Shared open/close + placement shell for one trigger button and its menu. */
function useHeaderMenu() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  const menuPos = useMenuPlacement(open, btnRef, menuRef, { onAnchorLost: closeMenu });

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
  }, [open, closeMenu]);

  return { open, setOpen, btnRef, menuRef, menuPos, closeMenu };
}

// ── "+" — quick create inside this project ──────────────────────────────────

export function ProjectPlusMenu({ project, onAddTask, onAddSession }: {
  /** '' = Inbox (Add-task-only). */
  project: string;
  /** Open the group's inline ghost add row and focus its input. */
  onAddTask: (project: string) => void;
  /** Open the session launcher seeded with this project (default cwd/host). */
  onAddSession?: (project: string) => void;
}) {
  const { open, setOpen, btnRef, menuRef, menuPos, closeMenu } = useHeaderMenu();
  const label = project || 'Inbox';
  return (
    <span className="todo-group-action-wrap" data-menu-open={open || undefined}>
      <button
        ref={btnRef}
        className="todo-group-action-btn"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        title={`Add to ${label}…`}
        aria-label={`Add to ${label}`}
        aria-expanded={open}
      >
        +
      </button>
      {open && createPortal(
        <div ref={menuRef} className="task-kebab-menu" style={menuPlacementStyle(menuPos)}>
          <button
            className="task-kebab-item"
            onClick={(e) => { e.stopPropagation(); closeMenu(); onAddTask(project); }}
          >
            <span className="task-kebab-icon">{ICONS.ICON_PHASE_TODO}</span>
            <span>Add task</span>
          </button>
          {onAddSession && (
            <button
              className="task-kebab-item"
              onClick={(e) => { e.stopPropagation(); closeMenu(); onAddSession(project); }}
            >
              <span className="task-kebab-icon">▷</span>
              <span>Add session (with task)</span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}

// ── "⋮" — project management ────────────────────────────────────────────────

export function ProjectKebabMenu({ project, isFavorite, onToggleFavorite, onViewDetails }: {
  project: string;
  isFavorite?: boolean;
  onToggleFavorite?: (project: string) => void;
  onViewDetails: (project: string) => void;
}) {
  const { open, setOpen, btnRef, menuRef, menuPos, closeMenu } = useHeaderMenu();
  const confirm = useConfirm();
  const alert = useAlert();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);

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
      // Task rows refresh via the task:updated broadcast; nothing to do here.
    } catch (err) {
      await alert({ title: 'Rename failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [project, prompt, alert, closeMenu]);

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
    } catch (err) {
      await alert({ title: 'Delete failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, [project, confirm, alert, closeMenu]);

  return (
    <span className="todo-group-action-wrap" data-menu-open={(open || busy) || undefined}>
      <button
        ref={btnRef}
        className="todo-group-action-btn"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        title="Project actions"
        aria-label={`Actions for ${project}`}
        aria-expanded={open}
        aria-busy={busy || undefined}
        disabled={busy}
      >
        {busy ? '…' : '⋮'}
      </button>
      {open && createPortal(
        <div ref={menuRef} className="task-kebab-menu" style={menuPlacementStyle(menuPos)}>
          <button
            className="task-kebab-item"
            onClick={(e) => { e.stopPropagation(); closeMenu(); onViewDetails(project); }}
          >
            <span className="task-kebab-icon">{ICONS.ICON_INFO}</span>
            <span>Details</span>
          </button>
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
