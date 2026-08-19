/**
 * PromoteTaskPopover — the "Turn this into task" form for a WHOLE Main Chat
 * conversation (opened from the chat header's ⋯ menu).
 *
 * Why it exists: a conversation often becomes the work item ("ok let's actually
 * do this"), and the Main Chat lane IS a Claude Code session — so promoting is
 * just creating a task and linking that session to it. The chat stays where it
 * is; the task gets a session circle that routes BACK to this chat.
 *
 * Menu rules followed here (each is a shipped incident — web/src/AGENTS.md):
 *  - Placed by useMenuPlacement (measured, flipped, clamped, capped) and
 *    portalled to <body>. Never hand-rolled math.
 *  - The project list is NOT inlined: it's the shared ProjectPickerFlyout, its
 *    own portal, so this popover's height can't grow after open.
 *  - onPointerDown stopPropagation (portal events still bubble through React's
 *    tree into drag sensors).
 *  - The outside-click closer exempts `.task-kebab-project-flyout` — the child
 *    portal is not inside menuRef.
 *
 * No path/folder picker by design: the lane session already has its working
 * directory; Project is the only placement choice here.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { ProjectPickerFlyout } from '@/components/tasks/TaskKebabMenu';
import { log } from '@/utils/log';

export interface PromoteToTaskInput {
  title: string;
  /** '' = Inbox. */
  project?: string;
}

interface Props {
  open: boolean;
  /** The element the popover is placed against (the chat header's ⋯ menu wrap). */
  anchorRef: RefObject<HTMLElement | null>;
  /** Prefill — the conversation's auto title. Editable; empty submit falls back to it. */
  defaultTitle: string;
  onClose: () => void;
  /** Creates the task (server links the lane session). Rejecting keeps the popover open. */
  onSubmit: (input: PromoteToTaskInput) => Promise<unknown>;
}

export function PromoteTaskPopover({ open, anchorRef, defaultTitle, onClose, onSubmit }: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [project, setProject] = useState('');
  const [projectOpen, setProjectOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const placement = useMenuPlacement(open, anchorRef, menuRef, {
    minHeight: 200,
    onAnchorLost: onClose,
  });

  // Re-seed the form on every open — the conversation title may have changed
  // since the last time (auto-title lands after the first message).
  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle);
    setProject('');
    setProjectOpen(false);
    setSubmitting(false);
    // autoFocus leaves the caret at the END, which scrolls a long prefilled
    // title so only its TAIL shows. Park the caret at the start, once per open.
    requestAnimationFrame(() => {
      titleRef.current?.focus();
      titleRef.current?.setSelectionRange(0, 0);
      titleRef.current?.scrollTo({ left: 0 });
    });
  }, [open, defaultTitle]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      // The project list is a sibling portal, not a child of menuRef.
      if (target.closest?.('.task-kebab-project-flyout')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // One Escape at a time: close the project list first, keep the popover.
      if (projectOpen) { setProjectOpen(false); return; }
      onClose();
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, projectOpen, onClose, anchorRef]);

  const projectBtnRef = useRef<HTMLButtonElement>(null);

  const submit = useCallback(() => {
    setSubmitting(true);
    onSubmit({
      title: title.trim() || defaultTitle,
      ...(project ? { project } : {}),
    })
      .then(() => { setSubmitting(false); onClose(); })
      .catch((err) => {
        // The host surfaces the failure (shared operation-error banner); keep the
        // popover open so the typed title isn't thrown away.
        setSubmitting(false);
        log.warn('tasks', 'promote chat to task failed', { error: String(err) });
      });
  }, [title, defaultTitle, project, onSubmit, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="task-kebab-menu promote-task-menu"
      style={menuPlacementStyle(placement)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="promote-task-heading">Turn this into task</div>
      <input
        ref={titleRef}
        className="promote-task-title"
        value={title}
        placeholder="Task title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !submitting) { e.preventDefault(); submit(); }
        }}
      />
      <div className="task-kebab-divider" />
      <div className="task-kebab-project">
        <span className="task-kebab-project-label">Project</span>
        <button
          ref={projectBtnRef}
          type="button"
          className={`task-kebab-project-current${projectOpen ? ' open' : ''}`}
          onClick={(e) => { e.stopPropagation(); setProjectOpen((v) => !v); }}
        >
          <span className="task-kebab-project-current-name">{project || 'Inbox'}</span>
          <span className="task-kebab-project-caret">▾</span>
        </button>
      </div>
      <ProjectPickerFlyout
        open={projectOpen}
        anchorRef={projectBtnRef}
        current={project}
        onPick={(name) => setProject(name)}
        onClose={() => setProjectOpen(false)}
      />
      <div className="promote-task-footer">
        <button type="button" className="btn btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
        <button
          type="button"
          className="btn btn-sm btn-primary promote-task-create"
          onClick={submit}
          disabled={submitting}
        >
          {submitting ? 'Creating…' : 'Create task'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
