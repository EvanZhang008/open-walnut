/**
 * The drawing editor itself: the only module that imports the editor package and its CSS. It is
 * loaded with a plain dynamic `import()` from DrawingWorkspace, so the editor is its own chunk,
 * fetched the first time a drawing opens and never part of the main bundle or a plugin's module.
 */
import './excalidraw-assets';
import { useEffect, useMemo, useRef } from 'react';
import { CaptureUpdateAction, Excalidraw, MainMenu, WelcomeScreen, exportToBlob, exportToSvg } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { editorFingerprint, sceneFromEditor, type DrawingScene } from './drawing-scene';

export interface DrawingCanvasHandle {
  exportPng(): Promise<Blob>;
  exportSvg(): Promise<Blob>;
  /** A text box is open in the canvas (Esc closes it, not the drawing). */
  isEditingText(): boolean;
  focus(): void;
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
}

type AnyElements = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>['onChange']>>[0];

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

export default function ExcalidrawCanvas({ scene, sceneKey, theme, autoFocus = false, onScene, onReady }: ExcalidrawCanvasProps) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const shownKey = useRef(sceneKey);
  const lastFp = useRef<string | null>(null);
  const latest = useRef({ scene, sceneKey, onScene, onReady });
  latest.current = { scene, sceneKey, onScene, onReady };
  // The first scene only: later ones go in through loadScene, so the editor keeps its view.
  const initialData = useMemo(() => ({ ...editorData(scene), scrollToContent: true }), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const editor = api.current;
    if (!editor || shownKey.current === sceneKey) return;
    shownKey.current = sceneKey;
    lastFp.current = null;
    loadScene(editor, scene);
  }, [scene, sceneKey]);

  useEffect(() => () => latest.current.onReady(null), []);

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
    };
  };

  return (
    <div ref={host} className="drawing-canvas-host">
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
      }}
      theme={theme}
      onChange={(elements, appState, files) => {
        // Still loading the first scene: nothing here is the person's yet.
        if (appState.isLoading) return;
        const fp = editorFingerprint(elements, appState, files);
        if (fp === lastFp.current) return;
        lastFp.current = fp;
        latest.current.onScene(sceneFromEditor(elements, appState, files), shownKey.current);
      }}
      UIOptions={{
        canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: true, clearCanvas: true, changeViewBackgroundColor: true },
      }}
      handleKeyboardGlobally={false}
      autoFocus={autoFocus}
    >
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
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
    </div>
  );
}
