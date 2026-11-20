import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { useExperimental } from '@/hooks/useExperimental';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import type { DrawingWorkspaceProps } from '@/components/drawing/DrawingWorkspace';
import { OutsidePress } from '@/components/drawing/drawing-overlay';
import { useSessionPaneApps } from '@/components/sessions/SessionPluginAppPane';
import { openSessionApp } from '@/components/sessions/session-app-open';
import { DRAFT_FLUSH_EVENT } from '@/utils/unsaved-work';
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
 *
 * Beside the chat (the bar's button, when the Drawing App can be a session pane) moves the drawing
 * to the session's App view, its tab beside the chat (2026-11-20, the user: "sometime I want to be
 * able to chat while I draw"): the dialog closes and the same drawing opens there.
 *
 * The dialog closes with its × button, Escape outside the editor, or a press that begins and ends
 * outside it (a stroke or a text selection dragged out of it never closes it). Closing unmounts
 * the workspace, whose controller writes the sketch to the tab's store and saves it once more
 * (DrawingSync.dispose); offline, the sketch stays with the draft and the next Draw shows it.
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

/** The Drawing plugin's App (plugin-store/walnut-drawing), as the session pane registry keys it. */
const DRAWING_PANE_APP = 'walnut-drawing:main';

function DrawingAppDialog({ draftId, taskId, sessionId, onClose, onAttach, canAttach }: Omit<Props, 'open'>) {
  const [Workspace, setWorkspace] = useState<WorkspaceModule | null>(null);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const press = useRef(new OutsidePress()).current;
  const previousFocus = useRef(document.activeElement);
  const mounted = useRef(true);
  // The Drawing App when it can open beside a session (Beside the chat).
  const [notHere, setNotHere] = useState(false);
  const [moving, setMoving] = useState(false);
  const paneApp = useSessionPaneApps().find((app) => app.key === DRAWING_PANE_APP) ?? null;
  // A phone has no room beside the chat: the dialog stays its way there.
  const phone = usePhoneLayout();
  // The editor saves what it holds first (a new sketch becomes its file), so the pane opens that
  // same drawing with every stroke, never the one shown before New drawing or an older one.
  const besideChat = async (saveNow: () => Promise<string | null>) => {
    if (!sessionId || moving) return;
    setMoving(true);
    window.dispatchEvent(new Event(DRAFT_FLUSH_EVENT));
    const path = await saveNow().catch(() => null);
    if (!mounted.current) return;
    setMoving(false);
    if (!openSessionApp({ sessionId, appKey: DRAWING_PANE_APP, ...(path ? { documentPath: path } : {}) })) { setNotHere(true); return; }
    onClose();
  };
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
    <div className="drawing-app-overlay" onKeyDown={onKeyDown}
      // The overlay itself is the outside: a press inside a portal of the editor (its menus and
      // modals) reaches here through React with another target, so it counts as inside.
      onPointerDown={(e) => { e.stopPropagation(); press.down(e.target === e.currentTarget); if (e.target === e.currentTarget) e.preventDefault(); }}
      onPointerUp={(e) => { if (press.up(e.target === e.currentTarget)) onClose(); }}
      onPointerCancel={() => press.cancel()}>
      <div ref={dialog} className="drawing-app-dialog" role="dialog" aria-modal="true" aria-label="Drawing" tabIndex={-1}>
        {Workspace
          ? <Workspace draftId={draftId} taskId={taskId} sessionId={sessionId} onClose={onClose} onAttach={onAttach} canAttach={canAttach}
              barExtra={sessionId && paneApp && !phone ? ({ saveNow }) => <>
                {notHere && <span className="drawing-app-beside-note" role="status">Open this session in a column to draw beside its chat</span>}
                <button type="button" className="drawing-quiet-button drawing-app-beside" onClick={() => void besideChat(saveNow)} disabled={moving}
                  title="Open this drawing in a tab beside the chat, so you can chat while you draw">Beside the chat</button>
              </> : undefined} />
          : failed
            ? <div className="drawing-app-loading" role="alert">The drawing editor could not load. <button type="button" onClick={load}>Try again</button> <button type="button" onClick={onClose} aria-label="Close drawing">Close</button></div>
            : <div className="drawing-app-loading" role="status">Loading drawing…</div>}
      </div>
    </div>, document.body,
  );
}
