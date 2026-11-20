/**
 * The drawing editor itself: the only module that imports the editor package and its CSS. It is
 * loaded with a plain dynamic `import()` from DrawingWorkspace, so the editor is its own chunk,
 * fetched the first time a drawing opens and never part of the main bundle or a plugin's module.
 *
 * Besides the scene it carries:
 *  - the library (drawing-library.ts): the tab's items go in, the person's changes come out;
 *  - the editor's own "Browse libraries" link, which opens libraries.excalidraw.com in a window
 *    of its own and expects the site to send the library back to this address
 *    (`#addLibrary=`). The Mac app hands such a window to the default browser, so the library
 *    went back to a browser tab, never to the editor that asked. The link has no prop to replace
 *    it, so a click on it (`.library-menu-browse-button`) is caught here and opens Walnut's own
 *    catalog dialog (LibraryBrowser.tsx) instead. A `#addLibrary=` that does arrive is taken too;
 *  - the drawing menu's Download PNG / SVG and the diagram actions, and the "Make a diagram"
 *    button over a selection;
 *  - the view (zoom, scroll) and the editor's instance id as data attributes on its box, which
 *    the browser tests read to prove full screen kept the same editor and view;
 *  - with `onActivity`, the person's steps (drawing-activity.ts): drawn, changed, removed,
 *    selected, pointed at. A scene loaded from outside is a new baseline, never a step.
 */
import './excalidraw-assets';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CaptureUpdateAction, Excalidraw, MainMenu, WelcomeScreen, convertToExcalidrawElements, exportToBlob, exportToSvg } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { randomId } from '@/utils/random-id';
import { editorFingerprint, sceneFromEditor, type DrawingScene } from './drawing-scene';
import { libraryFingerprint, parseLibraryItems, tabLibrary, takeAddLibrary, type LibraryItem, type LibraryStore } from './drawing-library';
import { applyDiagram, boundsOf, diagramSource, type Bounds, type DiagramEditor } from './drawing-diagram';
import { ActivityTracker, type Activity, type ActivityElement } from './drawing-activity';

export interface DiagramInput {
  elements: Array<Record<string, unknown>>;
  files: Record<string, unknown>;
  /** Something was selected (else the whole drawing is the source). */
  selected: boolean;
  bounds: Bounds | null;
}

export interface DrawingCanvasHandle {
  exportPng(): Promise<Blob>;
  exportSvg(): Promise<Blob>;
  /** A text box is open in the canvas (Esc closes it, not the drawing). */
  isEditingText(): boolean;
  focus(): void;
  /** The editor's box moved or changed size (full screen): measure it again. */
  refresh(): void;
  /** What "Make a diagram" sends: the selection, or every shape when nothing is selected. */
  diagramInput(): DiagramInput;
  /** Add a diagram (skeleton shapes) beside `source`, or mid-screen without one; one undo step. */
  applyDiagram(skeleton: Array<Record<string, unknown>>, source: Bounds | null): string[];
  /** Show the Library panel. */
  openLibrary(): void;
}

export interface CanvasMenu {
  onDownload(kind: 'png' | 'svg'): void;
  onMakeDiagram(): void;
  onTextToDiagram(): void;
}

export interface ExcalidrawCanvasProps {
  scene: DrawingScene;
  /** Bumped when `scene` must replace what the editor shows. */
  sceneKey: number;
  theme: 'light' | 'dark';
  /** Take the keyboard on mount (a dialog); a pane beside a chat leaves it where it is. */
  autoFocus?: boolean;
  onScene(scene: DrawingScene, sceneKey: number): void;
  onReady(handle: DrawingCanvasHandle | null): void;
  /** The text box the person was typing in closed. */
  onTextEditEnd?(): void;
  menu?: CanvasMenu;
  /** A diagram is being made: the selection button stays away meanwhile. */
  diagramBusy?: boolean;
  /** The editor's "Browse libraries" was pressed. */
  onBrowseLibraries?(): void;
  /** A library the catalog sent back in the address, by its catalog source. */
  onLibrarySource?(source: string): void;
  /** Tests pass their own. */
  library?: LibraryStore;
  /** The person's steps on the canvas (drawing-activity.ts); left out, nothing is tracked. */
  onActivity?(activity: Activity): void;
}

