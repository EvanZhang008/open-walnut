/**
 * DrawingWorkspace, mounted: full screen is the same element covering the window, so the editor
 * inside is never mounted again (its zoom, scroll, selection and undo history stay), both ways;
 * the editor is told to measure its box again. And "New drawing" makes no file: it opens a sketch.
 *
 * Real React over a linkedom document (as tests/web/agent-file-opener-lifetime.test.ts); the
 * editor is a stand-in that counts its mounts.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act, useEffect, useState } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';

const h = vi.hoisted(() => ({ mounts: 0, unmounts: 0, refresh: 0, focus: 0, mountedWith: [] as number[], lastDocument: '' }));

vi.mock('@/utils/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/hooks/useWebSocket', () => ({ useEvent: () => {} }));
vi.mock('@/utils/view-memory', async () => {
  const react = await import('../../web/node_modules/react/index.js');
  return {
    isBoolean: (v: unknown) => typeof v === 'boolean',
    usePageView: (_page: string, _key: string, init: unknown) => react.useState(init),
    usePageViewOf: (_page: string, key: string, _id: string, init: unknown) => react.useState(key === 'lastDocument' && h.lastDocument ? h.lastDocument : init),
  };
});
vi.mock('../../web/src/components/drawing/usePageTheme', () => ({ usePageTheme: () => 'light' }));
vi.mock('../../web/src/components/drawing/drawing-store', () => {
  const map = new Map<string, string>();
  return { tabDrawingStore: { read: (k: string) => map.get(k) ?? '', write: (k: string, t: string) => { if (t) map.set(k, t); else map.delete(k); } } };
});
vi.mock('../../web/src/components/drawing/ExcalidrawCanvas', () => ({
  default: function FakeCanvas(props: { onReady(h: unknown): void; scene: { elements: unknown[] } }) {
    const [id] = useState(() => `editor-${h.mounts + 1}`);
    // The scene an editor starts with is its first one only (ExcalidrawCanvas initialData).
    const [first] = useState(() => props.scene.elements.length);
    useEffect(() => {
      h.mounts++;
      h.mountedWith.push(first);
      props.onReady({ refresh: () => { h.refresh++; }, focus: () => { h.focus++; }, isEditingText: () => false });
      return () => { h.unmounts++; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return createElement('div', { className: 'fake-editor', 'data-editor-instance': id });
  },
}));

import { DrawingWorkspace } from '../../web/src/components/drawing/DrawingWorkspace';
import { emptyScene } from '../../web/src/components/drawing/drawing-scene';
import type { DrawingApi } from '../../web/src/components/drawing/drawing-api';

/** A drawing with one shape on it. */
const sketched = () => ({ ...emptyScene(), elements: [{ id: 'box', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] }) as unknown as ReturnType<typeof emptyScene>;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });

let doc: Document;
let root: { render(el: unknown): void; unmount(): void } | null = null;
const created: unknown[] = [];
const api: DrawingApi = {
  async get(path) { return { path, title: 'Plan', revision: 'r1', scene: path.includes('sketched') ? sketched() : emptyScene() }; },
  async put(path, revision, scene) { return { path, title: 'Plan', revision: `${revision}x`, scene }; },
  async create(input) { created.push(input); return { path: 'Inbox/new.excalidraw', title: 'New', revision: 'r1', scene: emptyScene() }; },
  async rename(path, revision, title) { return { path, title, revision, scene: emptyScene() }; },
  async list() { return [{ path: 'Inbox/plan.excalidraw', title: 'Plan', updatedAt: '' }]; },
};

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body><div id="pane" style="backdrop-filter: blur(8px)"></div></body></html>');
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.document;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  g.getComputedStyle = () => ({ position: 'static', overflowX: 'visible', overflowY: 'visible', transform: 'none', perspective: 'none', filter: 'none', backdropFilter: 'none', contain: 'none', willChange: 'auto', zIndex: 'auto' });
  doc = dom.document as unknown as Document;
  Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
});

async function mount(props: Record<string, unknown>) {
  const el = doc.getElementById('pane')!;
  root = createRoot(el as unknown as Element) as unknown as typeof root;
  await act(async () => { root!.render(createElement(DrawingWorkspace, { api, ...props })); });
  await flush();
}
const button = (label: string) => doc.querySelector(`button[aria-label="${label}"]`) as unknown as HTMLButtonElement | null;
const click = async (label: string) => { await act(async () => { button(label)!.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('click', { bubbles: true })); }); await flush(); };

