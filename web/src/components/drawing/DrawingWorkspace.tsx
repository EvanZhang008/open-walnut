/**
 * Walnut's drawing workspace: the list of a task's (or session's, or Inbox's) drawings, the
 * editor, saving, export and attach. One component for every place a drawing opens: the Drawing
 * App's page and its session pane (through `walnut.ui.views.DrawingView`, plugins/views.tsx), a
 * note's attachment preview, and the composer's Draw dialog (DrawingPad.tsx, with `draftId`).
 *
 * Saving and conflicts live in DrawingSync (drawing-sync.ts); this file is the screen. The editor
 * is loaded with a plain dynamic import (ExcalidrawCanvas.tsx), so this module stays small.
 *
 * Every place gets the same chrome: a quiet header (the list, the name, which a click edits, the
 * save state, full screen, close), export and the diagram actions in the editor's own menu, and,
 * in the composer, one Attach PNG. Full screen is this element covering the window
 * (drawing-overlay.ts): the editor is never mounted again, so its view and selection stay.
 * "New drawing" is a sketch until its first content (no empty files).
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useDraft } from '@/hooks/useDraft';
import { MicField, MicInput, type BoxMicHandle } from '@/components/common/BoxMic';
import { dictationWaitProps, useSendAfterDictation } from '@/hooks/useSendAfterDictation';
import { draftKey } from '@/utils/drafts';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { DRAFT_FLUSH_EVENT } from '@/utils/unsaved-work';
import { timeAgo } from '@/utils/time';
import { isBoolean, usePageView, usePageViewOf } from '@/utils/view-memory';
import { DrawingConflictError, drawingApi, drawingErrorMessage, requestDiagram, type DrawingApi } from './drawing-api';
import { exportFileName, sceneElementCount, sceneHasContent, sceneText, type DrawingListItem, type DrawingScene } from './drawing-scene';
import { DrawingSync, NOT_SAVED_YET, hasUnsavedSketch, newSketchKey, sketchDraftKey, type DrawingSnapshot, type DrawingSource } from './drawing-sync';
import { tabDrawingStore } from './drawing-store';
import { addCatalogLibrary, tabLibrary } from './drawing-library';
import { isFullscreenShortcut, liftFixedAncestors } from './drawing-overlay';
import { LibraryBrowser } from './LibraryBrowser';
import { workspacePlace, workspaceViewKeys } from './workspace-place';
import { drawingAssistantAsk, followDrawingRename } from './drawing-assistant-context';
import type { DrawingAssistantRequest } from './DrawingAssistant';
import type { CanvasMenu, DrawingCanvasHandle, ExcalidrawCanvasProps } from './ExcalidrawCanvas';

// The chat (SessionPanel and its composer) loads only when the assistant is opened.
const DrawingAssistant = lazy(() => import('./DrawingAssistant'));
import { usePageTheme } from './usePageTheme';
import './drawing-workspace.css';

export interface DrawingWorkspaceState {
  path: string;
  title: string;
  revision: string;
  text: string;
  elementCount: number;
  unsaved: boolean;
}

export interface DrawingWorkspaceProps {
  taskId?: string;
  sessionId?: string;
  /** The drawing to open. */
  documentPath?: string;
  /** A composer's draft id: its sketch is kept with the draft until it is saved or attached. */
  draftId?: string;
  /** A note's attachment preview: its own view choices, never full screen at start (workspace-place.ts). */
  preview?: boolean;
  onClose?(): void;
  /** Add the drawing as a picture to a message; resolve with a notice when it was not added. */
  onAttach?(file: File): Promise<string | null>;
  canAttach?: boolean;
  /** What is open, for an agent beside it (debounced; only for a drawing file). */
  onState?(state: DrawingWorkspaceState): void;
  /** The file shown changed (another picked, a sketch saved as a file). */
  onDocumentPathChange?(path: string | null): void;
  /** Tests pass their own server. */
  api?: DrawingApi;
}

const draftStore = tabDrawingStore;
const isText = (v: unknown): v is string => typeof v === 'string';
const POLL_MS = 5_000;
const LIST_POLL_MS = 30_000;
const STATE_DELAY_MS = 600;

type CanvasModule = ComponentType<ExcalidrawCanvasProps>;
let canvasModule: Promise<CanvasModule> | null = null;
function loadCanvas(): Promise<CanvasModule> {
  canvasModule ??= import('./ExcalidrawCanvas').then((m) => m.default).catch((err) => { canvasModule = null; throw err; });
  return canvasModule;
}

function sourceId(source: DrawingSource | null): string {
  return !source ? '' : source.kind === 'file' ? `file:${source.path}` : `sketch:${source.key}:${source.open ?? ''}:${source.fresh ?? ''}`;
}

/** One icon size and stroke for the whole chrome. */
function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}
const ICON = {
  list: 'M4 5h16v14H4zM9 5v14',
  enter: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  exit: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  assistant: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z',
};