type AnyElements = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>['onChange']>>[0];
type AnyAppState = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>['onChange']>>[1];

/** The editor mutates the elements it is given (indices, versions): it gets its own copies. */
function editorData(scene: DrawingScene) {
  return {
    elements: structuredClone(scene.elements) as unknown as AnyElements,
    appState: { ...scene.appState },
    files: scene.files as unknown as Record<string, never>,
  };
}

/**
 * A scene from elsewhere (an agent's append, Use theirs) replaces what is shown, and the undo
 * history starts over: an undo never steps back across a revision and silently takes out what
 * someone else added. The person's own edits since the last load stay undoable as usual.
 */
function loadScene(editor: ExcalidrawImperativeAPI, scene: DrawingScene): void {
  const data = editorData(scene);
  editor.addFiles(Object.values(data.files));
  editor.updateScene({ elements: data.elements, appState: data.appState as never, captureUpdate: CaptureUpdateAction.NEVER });
  editor.history.clear();
}

/**
 * The editor's zoom-to-fit keys (Shift+1, Shift+2: everything; Shift+3: the selection) measure its
 * toolbar, properties panel and sidebar in page coordinates as if the editor sat at the page's top
 * left (Excalidraw 0.18 App.getEditorUIOffsets). Walnut's editor never does (the sidebar, the
 * drawings list, a dialog), so those keys zoomed out to 10% with the drawing pushed to one side.
 * They are answered here instead, with the same offsets measured from the editor's own box.
 */
function fitKeyOf(e: KeyboardEvent): 'all' | 'selection' | null {
  if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.code === 'Digit1' || e.code === 'Digit2') return 'all';
  return e.code === 'Digit3' ? 'selection' : null;
}

function editorUiOffsets(host: HTMLElement): { top: number; right: number; bottom: number; left: number } {
  const box = (host.querySelector('.excalidraw') ?? host).getBoundingClientRect();
  const rect = (selector: string) => host.querySelector(selector)?.getBoundingClientRect();
  const toolbar = rect('.App-toolbar');
  const sidebar = rect('.sidebar');
  const panel = rect('.App-menu__left');
  const pad = 16;
  return {
    top: Math.max(toolbar ? toolbar.bottom - box.top : 0, 0) + pad,
    right: Math.max(sidebar ? box.right - sidebar.left : 0, 0) + pad,
    bottom: pad,
    left: Math.max(panel ? panel.right - box.left : 0, 0) + pad,
  };
}

/** The editor's bottom bar (zoom, undo, help) and a gap: a pill below a selection stays above it. */
const PILL_BOTTOM_CLEAR = 88;

/** Where the "Make a diagram" button sits: above the selection's top right, or under it near the top. */
interface Pill { x: number; y: number; below: boolean }

function pillFor(elements: AnyElements, appState: AnyAppState): Pill | null {
  const busy = appState.newElement || appState.selectionElement || appState.isResizing || appState.isRotating
    || appState.editingTextElement || appState.selectedElementsAreBeingDragged || appState.multiElement;
  const ids = appState.selectedElementIds;
  if (busy || !ids || !Object.keys(ids).length) return null;
  const picked = (elements as unknown as Array<Record<string, unknown>>).filter((el) => !el.isDeleted && ids[String(el.id)]);
  const b = boundsOf(picked);
  if (!b) return null;
  const zoom = appState.zoom.value || 1;
  const x = Math.round((b.maxX + appState.scrollX) * zoom);
  const top = Math.round((b.minY + appState.scrollY) * zoom);
  const bottom = Math.round((b.maxY + appState.scrollY) * zoom);
  const below = top < 56;
  // Never under the editor's own corner controls (zoom, undo, help) along the bottom.
  return { x: Math.max(120, Math.min(x, appState.width - 8)), y: below ? Math.min(bottom + 8, appState.height - PILL_BOTTOM_CLEAR) : Math.min(top - 8, appState.height - PILL_BOTTOM_CLEAR), below };
}