describe('full screen keeps the same editor', () => {
  it('toggles both ways without mounting the editor again', async () => {
    h.mounts = 0; h.unmounts = 0; h.refresh = 0; h.focus = 0;
    await mount({ documentPath: 'Inbox/plan.excalidraw' });
    const ws = doc.querySelector('.drawing-workspace')!;
    const editor = doc.querySelector('.fake-editor');
    expect(editor).not.toBeNull();
    expect(h.mounts).toBe(1);
    expect(ws.getAttribute('data-fullscreen')).toBe('false');

    await click('Full screen');
    expect(ws.getAttribute('data-fullscreen')).toBe('true');
    expect(doc.querySelector('.fake-editor')).toBe(editor);
    expect(button('Exit full screen')).not.toBeNull();

    await click('Exit full screen');
    expect(ws.getAttribute('data-fullscreen')).toBe('false');
    expect(doc.querySelector('.fake-editor')).toBe(editor);
    expect(h.mounts).toBe(1);
    expect(h.unmounts).toBe(0);
    // The editor measured its box again after each move, and has the keys back after each click.
    expect(h.refresh).toBeGreaterThanOrEqual(2);
    expect(h.focus).toBe(2);
  });
});

describe('"New drawing"', () => {
  it('opens a sketch and makes no file until there is content', async () => {
    created.length = 0;
    await mount({ taskId: 't1' });
    // The App's list shows from the start; New drawing is in its head.
    expect(button('Hide drawings list')).not.toBeNull();
    const newButton = [...doc.querySelectorAll('button')].find((b) => b.textContent?.includes('New drawing')) as unknown as HTMLButtonElement;
    await act(async () => { newButton.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('click', { bubbles: true })); });
    await flush();
    expect(created).toHaveLength(0);
    expect(doc.querySelector('.drawing-workspace')!.getAttribute('data-save-state')).toBe('sketch');
    expect(doc.querySelector('.fake-editor')).not.toBeNull();
  });

  it('starts its editor empty when a drawing with shapes was open (never the old shapes as the new content)', async () => {
    created.length = 0;
    h.mountedWith.length = 0;
    await mount({ documentPath: 'Inbox/sketched.excalidraw' });
    expect(h.mountedWith).toEqual([1]);
    const newButton = [...doc.querySelectorAll('button')].find((b) => b.textContent?.includes('New drawing')) as unknown as HTMLButtonElement;
    await act(async () => { newButton.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('click', { bubbles: true })); });
    await flush();
    expect(doc.querySelector('.drawing-workspace')!.getAttribute('data-save-state')).toBe('sketch');
    // Every editor mounted started with its own source's scene: the file's one shape, then none.
    expect(h.mountedWith).toEqual([1, 0]);
    expect(created).toHaveLength(0);
  });

  it('stays a new sketch when the App writes the drawing it showed into its address a moment later', async () => {
    created.length = 0;
    h.lastDocument = 'Inbox/sketched.excalidraw';
    try {
      // The App: the workspace reports the file it shows, the address takes it a little later, and
      // the address is the workspace's documentPath.
      function Host() {
        const [path, setPath] = useState<string | undefined>(undefined);
        return createElement(DrawingWorkspace, { api, documentPath: path, onDocumentPathChange: (p: string | null) => { setTimeout(() => setPath(p ?? undefined), 40); } });
      }
      const el = doc.getElementById('pane')!;
      root = createRoot(el as unknown as Element) as unknown as typeof root;
      await act(async () => { root!.render(createElement(Host)); });
      await flush();
      expect(doc.querySelector('.drawing-workspace')!.getAttribute('data-drawing-path')).toBe('Inbox/sketched.excalidraw');
      const newButton = [...doc.querySelectorAll('button')].find((b) => b.textContent?.includes('New drawing')) as unknown as HTMLButtonElement;
      await act(async () => { newButton.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('click', { bubbles: true })); });
      await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
      await flush();
      expect(doc.querySelector('.drawing-workspace')!.getAttribute('data-save-state')).toBe('sketch');
      expect(created).toHaveLength(0);
    } finally {
      h.lastDocument = '';
    }
  });
});
