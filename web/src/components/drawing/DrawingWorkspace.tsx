/**
 * Walnut's drawing workspace: the list of a task's (or session's, or Inbox's) drawings, the
 * editor, saving, export and attach. One component for every place a drawing opens: the Drawing
 * App's page and its session pane (through `walnut.ui.views.DrawingView`, plugins/views.tsx), a
 * note's attachment preview, and the composer's Draw dialog (DrawingPad.tsx, with `draftId`).
 *
 * Saving and conflicts live in DrawingSync (drawing-sync.ts); this file is the screen. The editor
 * is loaded with a plain dynamic import (ExcalidrawCanvas.tsx), so this module stays small.
 */
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { DRAFT_FLUSH_EVENT } from '@/utils/unsaved-work';
import { timeAgo } from '@/utils/time';
import { isBoolean, usePageView, usePageViewOf } from '@/utils/view-memory';
import { drawingApi, drawingErrorMessage, type DrawingApi } from './drawing-api';
import { exportFileName, sceneElementCount, sceneHasContent, sceneText, type DrawingListItem, type DrawingScene } from './drawing-scene';
import { DrawingSync, sketchDraftKey, type DrawingSnapshot, type DrawingSource } from './drawing-sync';
import { tabDrawingStore } from './drawing-store';
import type { DrawingCanvasHandle, ExcalidrawCanvasProps } from './ExcalidrawCanvas';
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
  return !source ? '' : source.kind === 'file' ? `file:${source.path}` : `sketch:${source.key}:${source.open ?? ''}`;
}

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
  const { taskId, sessionId, documentPath, draftId, onClose, onAttach, canAttach = true, onState, onDocumentPathChange } = props;
  const api = props.api ?? drawingApi;
  const scope = useMemo(() => ({ ...(taskId ? { taskId } : {}), ...(sessionId ? { sessionId } : {}) }), [taskId, sessionId]);
  const scopeId = taskId ? `task:${taskId}` : sessionId ? `session:${sessionId}` : 'inbox';
  const sketchKey = draftId ? sketchDraftKey(draftId) : null;

  // The file this place showed last (the App's page, a pane without a document of its own).
  const [lastDocument, setLastDocument] = usePageViewOf<string>('drawing', 'lastDocument', scopeId, '', isText);
  // Beside a session the pane is narrow, so the list starts hidden there; each place keeps its own choice.
  const beside = !draftId && Boolean(sessionId && onClose);
  const filesKey = draftId ? 'filesShownInComposer' : beside ? 'filesShownBeside' : 'filesShown';
  const [filesShown, setFilesShown] = usePageView<boolean>('drawing', filesKey, !draftId && !beside, isBoolean);

  const firstSource = (): DrawingSource | null => {
    if (documentPath) return { kind: 'file', path: documentPath };
    if (sketchKey) return { kind: 'sketch', key: sketchKey };
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
  const theme = usePageTheme();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // A host that names another document (the pane's remembered one, a link) opens it.
  const previousPath = useRef(documentPath);
  useEffect(() => {
    if (documentPath === previousPath.current) return;
    previousPath.current = documentPath;
    if (documentPath) setSource((s) => (s?.kind === 'file' && s.path === documentPath ? s : { kind: 'file', path: documentPath }));
  }, [documentPath]);

  // One controller per source. Its answers stop with dispose(), so a slow save of the file left
  // behind never reaches the one shown now.
  const id = sourceId(source);
  useEffect(() => {
    if (!source) { setSnap(null); return undefined; }
    const controller = new DrawingSync(source, { api, store: draftStore, scope, onChange: (s) => { if (sync.current === controller) setSnap(s); } });
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
    if (!sketchKey) setLastDocument(shownPath);
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

  // The server says this drawing changed (an agent's edit): take it now, not at the next poll.
  // The callback is read fresh on every event, so it always compares against the shown revision.
  useEvent('drawings:updated', (data: unknown) => {
    const change = data as { path?: unknown; revision?: unknown } | null;
    if (!change || change.path !== snap?.path || change.revision === snap?.revision) return;
    void sync.current?.refresh();
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
    if (!sketchKey || !controller || !controller.snapshot().unsaved) return true;
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

  const createNew = async () => {
    if (busy) return;
    setBusy('new');
    setNotice(null);
    try {
      if (!(await canLeave())) return;
      const doc = await api.create(scope);
      if (!mounted.current) return;
      refreshList();
      await openFile(doc.path);
    } catch (err) {
      if (mounted.current) setNotice(`A new drawing could not be made: ${drawingErrorMessage(err)}`);
    } finally {
      if (mounted.current) setBusy(null);
    }
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
  const hasScene = sceneHasContent(snap?.scene);
  const conflict = snap?.conflict ?? null;
  // Kept in the draft store, a reload brings it back; marked only when the store refused it.
  const lost = !!snap && snap.unsaved && !snap.kept;
  const title = snap?.path ? snap.title || 'Drawing' : snap?.source.kind === 'sketch' && state !== 'loading' ? 'New drawing' : state === 'loading' ? 'Opening…' : 'Drawing';
  const currentPath = shownPath;

  return (
    <div ref={root} className="drawing-workspace" data-files-shown={filesShown ? 'true' : 'false'} data-theme-resolved={theme}
      data-drawing-path={currentPath ?? undefined} data-drawing-revision={snap?.revision ?? undefined} data-save-state={state ?? 'none'}>
      {lost && <span hidden data-walnut-unsaved="A drawing that is not saved" />}
      {filesShown && (
        <aside className="drawing-workspace-files" aria-label="Drawings">
          <div className="drawing-workspace-files-head">
            <span>Drawings</span>
            <button type="button" className="drawing-workspace-new" onClick={() => void createNew()} disabled={!!busy}>{busy === 'new' ? 'Creating…' : 'New drawing'}</button>
          </div>
          {listError && <p className="drawing-workspace-files-note" role="alert">{listError}</p>}
          {list && list.length === 0 && !listError && <p className="drawing-workspace-files-note">No drawings here yet.</p>}
          {list === null && !listError && <p className="drawing-workspace-files-note">Loading…</p>}
          {list && list.length > 0 && (
            <ul className="drawing-workspace-file-list">
              {list.map((item) => (
                <li key={item.path}>
                  <button type="button" className="drawing-workspace-file" aria-current={item.path === currentPath ? 'true' : undefined} onClick={() => void openFile(item.path)} title={item.path}>
                    <span className="drawing-workspace-file-title">{item.title}</span>
                    {item.updatedAt && <span className="drawing-workspace-file-time">{timeAgo(item.updatedAt)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
      <section className="drawing-workspace-main" aria-label={title}>
        <header className="drawing-workspace-bar">
          <button type="button" className="drawing-workspace-files-toggle" aria-expanded={filesShown} aria-label={filesShown ? 'Hide drawings list' : 'Show drawings list'} title={filesShown ? 'Hide drawings list' : 'Show drawings list'} onClick={() => setFilesShown((v) => !v)}>☰</button>
          <h2 className="drawing-workspace-title" title={currentPath ?? undefined}>{title}</h2>
          {state && <span className="drawing-workspace-status" data-state={state} role="status" aria-live="polite">{STATUS_TEXT[state]}</span>}
          <span className="drawing-workspace-bar-gap" />
          <button type="button" onClick={() => void exportAs('png')} disabled={!!busy || !hasScene || !Canvas} title="Download as PNG">{busy === 'png' ? 'Exporting…' : 'PNG'}</button>
          <button type="button" onClick={() => void exportAs('svg')} disabled={!!busy || !hasScene || !Canvas} title="Download as SVG">{busy === 'svg' ? 'Exporting…' : 'SVG'}</button>
          {onAttach && <button type="button" className="drawing-workspace-attach" onClick={() => void attach()} disabled={!!busy || !hasScene || !canAttach || !Canvas} title={canAttach ? 'Add this drawing to your message as a picture' : 'Attachment limit reached'}>{busy === 'attach' ? 'Attaching…' : 'Attach PNG'}</button>}
          {onClose && <button type="button" className="drawing-workspace-close" onClick={close} aria-label="Close drawing" title="Close">×</button>}
        </header>
        {conflict && (
          <div className="drawing-workspace-conflict" role="alert">
            <span>{snap!.conflictShapes > 0
              ? `${snap!.conflictShapes === 1 ? 'One shape was' : `${snap!.conflictShapes} shapes were`} changed both here and somewhere else. Every other change, from both sides, is kept.`
              : 'This drawing was changed somewhere else while you were editing. Your edits are kept here until you choose.'}</span>
            <button type="button" onClick={() => void sync.current?.keepMine()} disabled={!!busy}>Keep mine</button>
            <button type="button" onClick={() => sync.current?.useTheirs()} disabled={!!busy}>Use theirs</button>
            <button type="button" onClick={() => void saveCopy()} disabled={!!busy}>{busy === 'copy' ? 'Saving copy…' : 'Save mine as a copy'}</button>
          </div>
        )}
        {(state === 'missing' || state === 'error') && snap?.unsaved && (
          <div className="drawing-workspace-conflict" role="alert">
            <span>{snap.error ?? 'This drawing could not be saved.'} Your edits are still here.</span>
            {state === 'error' && <button type="button" onClick={() => void sync.current?.retrySave()} disabled={!!busy}>Try again</button>}
            <button type="button" onClick={() => void saveCopy()} disabled={!!busy}>{busy === 'copy' ? 'Saving copy…' : 'Save mine as a copy'}</button>
          </div>
        )}
        {(notice || snap?.error) && !conflict && !((state === 'missing' || state === 'error') && snap?.unsaved && !notice) && <p className="drawing-workspace-notice" role="alert">{notice ?? snap?.error}</p>}
        {snap?.warning && (
          <div className="drawing-workspace-warning" role="status">
            <span>{snap.warning}</span>
            <button type="button" onClick={() => void sync.current?.retryIndex()}>Try again</button>
          </div>
        )}
        <div className="drawing-workspace-canvas">
          {!source && (
            <div className="drawing-workspace-empty">
              <p>{filesShown ? 'Open a drawing from the list, or start a new one.' : 'Start a new drawing, or show the list (\u2630) to open one.'}</p>
              <button type="button" onClick={() => void createNew()} disabled={!!busy}>New drawing</button>
            </div>
          )}
          {source && canvasError && (
            <div className="drawing-workspace-empty" role="alert">
              <p>{canvasError}</p>
              <button type="button" onClick={loadEditor}>Try again</button>
            </div>
          )}
          {source && !canvasError && (!Canvas || !snap?.scene) && state !== 'missing' && state !== 'error' && <div className="drawing-workspace-loading" role="status">Loading drawing…</div>}
          {source && Canvas && snap?.scene && (
            <Canvas key={id} scene={snap.scene} sceneKey={snap.sceneKey} theme={theme} autoFocus={!!draftId}
              onScene={(scene: DrawingScene, key: number) => sync.current?.edit(scene, key)}
              onReady={(handle) => { canvas.current = handle; }} />
          )}
        </div>
        <footer className="drawing-workspace-credit">
          <a href="https://github.com/excalidraw/excalidraw" target="_blank" rel="noreferrer noopener">Powered by Excalidraw</a>
          <a href="/licenses/excalidraw.txt" target="_blank" rel="noreferrer noopener">License</a>
        </footer>
      </section>
    </div>
  );
}

export default DrawingWorkspace;