/** The field a name is edited in: Enter or leaving it saves, Escape leaves the name as it was. */
function NameField({ value, label, className, onCommit, onDone }: {
  value: string; label: string; className: string;
  onCommit(name: string): Promise<string | null>;
  /** Editing ended; `failure` says why the name did not change. */
  onDone(failure: string | null): void;
}) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const commit = async () => {
    if (done.current) return;
    done.current = true;
    const name = draft.replace(/\s+/g, ' ').trim();
    onDone(!name || name === value ? null : await onCommit(name));
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    // The dialog and full screen under the field never see these keys.
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); void commit(); }
    if (e.key === 'Escape') { e.preventDefault(); done.current = true; onDone(null); }
  };
  // A name is words: the mic too. Its wrapper takes the field's place in the row (`className`).
  return <MicInput fieldClassName={`${className} drawing-name-field`} className="drawing-name-input" aria-label={label} value={draft} setText={setDraft}
    maxLength={120} autoFocus data-no-draft="rename" onFocus={(e) => e.currentTarget.select()} onKeyDown={onKeyDown} onBlur={() => void commit()} />;
}

/** One drawing in the list: open it, or rename it (the pencil, or a double click). */
function FileRow({ item, current, onOpen, onRename }: {
  item: DrawingListItem; current: boolean;
  onOpen(): void;
  onRename(name: string): Promise<string | null>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <li className="drawing-workspace-file-row" aria-current={current ? 'true' : undefined}>
      {renaming
        ? <NameField value={item.title} label={`New name for ${item.title}`} className="drawing-workspace-file-input" onCommit={onRename}
            onDone={(f) => { setRenaming(false); setFailure(f); }} />
        : <>
            <button type="button" className="drawing-workspace-file" aria-current={current ? 'true' : undefined} onClick={onOpen}
              onDoubleClick={() => { setFailure(null); setRenaming(true); }} title={item.path}>
              <span className="drawing-workspace-file-title">{item.title}</span>
              {item.updatedAt && <span className="drawing-workspace-file-time">{timeAgo(item.updatedAt)}</span>}
            </button>
            <button type="button" className="drawing-icon-button drawing-workspace-file-rename" aria-label={`Rename ${item.title}`} title="Rename"
              onClick={() => { setFailure(null); setRenaming(true); }}><Icon d={ICON.pencil} /></button>
          </>}
      {failure && <span className="drawing-name-error" role="alert">{failure}</span>}
    </li>
  );
}

type DiagramRun =
  | { phase: 'running'; abort: AbortController }
  | { phase: 'error'; message: string; retry: () => void };