const MenuIcon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const ICON_DOWNLOAD = 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14';
const ICON_DIAGRAM = 'M4 5h6v5H4zM14 14h6v5h-6zM7 10v4h7';
const ICON_TEXT = 'M5 6h14M12 6v12M9 18h6';

export default function ExcalidrawCanvas({ scene, sceneKey, theme, autoFocus = false, onScene, onReady, onTextEditEnd, menu, diagramBusy = false, onBrowseLibraries, onLibrarySource, library = tabLibrary, onActivity }: ExcalidrawCanvasProps) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const shownKey = useRef(sceneKey);
  const lastFp = useRef<string | null>(null);
  const latest = useRef({ scene, sceneKey, onScene, onReady, onLibrarySource, onTextEditEnd, onActivity });
  latest.current = { scene, sceneKey, onScene, onReady, onLibrarySource, onTextEditEnd, onActivity };
  // The steps tracker, made the first time someone listens; `key` is the scene it diffs from.
  const activity = useRef<{ tracker: ActivityTracker; key: number; selected: unknown } | null>(null);
  const wasEditingText = useRef(false);
  const instance = useMemo(() => randomId(), []);
  const [pill, setPill] = useState<Pill | null>(null);
  const pillKey = useRef('');
  const view = useRef('');
  // The library this editor shows, by fingerprint: what came from the store is not handed back.
  const libraryShown = useRef(library.isLoaded() ? libraryFingerprint(library.items()) : '');
  // The first scene only: later ones go in through loadScene, so the editor keeps its view.
  const initialData = useMemo(() => ({
    ...editorData(scene),
    scrollToContent: true,
    ...(library.isLoaded() ? { libraryItems: library.items() as never } : {}),
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const editor = api.current;
    if (!editor || shownKey.current === sceneKey) return;
    shownKey.current = sceneKey;
    lastFp.current = null;
    loadScene(editor, scene);
  }, [scene, sceneKey]);

  useEffect(() => () => {
    latest.current.onReady(null);
    activity.current?.tracker.dispose();
  }, []);

  // Someone starts listening: what is on the canvas now is the baseline, so the first step is the
  // person's next change. They stop: the tracker goes, and nothing is diffed meanwhile.
  const listening = !!onActivity;
  useEffect(() => {
    if (!listening) {
      activity.current?.tracker.dispose();
      activity.current = null;
      return;
    }
    const editor = api.current;
    if (!editor) return;
    const a = activity.current ??= { tracker: new ActivityTracker((step) => latest.current.onActivity?.(step)), key: Number.NaN, selected: null };
    const appState = editor.getAppState();
    a.key = shownKey.current;
    a.selected = appState.selectedElementIds;
    a.tracker.baseline(editor.getSceneElements() as unknown as readonly ActivityElement[], appState.selectedElementIds);
  }, [listening]);

  /** The person's steps since the last scene (only while someone listens). */
  const track = (elements: AnyElements, appState: AnyAppState, changed: boolean) => {
    if (!latest.current.onActivity) return;
    const a = activity.current ??= { tracker: new ActivityTracker((step) => latest.current.onActivity?.(step)), key: Number.NaN, selected: null };
    const els = elements as unknown as readonly ActivityElement[];
    if (a.key !== shownKey.current) {
      a.key = shownKey.current;
      a.selected = appState.selectedElementIds;
      a.tracker.baseline(els, appState.selectedElementIds);
      return;
    }
    if (!changed && a.selected === appState.selectedElementIds) return;
    a.selected = appState.selectedElementIds;
    a.tracker.change(els, appState.selectedElementIds);
  };

  // Zoom to fit, measured from this editor's box (fitKeyOf). Before the editor's own key handler,
  // which listens on its container inside this box.
  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const which = fitKeyOf(e);
      const editor = api.current;
      if (!which || !editor || e.isComposing) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"]')) return;
      const appState = editor.getAppState();
      if (appState.editingTextElement) return;
      const live = editor.getSceneElements().filter((item) => !item.isDeleted);
      const picked = which === 'selection' ? live.filter((item) => appState.selectedElementIds[item.id]) : [];
      const targets = picked.length ? picked : live;
      if (!targets.length) return;
      e.preventDefault();
      e.stopPropagation();
      editor.scrollToContent(targets, {
        ...(which === 'selection' ? { fitToViewport: true } : { fitToContent: true }),
        canvasOffsets: editorUiOffsets(el),
      } as never);
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, []);

  // The tab's library: shown here, and kept in step with every other editor and the server.
  const showLibrary = (items: LibraryItem[]) => {
    const editor = api.current;
    const fp = libraryFingerprint(items);
    if (!editor || fp === libraryShown.current) return;
    libraryShown.current = fp;
    void editor.updateLibrary({ libraryItems: items as never, merge: false }).catch(() => {});
  };
  useEffect(() => library.subscribe(showLibrary), [library]); // eslint-disable-line react-hooks/exhaustive-deps

  // A library the catalog site sent back to this address (a browser that opened it).
  useEffect(() => {
    const take = () => {
      const taken = takeAddLibrary(window.location.hash);
      if (!taken) return;
      // Cleared first, even when the value is bad, so a reload never reads it again.
      history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${taken.rest}`);
      if (taken.source) latest.current.onLibrarySource?.(taken.source);
    };
    take();
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, []);

  const handle = (editor: ExcalidrawImperativeAPI): DrawingCanvasHandle => {
    const exportInput = () => ({
      elements: editor.getSceneElements(),
      appState: { ...editor.getAppState(), exportBackground: true, exportWithDarkMode: false },
      files: editor.getFiles(),
      exportPadding: 16,
    });
    return {
      exportPng: () => exportToBlob({ ...exportInput(), mimeType: 'image/png' }),
      exportSvg: async () => {
        const svg = await exportToSvg(exportInput());
        return new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
      },
      isEditingText: () => !!editor.getAppState().editingTextElement,
      focus: () => { host.current?.querySelector<HTMLElement>('.excalidraw-container, .excalidraw')?.focus(); },
      refresh: () => editor.refresh(),
      diagramInput: () => {
        const src = diagramSource(
          editor.getSceneElements() as unknown as Array<Record<string, unknown>>,
          editor.getAppState().selectedElementIds,
          editor.getFiles() as unknown as Record<string, unknown>,
        );
        return { elements: structuredClone(src.elements), files: src.files, selected: src.selected, bounds: src.bounds };
      },
      applyDiagram: (skeleton, source) => {
        const converted = convertToExcalidrawElements(skeleton as never, { regenerateIds: true }) as unknown as Array<Record<string, unknown>>;
        const s = editor.getAppState();
        return applyDiagram(editor as unknown as DiagramEditor, converted, source,
          { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value, width: s.width, height: s.height },
          CaptureUpdateAction.IMMEDIATELY);
      },
      openLibrary: () => { editor.toggleSidebar({ name: 'default', tab: 'library', force: true }); },
    };
  };

  /** The view and selection, as attributes on the box (cheap: written only when they change). */
  const report = (elements: AnyElements, appState: AnyAppState) => {
    const el = host.current;
    if (el) {
      const v = `${appState.zoom.value}|${Math.round(appState.scrollX)}|${Math.round(appState.scrollY)}`;
      if (v !== view.current) {
        view.current = v;
        el.dataset.zoom = String(appState.zoom.value);
        el.dataset.scrollX = String(Math.round(appState.scrollX));
        el.dataset.scrollY = String(Math.round(appState.scrollY));
      }
    }
    const next = menu ? pillFor(elements, appState) : null;
    const key = next ? `${next.x}|${next.y}|${next.below}` : '';
    if (key !== pillKey.current) {
      pillKey.current = key;
      setPill(next);
    }
  };

  return (
    <div ref={host} className="drawing-canvas-host" data-editor-instance={instance}
      onClickCapture={(e) => {
        // The editor's own Browse libraries link: Walnut's catalog instead (see the top of this file).
        const link = e.target instanceof Element ? e.target.closest('a.library-menu-browse-button') : null;
        if (!link || !onBrowseLibraries) return;
        e.preventDefault();
        e.stopPropagation();
        onBrowseLibraries();
      }}>
    <Excalidraw
      initialData={initialData}
      excalidrawAPI={(editor) => {
        api.current = editor;
        // A scene that arrived while the editor was starting goes in now.
        if (shownKey.current !== latest.current.sceneKey) {
          shownKey.current = latest.current.sceneKey;
          lastFp.current = null;
          loadScene(editor, latest.current.scene);
        }
        latest.current.onReady(handle(editor));
        void library.load().then(() => showLibrary(library.items()));
      }}
      theme={theme}
      onChange={(elements, appState, files) => {
        report(elements, appState);
        const editingText = !!appState.editingTextElement;
        const textClosed = wasEditingText.current && !editingText;
        wasEditingText.current = editingText;
        // Still loading the first scene: nothing here is the person's yet.
        if (appState.isLoading) return;
        const fp = editorFingerprint(elements, appState, files);
        const changed = fp !== lastFp.current;
        if (changed) {
          lastFp.current = fp;
          latest.current.onScene(sceneFromEditor(elements, appState, files), shownKey.current);
        }
        track(elements, appState, changed);
        // After the scene it closed with, so a rename that waited for the box sees that scene.
        if (textClosed) latest.current.onTextEditEnd?.();
      }}
      onPointerUpdate={({ pointer }) => { if (latest.current.onActivity) activity.current?.tracker.pointer(pointer.x, pointer.y); }}
      onLibraryChange={(items) => {
        const parsed = parseLibraryItems(items);
        const fp = libraryFingerprint(parsed);
        if (fp === libraryShown.current) return;
        libraryShown.current = fp;
        library.edited(parsed);
      }}
      UIOptions={{
        canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: true, clearCanvas: true, changeViewBackgroundColor: true },
      }}
      handleKeyboardGlobally={false}
      // No editor AI: Walnut's own Make a diagram / Text to diagram ask Walnut's server, and the
      // editor's Mermaid half is left out of the build (web/bundle-trim.ts).
      aiEnabled={false}
      autoFocus={autoFocus}
    >
      <MainMenu>
        {menu && <>
          <MainMenu.Item icon={<MenuIcon d={ICON_DOWNLOAD} />} onSelect={() => menu.onDownload('png')}>Download PNG</MainMenu.Item>
          <MainMenu.Item icon={<MenuIcon d={ICON_DOWNLOAD} />} onSelect={() => menu.onDownload('svg')}>Download SVG</MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.Item icon={<MenuIcon d={ICON_DIAGRAM} />} onSelect={() => menu.onMakeDiagram()}>Make a diagram</MainMenu.Item>
          <MainMenu.Item icon={<MenuIcon d={ICON_TEXT} />} onSelect={() => menu.onTextToDiagram()}>Text to diagram</MainMenu.Item>
          <MainMenu.Separator />
        </>}
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
      <WelcomeScreen>
        <WelcomeScreen.Hints.MenuHint />
        <WelcomeScreen.Hints.ToolbarHint />
        <WelcomeScreen.Hints.HelpHint />
      </WelcomeScreen>
    </Excalidraw>
      {menu && pill && !diagramBusy && (
        <button type="button" className="drawing-diagram-pill" data-below={pill.below ? 'true' : undefined}
          style={{ left: pill.x, top: pill.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => menu.onMakeDiagram()}>
          <MenuIcon d={ICON_DIAGRAM} />
          <span>Make a diagram</span>
        </button>
      )}
    </div>
  );
}
