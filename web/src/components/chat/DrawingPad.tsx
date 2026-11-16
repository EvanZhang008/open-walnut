import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { useExperimental } from '@/hooks/useExperimental';
import type { DrawingWorkspaceProps } from '@/components/drawing/DrawingWorkspace';
import { ClassicDrawingPad, type ClassicDrawingPadProps } from './ClassicDrawingPad';
import './drawing-pad.css';

interface Props extends ClassicDrawingPadProps {
  /** Where Save puts the drawing file (drawing_app on): the composer's task, else its session, else Inbox. */
  taskId?: string;
  sessionId?: string;
}

/**
 * The composer's Draw. With the `drawing_app` experiment off: the small pen, eraser and text pad
 * (ClassicDrawingPad.tsx), as before. On: the drawing workspace (components/drawing/) in a
 * dialog, the same one the Drawing App shows: its sketch is kept in the draft store per draft,
 * Save makes it a drawing file in the task, and Attach PNG adds it to the message. The classic
 * pad stays mounted either way, so a sketch it holds survives the experiment being switched.
 */
export function DrawingPad({ open, draftId, onClose, onAttach, canAttach, taskId, sessionId }: Props) {
  const appOn = useExperimental('drawing_app');
  return <>
    <ClassicDrawingPad open={open && !appOn} draftId={draftId} onClose={onClose} onAttach={onAttach} canAttach={canAttach} />
    {open && appOn && <DrawingAppDialog key={draftId} draftId={draftId} taskId={taskId} sessionId={sessionId} onClose={onClose} onAttach={onAttach} canAttach={canAttach} />}
  </>;
}

type WorkspaceModule = ComponentType<DrawingWorkspaceProps>;
let workspaceModule: Promise<WorkspaceModule> | null = null;
function loadWorkspace(): Promise<WorkspaceModule> {
  workspaceModule ??= import('@/components/drawing/DrawingWorkspace').then((m) => m.DrawingWorkspace).catch((err) => { workspaceModule = null; throw err; });
  return workspaceModule;
}

function DrawingAppDialog({ draftId, taskId, sessionId, onClose, onAttach, canAttach }: Omit<Props, 'open'>) {
  const [Workspace, setWorkspace] = useState<WorkspaceModule | null>(null);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement);
  const mounted = useRef(true);
  const load = () => {
    setFailed(false);
    loadWorkspace().then((W) => { if (mounted.current) setWorkspace(() => W); }).catch(() => { if (mounted.current) setFailed(true); });
  };
  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; }; }, []);
  useModalOverlay(onClose);
  useLayoutEffect(() => {
    dialog.current?.focus();
    return () => {
      const before = previousFocus.current;
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  // Keys stay in the dialog: the composer's shortcuts must not act under it. Esc closes it,
  // except inside the editor, which uses Esc itself (deselect, finish a line, leave a text box).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (e.target instanceof Element && e.target.closest('.excalidraw')) return;
    e.preventDefault();
    onClose();
  };
  return createPortal(
    <div className="drawing-app-overlay" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) e.preventDefault(); }} onKeyDown={onKeyDown}>
      <div ref={dialog} className="drawing-app-dialog" role="dialog" aria-modal="true" aria-label="Drawing" tabIndex={-1}>
        {Workspace
          ? <Workspace draftId={draftId} taskId={taskId} sessionId={sessionId} onClose={onClose} onAttach={onAttach} canAttach={canAttach} />
          : failed
            ? <div className="drawing-app-loading" role="alert">The drawing editor could not load. <button type="button" onClick={load}>Try again</button> <button type="button" onClick={onClose} aria-label="Close drawing">Close</button></div>
            : <div className="drawing-app-loading" role="status">Loading drawing…</div>}
      </div>
    </div>, document.body,
  );
}