/** On screen for the person: polling stops for a hidden tab, a closed pane, Home behind a page. */
function onScreen(el: HTMLElement | null): boolean {
  if (!el || document.visibilityState !== 'visible') return false;
  return el.getClientRects().length > 0 && !el.closest('.main-page-wrapper-hidden');
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const STATUS_TEXT: Record<DrawingSnapshot['state'], string> = {
  loading: 'Opening…',
  sketch: 'Saved to Notes when you draw',
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  offline: 'Not saved, retrying',
  conflict: 'Changed elsewhere',
  missing: 'File not found',
  error: 'Could not open',
};

export function DrawingWorkspace(props: DrawingWorkspaceProps) {
  const { taskId, sessionId, documentPath, draftId, preview, onClose, onAttach, canAttach = true, onState, onDocumentPathChange } = props;
  const api = props.api ?? drawingApi;
  const scope = useMemo(() => ({ ...(taskId ? { taskId } : {}), ...(sessionId ? { sessionId } : {}) }), [taskId, sessionId]);
  const scopeId = taskId ? `task:${taskId}` : sessionId ? `session:${sessionId}` : 'inbox';
  const sketchKey = draftId ? sketchDraftKey(draftId) : null;

  // The file this place showed last (the App's page, a pane without a document of its own).
  const [lastDocument, setLastDocument] = usePageViewOf<string>('drawing', 'lastDocument', scopeId, '', isText);
  // Each place keeps its own choices (workspace-place.ts); a note's preview shares none with the App page.
  const view = workspaceViewKeys(workspacePlace({ draftId, sessionId, hasClose: Boolean(onClose), preview }));
  // The assistant chat lives in the App's page only (workspace-place.ts `assistantKey`).
  const [assistantKept, setAssistantShown] = usePageView<boolean>('drawing', view.assistantKey ?? 'assistantUnkept', false, isBoolean);
  // Make a diagram / Text to diagram handed to the assistant (a message, not a view choice).
  const [assistantRequest, setAssistantRequest] = useState<DrawingAssistantRequest | null>(null);
  const assistantAsks = useRef(0);
  const textAskId = useRef<number | null>(null);
  const [filesShown, setFilesShown] = usePageView<boolean>('drawing', view.filesKey, view.filesDefault, isBoolean);
  const [keptFullScreen, setKeptFullScreen] = usePageView<boolean>('drawing', view.fullScreenKey ?? 'fullScreenUnkept', false, isBoolean);
  const [previewFullScreen, setPreviewFullScreen] = useState(false);
  const [fullScreen, setFullScreen] = view.fullScreenKey ? [keptFullScreen, setKeptFullScreen] : [previewFullScreen, setPreviewFullScreen];
  // Where "New drawing" sketches here: the composer's draft, else this place's own key.
  const newKey = sketchKey ?? newSketchKey(scopeId);

  const firstSource = (): DrawingSource | null => {
    if (documentPath) return { kind: 'file', path: documentPath };
    if (sketchKey) return { kind: 'sketch', key: sketchKey };
    // A new drawing not in Notes yet (a reload while offline) comes back first.
    if (hasUnsavedSketch(draftStore, newKey)) return { kind: 'sketch', key: newKey };
    return lastDocument ? { kind: 'file', path: lastDocument } : null;
  };
  const [source, setSource] = useState<DrawingSource | null>(firstSource);
  const [snap, setSnap] = useState<DrawingSnapshot | null>(null);
  const sync = useRef<DrawingSync | null>(null);
  const canvas = useRef<DrawingCanvasHandle | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [Canvas, setCanvas] = useState<CanvasModule | null>(null);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [list, setList] = useState<DrawingListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'new' | 'attach' | 'png' | 'svg' | 'copy'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
  const [textDialogOpen, setTextDialogOpen] = useState(false);
  // The description typed for Text to diagram is kept like any unsent words, per place.
  const diagramText = useDraft(draftKey('drawing-diagram', scopeId));
  const diagramBox = useRef<HTMLTextAreaElement | null>(null);
  const diagramMic = useRef<BoxMicHandle | null>(null);
  const [diagram, setDiagram] = useState<DiagramRun | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const diagramRun = useRef<AbortController | null>(null);
  const theme = usePageTheme();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; diagramRun.current?.abort(); }; }, []);

  // A host that names another document (the pane's remembered one, a link) opens it. The one
  // already shown (a sketch that became this file, a rename) stays as it is, and so does the
  // echo of a path this workspace reported itself (onDocumentPathChange, written into the App's
  // address a moment later): by then the person may have started a New drawing, which it must
  // not take back.
  const previousPath = useRef(documentPath);
  const reportedPath = useRef<string | null>(null);
  useEffect(() => {
    if (documentPath === previousPath.current) return;
    previousPath.current = documentPath;
    if (!documentPath || sync.current?.snapshot().path === documentPath || documentPath === reportedPath.current) return;
    setSource((s) => (s?.kind === 'file' && s.path === documentPath ? s : { kind: 'file', path: documentPath }));
  }, [documentPath]);

  // Full screen: this element covers the window; the ancestors that would hold it in their box
  // let go meanwhile. The editor measures its box again once it moved.
  useEffect(() => {
    const el = root.current;
    if (!fullScreen || !el) return undefined;
    const undo = liftFixedAncestors(el);
    const frame = requestAnimationFrame(() => canvas.current?.refresh());
    return () => {
      cancelAnimationFrame(frame);
      undo();
      requestAnimationFrame(() => canvas.current?.refresh());
    };
  }, [fullScreen]);

  // One controller per source. Its answers stop with dispose(), so a slow save of the file left
  // behind never reaches the one shown now.
  const id = sourceId(source);
  useEffect(() => {
    if (!source) { setSnap(null); return undefined; }
    const controller = new DrawingSync(source, {
      api, store: draftStore, scope,
      onChange: (s) => { if (sync.current === controller) setSnap(s); },
      // A name taken from the first line waits until its text box is closed.
      canAutoRename: () => !canvas.current?.isEditingText(),
    });
    sync.current = controller;
    setSnap(controller.snapshot());
    setNotice(null);
    void controller.start();
    const flush = () => controller.flushDraft();
    window.addEventListener(DRAFT_FLUSH_EVENT, flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener(DRAFT_FLUSH_EVENT, flush);
      window.removeEventListener('pagehide', flush);
      if (sync.current === controller) sync.current = null;
      controller.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one controller per source id
  }, [id]);

  // The file shown (a sketch becomes one with its first content): remembered for this place, and
  // told to the host so its pane opens the same one next time.
  const shownPath = snap?.path ?? null;
  const reportPath = useRef(onDocumentPathChange);
  reportPath.current = onDocumentPathChange;
  useEffect(() => {
    if (!shownPath) return;
    if (view.keepsLastDocument) setLastDocument(shownPath);
    reportedPath.current = shownPath;
    reportPath.current?.(shownPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per file shown
  }, [shownPath]);

  // The editor, on first use.
  const loadEditor = useLeanCallback(() => {
    setCanvasError(null);
    loadCanvas().then((C) => { if (mounted.current) setCanvas(() => C); }).catch((err) => {
      log.warn('drawing', 'the drawing editor could not load', { error: String(err) });
      if (mounted.current) setCanvasError('The drawing editor could not load. Check the connection and try again.');
    });
  }, []);
  useEffect(() => { loadEditor(); }, [loadEditor]);

  // The list of this place's drawings.
  const refreshList = useLeanCallback(() => {
    api.list(scope).then((rows) => {
      if (!mounted.current) return;
      setList(rows);
      setListError(null);
    }).catch((err) => { if (mounted.current) setListError(drawingErrorMessage(err)); });
  }, [api, scope]);
  useEffect(() => { refreshList(); }, [refreshList]);
  const savedRevision = snap?.state === 'saved' ? snap.revision : null;
  useEffect(() => { if (savedRevision) refreshList(); }, [savedRevision, refreshList]);

  // A change made elsewhere (an agent's append) shows while the drawing is on screen and clean.
  useEffect(() => {
    const tick = () => { if (onScreen(root.current)) void sync.current?.refresh(); };
    const listTick = () => { if (onScreen(root.current)) refreshList(); };
    const poll = window.setInterval(tick, POLL_MS);
    const listPoll = window.setInterval(listTick, LIST_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(listPoll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tick);
    };
  }, [refreshList]);

  // The same drawing under a new path (one controller, renamed here, elsewhere or by Walnut): its
  // assistant conversation follows it. Another drawing opened is another controller.
  const shownPathOf = useRef<{ controller: DrawingSync | null; path: string | null }>({ controller: null, path: null });
  useEffect(() => {
    const path = snap?.path ?? null;
    const controller = sync.current;
    const before = shownPathOf.current;
    if (controller && before.controller === controller && before.path && path && before.path !== path) {
      followDrawingRename(before.path, path);
      const from = before.path;
      setAssistantRequest((ask) => (ask?.path === from ? { ...ask, path } : ask));
    } else if (before.controller !== controller) setAssistantRequest(null);
    shownPathOf.current = { controller, path };
  }, [snap?.path]);

  // The server says this drawing changed (an agent's edit): take it now, not at the next poll.
  // The callback is read fresh on every event, so it always compares against the shown revision.
  useEvent('drawings:updated', (data: unknown) => {
    const change = data as { path?: unknown; revision?: unknown; from?: unknown } | null;
    if (!change) return;
    // Renamed elsewhere: follow the file to its new name.
    if (typeof change.from === 'string' && typeof change.path === 'string' && change.from === snap?.path) {
      sync.current?.followMove(change.from, change.path);
      refreshList();
      return;
    }
    if (change.path !== snap?.path || change.revision === snap?.revision) return;
    void sync.current?.refresh();
  });
  useEvent('drawings:library-updated', (data: unknown) => {
    tabLibrary.remoteUpdated((data as { revision?: unknown } | null)?.revision);
  });

  // What an agent beside the drawing reads: debounced, and only when it changed.
  const lastState = useRef('');
  useEffect(() => {
    if (!onState || !snap?.path || !snap.scene || !snap.revision) return undefined;
    const state: DrawingWorkspaceState = {
      path: snap.path, title: snap.title, revision: snap.revision,
      text: sceneText(snap.scene), elementCount: sceneElementCount(snap.scene), unsaved: snap.unsaved,
    };
    const timer = window.setTimeout(() => {
      const json = JSON.stringify(state);
      if (json === lastState.current) return;
      lastState.current = json;
      onState(state);
    }, STATE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [onState, snap?.path, snap?.title, snap?.revision, snap?.scene, snap?.unsaved]);

  /**
   * The composer's Draw has one draft key: a sketch not in Notes yet must reach it before another
   * drawing opens there, or it would be written over. Saves it now; still unsaved (offline), it
   * stays open and says so.
   */
  const canLeave = async (): Promise<boolean> => {
    const controller = sync.current;
    if (!controller || controller.source.kind !== 'sketch' || !controller.snapshot().unsaved) return true;
    await controller.save();
    if (!mounted.current || sync.current !== controller) return false;
    if (!controller.snapshot().unsaved) return true;
    setNotice('This drawing is not in Notes yet, so it stays open here. Open another one once it is saved.');
    return false;
  };

  const openFile = async (path: string) => {
    if (snap?.path === path || !(await canLeave())) return;
    // The composer's Draw keeps its draft's controller: it switches the draft to that file.
    setSource(sketchKey ? { kind: 'sketch', key: sketchKey, open: path } : { kind: 'file', path });
  };

  /** A new sketch: its file is made in this place with its first content (no empty files). */
  const createNew = async () => {
    if (busy) return;
    setBusy('new');
    setNotice(null);
    try {
      if (!(await canLeave()) || !mounted.current) return;
      setSource({ kind: 'sketch', key: newKey, fresh: Date.now() });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  /** Rename a drawing: the open one through its controller (saved first), another one directly. */
  const renameDrawing = async (path: string, title: string): Promise<string | null> => {
    const controller = sync.current;
    if (controller && controller.snapshot().path === path) {
      const failure = await controller.rename(title);
      if (!failure) refreshList();
      return failure;
    }
    try {
      const doc = await api.get(path);
      if (!doc) return null;
      try {
        await api.rename(path, doc.revision, title);
      } catch (err) {
        // Changed a moment ago: once more on what is there now, never in a loop.
        if (!(err instanceof DrawingConflictError)) throw err;
        await api.rename(path, err.current.revision, title);
      }
      refreshList();
      return null;
    } catch (err) {
      return `Not renamed: ${drawingErrorMessage(err)}`;
    }
  };

  /** "Make a diagram" (from the selection, or the whole drawing) and "Text to diagram". */
  // Make diagram (or Cmd+Enter) while the mic records waits for the final words, then runs once.
  const textGate = useSendAfterDictation([diagramMic], () => {
    if (diagramText.text.trim() && diagram?.phase !== 'running') void makeDiagram('text', diagramText.text);
  }, diagramText.key);
  const makeDiagram = async (mode: 'tidy' | 'text', prompt = '') => {
    const handle = canvas.current;
    if (!handle) return;
    const input = mode === 'tidy' ? handle.diagramInput() : null;
    if (input && !input.elements.length) {
      setDiagram({ phase: 'error', message: 'Draw something first, or select what to turn into a diagram.', retry: () => void makeDiagram(mode, prompt) });
      return;
    }
    // In the App page the drawing's assistant does it, in its own session the person can read.
    if (canAssist && currentPath) {
      // The agent reads the file: it must hold what is on the canvas first.
      const saved = await sync.current?.saveAll();
      if (!mounted.current || canvas.current !== handle) return;
      if (!saved) { setDiagram({ phase: 'error', message: NOT_SAVED_YET, retry: () => void makeDiagram(mode, prompt) }); return; }
      const text = drawingAssistantAsk(input
        ? { kind: 'tidy', selectedIds: input.selected ? input.elements.map((el) => String(el.id)) : null }
        : { kind: 'text', prompt });
      setAssistantShown(true);
      assistantAsks.current += 1;
      // Text to diagram keeps its words until the assistant has them.
      textAskId.current = mode === 'text' ? assistantAsks.current : null;
      setAssistantRequest({ id: assistantAsks.current, text, path: sync.current?.snapshot().path ?? currentPath });
      return;
    }
    diagramRun.current?.abort();
    const abort = new AbortController();
    diagramRun.current = abort;
    setDiagram({ phase: 'running', abort });
    try {
      const answer = await requestDiagram({
        mode,
        ...(input ? { elements: input.elements, ...(Object.keys(input.files).length ? { files: input.files } : {}) } : { prompt: prompt.slice(0, 4_000) }),
        ...scope,
      }, abort.signal);
      // Cancelled, closed, or another drawing opened meanwhile: nothing is added.
      if (abort.signal.aborted || !mounted.current || canvas.current !== handle) return;
      handle.applyDiagram(answer.elements, input ? input.bounds : null);
      // The keys go back to the editor: the button pressed is gone, and Undo must reach the editor.
      handle.focus();
      setDiagram(null);
      if (mode === 'text') { setTextDialogOpen(false); diagramText.clear(); }
    } catch (err) {
      if (abort.signal.aborted || !mounted.current) return;
      log.warn('drawing', 'a diagram could not be made', { mode, error: String(err) });
      setDiagram({ phase: 'error', message: `No diagram was made: ${drawingErrorMessage(err)}`, retry: () => void makeDiagram(mode, prompt) });
    } finally {
      if (diagramRun.current === abort) diagramRun.current = null;
    }
  };
  const cancelDiagram = () => {
    diagramRun.current?.abort();
    diagramRun.current = null;
    setDiagram(null);
  };

  const addLibrarySource = (source: string) => {
    addCatalogLibrary(source).then(() => canvas.current?.openLibrary()).catch((err) => {
      if (mounted.current) setNotice(`The library was not added: ${drawingErrorMessage(err)}`);
    });
  };

  const menu: CanvasMenu = {
    onDownload: (kind) => void exportAs(kind),
    onMakeDiagram: () => void makeDiagram('tidy'),
    onTextToDiagram: () => setTextDialogOpen(true),
  };

  /** Ctrl/Cmd+Shift+F toggles full screen; Escape outside the editor leaves it. The editor keeps its own Escape. */
  const onKeyDownCapture = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isFullscreenShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      setFullScreen((v) => !v);
    }
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !fullScreen || e.defaultPrevented || e.nativeEvent.isComposing) return;
    if (e.target instanceof Element && e.target.closest('.excalidraw, input, textarea')) return;
    e.preventDefault();
    e.stopPropagation();
    setFullScreen(false);
  };

  const saveCopy = async () => {
    const controller = sync.current;
    if (!controller || busy) return;
    setBusy('copy');
    try {
      const path = await controller.saveAsCopy();
      if (!path || !mounted.current || sync.current !== controller) return;
      refreshList();
      openFile(path);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const exportAs = async (kind: 'png' | 'svg') => {
    const handle = canvas.current;
    if (!handle || busy) return;
    setBusy(kind);
    setNotice(null);
    try {
      if (!sceneHasContent(snap?.scene)) { setNotice('Draw something first: an empty drawing has nothing to download.'); return; }
      const blob = kind === 'png' ? await handle.exportPng() : await handle.exportSvg();
      download(blob, exportFileName(snap?.title || 'drawing', kind));
    } catch (err) {
      log.warn('drawing', 'export failed', { kind, error: String(err) });
      if (mounted.current) setNotice(`The ${kind.toUpperCase()} could not be made: ${drawingErrorMessage(err)}`);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const attach = async () => {
    const handle = canvas.current;
    const controller = sync.current;
    if (!handle || !controller || !onAttach || busy || !canAttach) return;
    setBusy('attach');
    setNotice(null);
    try {
      const blob = await handle.exportPng();
      const name = `${exportFileName(snap?.path && snap.title ? snap.title : 'drawing', 'png').replace(/\.png$/, '')}-${Date.now()}.png`;
      const result = await onAttach(new File([blob], name, { type: 'image/png' }));
      // Closed, or another draft opened, while it attached: the new one is left as it is.
      if (!mounted.current || sync.current !== controller) return;
      if (result) { setNotice(result); return; }
      // The composer's next Draw starts a new sketch; the file stays in Notes.
      await controller.releaseComposerDraft();
      if (!mounted.current) return;
      onClose?.();
    } catch (err) {
      if (mounted.current && sync.current === controller) setNotice(`The drawing could not be attached: ${drawingErrorMessage(err)}`);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const close = () => {
    sync.current?.flushDraft();
    void sync.current?.save();
    onClose?.();
  };

  const state = snap?.state ?? null;
  // The editor shows only the snapshot of the source picked now: in the render that switches
  // source (New drawing, another file), `snap` is still the old one's until its controller starts,
  // and an editor mounted with it would hand the old shapes to the new sketch as its content.
  const shown = snap && sourceId(snap.source) === id ? snap : null;
  const hasScene = sceneHasContent(snap?.scene);
  const conflict = snap?.conflict ?? null;
  // Kept in the draft store, a reload brings it back; marked only when the store refused it.
  const lost = !!snap && snap.unsaved && !snap.kept;
  const title = snap?.path ? snap.title || 'Drawing' : snap?.source.kind === 'sketch' && state !== 'loading' ? 'New drawing' : state === 'loading' ? 'Opening…' : 'Drawing';
  const currentPath = shownPath;

  const canRename = !!currentPath && state !== 'loading' && state !== 'missing' && state !== 'error';
  const canAssist = view.assistantKey !== null && !!currentPath;
  const assistantShown = canAssist && assistantKept;
  // A closed panel takes no ask: one left from before never lands on the next drawing it opens on.
  useEffect(() => { if (!assistantShown) setAssistantRequest(null); }, [assistantShown]);

  return (
    <div ref={root} className="drawing-workspace" data-files-shown={filesShown ? 'true' : 'false'} data-theme-resolved={theme}
      data-fullscreen={fullScreen ? 'true' : 'false'} onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown}
      data-drawing-path={currentPath ?? undefined} data-drawing-revision={snap?.revision ?? undefined} data-save-state={state ?? 'none'}>
      {lost && <span hidden data-walnut-unsaved="A drawing that is not saved" />}
      {filesShown && (
        <aside className="drawing-workspace-files" aria-label="Drawings">
          <div className="drawing-workspace-files-head">
            <span>Drawings</span>
            <button type="button" className="drawing-quiet-button drawing-workspace-new" onClick={() => void createNew()} disabled={!!busy}>
              <Icon d={ICON.plus} /><span>New drawing</span>
            </button>
          </div>
          {listError && <p className="drawing-workspace-files-note" role="alert">{listError}</p>}
          {list && list.length === 0 && !listError && <p className="drawing-workspace-files-note">No drawings here yet</p>}
          {list === null && !listError && <p className="drawing-workspace-files-note">Loading…</p>}
          {list && list.length > 0 && (
            <ul className="drawing-workspace-file-list">
              {list.map((item) => (
                <FileRow key={item.path} item={item} current={item.path === currentPath}
                  onOpen={() => void openFile(item.path)} onRename={(name) => renameDrawing(item.path, name)} />
              ))}
            </ul>
          )}
        </aside>
      )}
      <section className="drawing-workspace-main" aria-label={title}>
        <header className="drawing-workspace-bar">
          <button type="button" className="drawing-icon-button drawing-workspace-files-toggle" aria-expanded={filesShown} aria-label={filesShown ? 'Hide drawings list' : 'Show drawings list'} title={filesShown ? 'Hide drawings list' : 'Show drawings list'} onClick={() => setFilesShown((v) => !v)}><Icon d={ICON.list} /></button>
          {titleEditing && currentPath
            ? <NameField value={title} label="Drawing name" className="drawing-workspace-title" onCommit={(name) => renameDrawing(currentPath, name)}
                onDone={(failure) => { setTitleEditing(false); setNotice(failure); }} />
            : <h2 className="drawing-workspace-title" title={currentPath ?? undefined}>
                {canRename
                  ? <button type="button" className="drawing-name-button" aria-label={`Rename drawing: ${title}`} title="Click to rename" onClick={() => setTitleEditing(true)}>{title}</button>
                  : title}
              </h2>}
          {state && <span className="drawing-workspace-status" data-state={state} role="status" aria-live="polite">{STATUS_TEXT[state]}</span>}
          <span className="drawing-workspace-bar-gap" />
          {onAttach && <button type="button" className="drawing-primary-button drawing-workspace-attach" onClick={() => void attach()} disabled={!!busy || !hasScene || !canAttach || !Canvas} title={canAttach ? 'Add this drawing to your message as a picture' : 'Attachment limit reached'}>{busy === 'attach' ? 'Attaching…' : 'Attach PNG'}</button>}
          {canAssist && (
            <button type="button" className="drawing-quiet-button drawing-workspace-assistant-toggle" aria-pressed={assistantShown}
              title={assistantShown ? 'Hide the assistant' : 'Ask the assistant to change this drawing'}
              onClick={() => setAssistantShown(!assistantShown)}><Icon d={ICON.assistant} /><span>Assistant</span></button>
          )}
          <button type="button" className="drawing-icon-button drawing-workspace-fullscreen" aria-pressed={fullScreen}
            aria-label={fullScreen ? 'Exit full screen' : 'Full screen'} title={`${fullScreen ? 'Exit full screen' : 'Full screen'} (${/Mac/.test(globalThis.navigator?.platform ?? '') ? '\u2318\u21e7F' : 'Ctrl+Shift+F'})`}
            // The keys go back to the editor (its tool shortcuts), not to this button.
            onClick={() => { setFullScreen((v) => !v); requestAnimationFrame(() => canvas.current?.focus()); }}><Icon d={fullScreen ? ICON.exit : ICON.enter} /></button>
          {onClose && <button type="button" className="drawing-icon-button drawing-workspace-close" onClick={close} aria-label="Close drawing" title="Close"><Icon d={ICON.close} /></button>}
        </header>
        {conflict && (
          <div className="drawing-workspace-conflict" role="alert">
            <span>{snap!.conflictShapes > 0
              ? `${snap!.conflictShapes === 1 ? 'One shape was' : `${snap!.conflictShapes} shapes were`} changed both here and somewhere else. Every other change, from both sides, is kept.`
              : 'This drawing was changed somewhere else while you were editing. Your edits are kept here until you choose.'}</span>
            <button type="button" className="drawing-quiet-button" onClick={() => void sync.current?.keepMine()} disabled={!!busy}>Keep mine</button>
            <button type="button" className="drawing-quiet-button" onClick={() => sync.current?.useTheirs()} disabled={!!busy}>Use theirs</button>
            <button type="button" className="drawing-quiet-button" onClick={() => void saveCopy()} disabled={!!busy}>{busy === 'copy' ? 'Saving copy…' : 'Save mine as a copy'}</button>
          </div>
        )}
        {(state === 'missing' || state === 'error') && snap?.unsaved && (
          <div className="drawing-workspace-conflict" role="alert">
            <span>{snap.error ?? 'This drawing could not be saved.'} Your edits are still here.</span>
            {state === 'error' && <button type="button" className="drawing-quiet-button" onClick={() => void sync.current?.retrySave()} disabled={!!busy}>Try again</button>}
            <button type="button" className="drawing-quiet-button" onClick={() => void saveCopy()} disabled={!!busy}>{busy === 'copy' ? 'Saving copy…' : 'Save mine as a copy'}</button>
          </div>
        )}
        {(notice || snap?.error) && !conflict && !((state === 'missing' || state === 'error') && snap?.unsaved && !notice) && <p className="drawing-workspace-notice" role="alert">{notice ?? snap?.error}</p>}
        {snap?.warning && (
          <div className="drawing-workspace-warning" role="status">
            <span>{snap.warning}</span>
            <button type="button" className="drawing-quiet-button" onClick={() => void sync.current?.retryIndex()}>Try again</button>
          </div>
        )}
        <div className="drawing-workspace-canvas">
          {!source && (
            <div className="drawing-workspace-empty">
              <p>{filesShown ? 'Open a drawing from the list, or start a new one' : 'Start a new drawing, or show the list to open one'}</p>
              <button type="button" className="drawing-quiet-button" onClick={() => void createNew()} disabled={!!busy}>New drawing</button>
            </div>
          )}
          {source && canvasError && (
            <div className="drawing-workspace-empty" role="alert">
              <p>{canvasError}</p>
              <button type="button" className="drawing-quiet-button" onClick={loadEditor}>Try again</button>
            </div>
          )}
          {source && !canvasError && (!Canvas || !shown?.scene) && state !== 'missing' && state !== 'error' && <div className="drawing-workspace-loading" role="status">Loading drawing…</div>}
          {source && Canvas && shown?.scene && (
            <Canvas key={id} scene={shown.scene} sceneKey={shown.sceneKey} theme={theme} autoFocus={!!draftId}
              menu={menu} diagramBusy={diagram?.phase === 'running'}
              onBrowseLibraries={() => setLibraryDialogOpen(true)}
              onLibrarySource={addLibrarySource}
              onScene={(scene: DrawingScene, key: number) => sync.current?.edit(scene, key)}
              onTextEditEnd={() => sync.current?.textEditEnded()}
              onReady={(handle) => { canvas.current = handle; }} />
          )}
          {textDialogOpen && (
            <form className="drawing-text-diagram" aria-label="Text to diagram"
              onSubmit={(e) => { e.preventDefault(); textGate.send(); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); setTextDialogOpen(false); }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.requestSubmit(); }
              }}>
              <MicField fieldClassName="drawing-text-diagram-field" boxRef={diagramBox} text={diagramText.text} setText={diagramText.setText} handleRef={diagramMic}
                target={diagramText.key} disabled={diagram?.phase === 'running'}>
                <textarea ref={diagramBox} aria-label="Describe the diagram" placeholder="Describe the diagram, for example: order service calls payment, then shipping" value={diagramText.text}
                  data-draft-key={diagramText.key ?? undefined} maxLength={4_000} rows={3} autoFocus onChange={(e) => diagramText.setText(e.target.value)} />
              </MicField>
              <div className="drawing-text-diagram-actions">
                <button type="button" className="drawing-quiet-button" onClick={() => setTextDialogOpen(false)}>Cancel</button>
                <button type="submit" className="drawing-primary-button" disabled={(!diagramText.text.trim() && !textGate.micBusy) || diagram?.phase === 'running'}
                  {...dictationWaitProps(textGate)}>Make diagram</button>
              </div>
            </form>
          )}
          {diagram && (
            <div className="drawing-diagram-note" data-phase={diagram.phase} role={diagram.phase === 'error' ? 'alert' : 'status'}>
              {diagram.phase === 'running'
                ? <><span>Making a diagram…</span><button type="button" className="drawing-quiet-button" onClick={cancelDiagram}>Cancel</button></>
                : <><span>{diagram.message}</span>
                    <button type="button" className="drawing-quiet-button" onClick={diagram.retry}>Try again</button>
                    <button type="button" className="drawing-icon-button" aria-label="Dismiss" onClick={() => setDiagram(null)}><Icon d={ICON.close} /></button></>}
            </div>
          )}
        </div>
        <footer className="drawing-workspace-credit">
          <a href="https://github.com/excalidraw/excalidraw" target="_blank" rel="noreferrer noopener">Powered by Excalidraw</a>
          <a href="/licenses/excalidraw.txt" target="_blank" rel="noreferrer noopener">License</a>
        </footer>
      </section>
      {assistantShown && currentPath && (
        <Suspense fallback={<aside className="drawing-assistant" aria-label="Drawing assistant"><p className="drawing-workspace-files-note">Loading…</p></aside>}>
          <DrawingAssistant path={currentPath} title={title} onLeave={() => canvas.current?.focus()} request={assistantRequest}
            onRequestDone={(id, error) => {
              if (!mounted.current) return;
              if (error) setNotice(error);
              else if (textAskId.current === id) { setTextDialogOpen(false); diagramText.clear(); }
              setAssistantRequest((now) => (now?.id === id ? null : now));
            }}
            onClose={() => { setAssistantShown(false); requestAnimationFrame(() => canvas.current?.focus()); }} />
        </Suspense>
      )}
      {libraryDialogOpen && <LibraryBrowser onClose={() => setLibraryDialogOpen(false)} onAdded={() => canvas.current?.openLibrary()} />}
    </div>
  );
}

export default DrawingWorkspace;
