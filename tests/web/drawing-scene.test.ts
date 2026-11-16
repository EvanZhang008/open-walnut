import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  documentFrom, editorFingerprint, emptyScene, exportFileName, isEditorFormOf, parseScene, sceneFingerprint,
  sceneFromEditor, sceneText, type ElementCopies,
} from '../../web/src/components/drawing/drawing-scene';
import { EXCALIDRAW_ASSET_PATH, EXCALIDRAW_VERSION } from '../../web/src/components/drawing/excalidraw-assets';

const rect = (id: string, version = 1, extra: Record<string, unknown> = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version, versionNonce: version * 7, ...extra });

describe('drawing scene', () => {
  it('reads a broken file or draft as broken, never as an empty drawing', () => {
    expect(parseScene({ type: 'excalidraw', elements: [rect('a')] })?.elements).toHaveLength(1);
    expect(parseScene({ elements: [] })).toEqual({ ...emptyScene(), appState: {} });
    for (const bad of [null, 'x', {}, { elements: 'no' }, { elements: [{ type: 'rectangle' }] }, { elements: [{ id: 'a' }] },
      { type: 'other', elements: [] }, { elements: [], files: [] }, { elements: [], appState: 3 }]) {
      expect(parseScene(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(documentFrom({ path: 'Inbox/a.excalidraw', revision: 'r1', title: 'A', scene: { elements: 'broken' } })).toBeNull();
    expect(documentFrom({ current: { path: 'Inbox/a.excalidraw', revision: 2, scene: { elements: [] } } })).toMatchObject({ revision: '2', title: 'Untitled drawing' });
  });

  it('drops deleted elements and files no live image uses, and keeps the whole appState as read', () => {
    const scene = parseScene({
      elements: [rect('a', 1, { isDeleted: true }), { id: 'img', type: 'image', fileId: 'f1' }],
      files: { f1: { id: 'f1', mimeType: 'image/png', dataURL: 'data:x' }, f2: { id: 'f2', mimeType: 'image/png', dataURL: 'data:y' } },
      appState: { viewBackgroundColor: '#fff', scrollX: 400, zoom: { value: 2 } },
    })!;
    expect(scene.elements.map((e) => e.id)).toEqual(['img']);
    expect(Object.keys(scene.files)).toEqual(['f1']);
    expect(scene.appState).toEqual({ viewBackgroundColor: '#fff', scrollX: 400, zoom: { value: 2 } });
  });

  it('a stored scene is a deep copy: the editor mutating its element in place never changes a save on its way', () => {
    const line = { id: 'l', type: 'line', version: 3, versionNonce: 9, points: [[0, 0], [5, 5]], boundElements: [{ id: 'x', type: 'arrow' }] };
    const copies: ElementCopies = new Map();
    const taken = sceneFromEditor([line], {}, {}, copies);
    // The editor drags the point and rebinds, mutating the same object (and bumping its version).
    line.points[1][0] = 99;
    line.points.push([7, 7]);
    line.boundElements[0].id = 'y';
    line.version = 4;
    expect(taken.elements[0].points).toEqual([[0, 0], [5, 5]]);
    expect((taken.elements[0].boundElements as Array<{ id: string }>)[0].id).toBe('x');
    const next = sceneFromEditor([line], {}, {}, copies);
    expect(next.elements[0].points).toEqual([[0, 0], [99, 5], [7, 7]]);
    // An unchanged version reuses its copy; a removed element leaves the cache.
    const again = sceneFromEditor([line], {}, {}, copies);
    expect(again.elements[0]).toBe(next.elements[0]);
    sceneFromEditor([], {}, {}, copies);
    expect(copies.size).toBe(0);
  });

  it('fingerprints change with any edit, a file under the same id included, and match the cheap editor form', () => {
    const files = { f: { id: 'f', mimeType: 'image/png', dataURL: 'data:aa' } };
    const els = [rect('a'), { id: 'i', type: 'image', fileId: 'f', version: 1, versionNonce: 1 }];
    const scene = sceneFromEditor(els, { viewBackgroundColor: '#fff', scrollX: 3 }, files);
    expect(editorFingerprint(els, { viewBackgroundColor: '#fff', scrollX: 99 }, files)).toBe(sceneFingerprint(scene));
    expect(editorFingerprint([rect('a', 2), els[1]], {}, files)).not.toBe(editorFingerprint(els, {}, files));
    expect(editorFingerprint(els, {}, { f: { ...files.f, dataURL: 'data:aaaa' } })).not.toBe(editorFingerprint(els, {}, files));
    // An element an agent wrote without a version is compared by its value.
    expect(sceneFingerprint(parseScene({ elements: [{ id: 'a', type: 'text', text: 'A' }] })!))
      .not.toBe(sceneFingerprint(parseScene({ elements: [{ id: 'a', type: 'text', text: 'B' }] })!));
  });

  it("tells the editor's own form of a loaded scene from the person's first edit", () => {
    const loaded = parseScene({ elements: [rect('a', 2), { id: 'agent', type: 'text', text: 'Hi' }] })!;
    const filled = parseScene({ elements: [rect('a', 2, { roundness: null }), { id: 'agent', type: 'text', text: 'Hi', version: 1, versionNonce: 5 }] })!;
    expect(isEditorFormOf(loaded, filled)).toBe(true);
    expect(isEditorFormOf(loaded, parseScene({ elements: [rect('a', 3), filled.elements[1]] })!)).toBe(false);
    expect(isEditorFormOf(loaded, parseScene({ elements: [...filled.elements, rect('new')] })!)).toBe(false);
    expect(isEditorFormOf(emptyScene(), parseScene({ elements: [rect('first')] })!)).toBe(false);
  });

  it('reads the words top to bottom and names export files safely', () => {
    const scene = parseScene({ elements: [{ id: 'b', type: 'text', text: 'Second', x: 0, y: 50 }, { id: 'a', type: 'text', text: ' First ', x: 0, y: 10 }, rect('r')] })!;
    expect(sceneText(scene)).toBe('First\nSecond');
    expect(exportFileName('a/b: c?', 'png')).toBe('a b c.png');
    expect(exportFileName('  ', 'svg')).toBe('drawing.svg');
  });

  it("loads the editor's fonts from this Walnut, at the installed package's version", () => {
    const root = path.resolve(import.meta.dirname, '../../web');
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@excalidraw/excalidraw/package.json'), 'utf8')).version;
    const pinned = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['@excalidraw/excalidraw'];
    expect(EXCALIDRAW_VERSION).toBe(installed);
    expect(pinned).toBe(installed);
    expect(EXCALIDRAW_ASSET_PATH).toBe(`/excalidraw-assets/${installed}/`);
    // The editor resolves its fonts as `./fonts/<family>/<file>` against that path.
    expect(fs.existsSync(path.join(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont'))).toBe(true);
  });
});

describe('drawing scene shared with the server', () => {
  it("reads a scene's words and starts a new scene the way the server does", async () => {
    const server = await import('../../src/core/drawings/scene');
    const scene = parseScene({ elements: [
      { id: 'b', type: 'text', text: 'Second  line', originalText: 'Second\nline', x: 5, y: 50 },
      { id: 'a', type: 'text', text: ' First ', x: 0, y: 10 },
      { id: 'f', type: 'frame', name: 'Frame', x: 0, y: 30 },
      { id: 'd', type: 'text', text: 'gone', isDeleted: true, x: 0, y: 0 },
    ] })!;
    expect(sceneText(scene).split('\n')).toEqual(server.sceneText(scene));
    expect(sceneText(scene)).toBe('First\nFrame\nSecond line');
    const fresh = server.emptyScene();
    expect(emptyScene()).toMatchObject({ type: fresh.type, elements: fresh.elements, appState: fresh.appState, files: fresh.files });
  });

  it('writes back unknown top-level keys at the top, never nested', async () => {
    const { sceneForStorage } = await import('../../web/src/components/drawing/drawing-scene');
    const scene = parseScene({ elements: [], libraryVersion: 3 })!;
    expect(scene.extra).toEqual({ libraryVersion: 3 });
    const stored = sceneForStorage(scene);
    expect(stored.libraryVersion).toBe(3);
    expect(stored.extra).toBeUndefined();
    expect(parseScene(stored)!.extra).toEqual({ libraryVersion: 3 });
  });
});

describe("a drawing's unsaved edits stay in this tab", () => {
  it('keys them by tab, outside the shared draft store and ui-prefs', async () => {
    const { tabDrawingStore, resetDrawingTabForTest, DRAWING_STORE_PREFIX } = await import('../../web/src/components/drawing/drawing-store');
    const { isDraftKey } = await import('../../web/src/utils/drafts');
    const { syncable } = await import('../../web/src/utils/ui-prefs-sync');
    const local = new Map<string, string>();
    const sessions = [new Map<string, string>(), new Map<string, string>()];
    let tab = 0;
    const storage = (m: () => Map<string, string>) => ({
      getItem: (k: string) => m().get(k) ?? null, setItem: (k: string, v: string) => { m().set(k, v); }, removeItem: (k: string) => { m().delete(k); },
    });
    const g = globalThis as Record<string, unknown>;
    const saved = { localStorage: g.localStorage, sessionStorage: g.sessionStorage };
    g.localStorage = storage(() => local);
    g.sessionStorage = storage(() => sessions[tab]);
    try {
      resetDrawingTabForTest();
      tabDrawingStore.write('file:Inbox/a.excalidraw', 'tab one');
      // The tab's heartbeat (drawing-store.ts) is the other key it writes.
      const [key] = [...local.keys()].filter((k) => !k.startsWith('walnut-drawing-alive:'));
      expect(key.startsWith(DRAWING_STORE_PREFIX)).toBe(true);
      expect(isDraftKey(key)).toBe(false);
      expect(syncable(key)).toBe(false);
      // The same tab after a reload reads it; another tab does not.
      resetDrawingTabForTest();
      expect(tabDrawingStore.read('file:Inbox/a.excalidraw')).toBe('tab one');
      tab = 1;
      resetDrawingTabForTest();
      expect(tabDrawingStore.read('file:Inbox/a.excalidraw')).toBe('');
      tabDrawingStore.write('file:Inbox/a.excalidraw', '');
      tab = 0;
      resetDrawingTabForTest();
      expect(tabDrawingStore.read('file:Inbox/a.excalidraw')).toBe('tab one');
    } finally {
      g.localStorage = saved.localStorage;
      g.sessionStorage = saved.sessionStorage;
      resetDrawingTabForTest();
    }
  });
});
