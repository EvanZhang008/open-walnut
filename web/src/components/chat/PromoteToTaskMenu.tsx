/**
 * PromoteToTaskMenu — "Turn this into task" on a single Main Chat message.
 *
 * Why it exists: a chat turn is often where the real work item gets named
 * ("ok so we need to re-key the cache"), and re-typing it into Quick Add loses
 * the wording. This lifts one message straight into a task: first line becomes
 * the title, the whole message becomes the description.
 *
 * Scope: MAIN CHAT ONLY. The button appears when a host passes `onPromote`;
 * the session columns deliberately don't, so their bubbles stay clean.
 *
 * Menu rules followed here (each is a shipped incident — web/src/AGENTS.md):
 *  - Placed by useMenuPlacement (measured, flipped, clamped, capped) and
 *    portalled to <body>. Never hand-rolled math.
 *  - The project list is NOT inlined: it's the shared ProjectPickerFlyout, its
 *    own portal, so this menu's height can't grow after open.
 *  - onPointerDown stopPropagation (portal events still bubble through React's
 *    tree into drag sensors).
 *  - The outside-click closer exempts `.task-kebab-project-flyout` — the child
 *    portal is not inside menuRef.
 *
 * No path/folder picker by design: a task has no working directory of its own
 * (a session picks that later); Project is the only grouping choice here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { ProjectPickerFlyout } from '@/components/tasks/TaskKebabMenu';
import { log } from '@/utils/log';
import { deriveTaskTitle, deriveTaskDescription, type PromoteToTaskInput } from './promote-to-task';

export type { PromoteToTaskInput };

interface Props {
  /** Raw message text (markdown source) being promoted. */
  text: string;
  /** Creates the task. Rejecting leaves the menu open so the user can retry. */
  onPromote: (input: PromoteToTaskInput) => Promise<unknown>;
}

export function PromoteToTaskMenu({ text, onPromote }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [project, setProject] = useState('');
  const [projectOpen, setProjectOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const projectBtnRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // autoFocus leaves the caret at the END, which scrolls a long prefilled title
  // so only its TAIL shows — the user then can't read what they're about to name
  // the task. Park the caret at the start, once per open (not per keystroke).
  useEffect(() => {
    if (!open) return;
    titleRef.current?.setSelectionRange(0, 0);
    titleRef.current?.scrollTo({ left: 0 });
  }, [open]);

  const close = useCallback(() => { setOpen(false); setProjectOpen(false); }, []);
  const placement = useMenuPlacement(open, btnRef, menuRef, {
    minHeight: 200,
    onAnchorLost: close,
  });

  const openMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // Re-derive on every open: the message may have grown since the last one
    // (a streamed turn absorbed into history), and a stale title would lie.
    setTitle(deriveTaskTitle(text));
    setProject('');
    setOpen(true);
  }, [text]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (btnRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      // The project list is a sibling portal, not a child of menuRef.
      if (target.closest?.('.task-kebab-project-flyout')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // One Escape at a time: close the project list first, keep the menu.
      if (projectOpen) { setProjectOpen(false); return; }
      close();
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, projectOpen, close]);

  const submit = useCallback(() => {
    const finalTitle = title.trim() || deriveTaskTitle(text);
    setSubmitting(true);
    onPromote({
      title: finalTitle,
      description: deriveTaskDescription(text, finalTitle),
      ...(project ? { project } : {}),
    })
      .then(() => { setSubmitting(false); close(); })
      .catch((err) => {
        setSubmitting(false);
        // The host surfaces the failure (shared operation-error banner); keep the
        // menu open so the typed title isn't thrown away.
        log.warn('tasks', 'promote chat message to task failed', { error: String(err) });
      });
  }, [title, text, project, onPromote, close]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="msg-copy-btn promote-task-trigger"
        onClick={openMenu}
        title="Turn this message into a task"
        aria-label="Turn this message into a task"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
          <path d="M5.5 8.2l1.8 1.8 3.4-4" />
        </svg>
        <span className="msg-copy-label">Task</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="task-kebab-menu promote-task-menu"
          style={menuPlacementStyle(placement)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="promote-task-heading">Turn this into task</div>
          <input
            className="promote-task-title"
            value={title}
            placeholder="Task title"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !submitting) { e.preventDefault(); submit(); }
            }}
            ref={titleRef}
            autoFocus
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
            <button type="button" className="btn btn-sm" onClick={close} disabled={submitting}>Cancel</button>
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
      )}
    </>
  );
}
