/**
 * The drawing's chrome rules, pure: the composer dialog's outside press (down AND up outside),
 * the full screen shortcut and the ancestors full screen lifts, where a diagram goes and that it
 * is added as one undoable update, the auto-rename decision, and where a composer's Draw saves.
 */
import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { OutsidePress, FULLSCREEN_Z, isFullscreenShortcut, liftFixedAncestors } from '../../web/src/components/drawing/drawing-overlay';
import { DIAGRAM_GAP, applyDiagram, boundsOf, diagramOrigin, diagramSource, type DiagramEditor } from '../../web/src/components/drawing/drawing-diagram';
import { autoRenameTitle, firstTextLine, parseScene } from '../../web/src/components/drawing/drawing-scene';
import { composerDrawing, drawingPlace } from '../../web/src/components/chat/drawing-place';

describe('a press outside the composer dialog', () => {
  it('closes only when it began and ended outside', () => {
    const p = new OutsidePress();
    p.down(true); expect(p.up(true)).toBe(true);
    // A stroke from the canvas that ends outside, a selection dragged out.
    p.down(false); expect(p.up(true)).toBe(false);
    // Began outside, released over the dialog.
    p.down(true); expect(p.up(false)).toBe(false);
    // A press is used once; a cancelled one closes nothing.
    expect(p.up(true)).toBe(false);
    p.down(true); p.cancel(); expect(p.up(true)).toBe(false);
  });
});

describe('full screen', () => {
  it('Ctrl or Cmd with Shift and F toggles it; nothing else does', () => {
    const k = (o: Partial<{ key: string; code: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }>) => ({ key: 'F', code: 'KeyF', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, ...o });
    expect(isFullscreenShortcut(k({ metaKey: true }))).toBe(true);
    expect(isFullscreenShortcut(k({ ctrlKey: true }))).toBe(true);
    expect(isFullscreenShortcut(k({}))).toBe(false);
    expect(isFullscreenShortcut(k({ metaKey: true, shiftKey: false }))).toBe(false);
    expect(isFullscreenShortcut(k({ metaKey: true, altKey: true }))).toBe(false);
    expect(isFullscreenShortcut(k({ metaKey: true, key: 'g', code: 'KeyG' }))).toBe(false);
  });

  it('lifts every ancestor that would hold, cut or cover the drawing, and puts back exactly what was there', () => {
    const { document } = parseHTML('<html><body><div id="glass" style="color: red"><div id="clip"><div id="plain"><div id="stack"><div id="ws"></div></div></div></div></div></body></html>');
    (globalThis as { document?: unknown }).document = document;
    const base = { position: 'static', overflowX: 'visible', overflowY: 'visible', transform: 'none', perspective: 'none', filter: 'none', backdropFilter: 'none', contain: 'none', willChange: 'auto', containerType: 'normal', contentVisibility: 'visible', clipPath: 'none', mask: 'none', zIndex: 'auto', isolation: 'auto' };
    const styles: Record<string, Partial<typeof base>> = {
      glass: { backdropFilter: 'blur(20px)' },
      clip: { clipPath: 'inset(0px)', isolation: 'isolate' },
      plain: {},
      stack: { position: 'relative', zIndex: '2' },
    };
    const styleOf = (el: Element) => ({ ...base, ...(styles[el.id] ?? {}) });
    const ws = document.getElementById('ws') as unknown as HTMLElement;
    const glass = document.getElementById('glass') as unknown as HTMLElement;
    const clip = document.getElementById('clip') as unknown as HTMLElement;
    const plain = document.getElementById('plain') as unknown as HTMLElement;
    const stack = document.getElementById('stack') as unknown as HTMLElement;
    const undo = liftFixedAncestors(ws, styleOf);
    expect(glass.style.getPropertyValue('backdrop-filter') || '').toBe('none');
    expect(clip.style.getPropertyValue('clip-path') || '').toBe('none');
    expect(clip.style.getPropertyValue('isolation') || '').toBe('auto');
    expect(stack.style.getPropertyValue('z-index') || '').toBe(String(FULLSCREEN_Z));
    expect(plain.getAttribute('style') ?? '').toBe('');
    undo();
    expect(glass.style.getPropertyValue('color') || '').toBe('red');
    expect(glass.style.getPropertyValue('backdrop-filter') || '').toBe('');
    expect(clip.style.getPropertyValue('clip-path') || '').toBe('');
    expect(stack.style.getPropertyValue('z-index') || '').toBe('');
  });
});

describe('a diagram goes beside what it was made from, as one undoable update', () => {
  const viewport = { scrollX: 0, scrollY: 0, zoom: 1, width: 1000, height: 600 };

  it('measures lines by their points', () => {
    expect(boundsOf([{ x: 10, y: 10, points: [[0, 0], [-5, 40]] }, { x: 100, y: 0, width: 20, height: 5 }])).toEqual({ minX: 5, minY: 0, maxX: 120, maxY: 50 });
  });

  it('places it right of the source with a gap, top aligned; without one, mid-screen', () => {
    const source = { minX: 100, minY: 50, maxX: 400, maxY: 300 };
    const result = { minX: 0, minY: 0, maxX: 200, maxY: 100 };
    expect(diagramOrigin(source, result, viewport)).toEqual({ x: 400 + DIAGRAM_GAP, y: 50 });
    expect(diagramOrigin(null, result, { ...viewport, scrollX: -100, zoom: 2 })).toEqual({ x: 250 + 100 - 100, y: 150 - 50 });
  });

  it('adds the shapes in ONE recorded update, selected and scrolled to, and never touches the originals', () => {
    const original = [
      { id: 'order', type: 'text', x: 0, y: 0, width: 60, height: 20, text: 'Order' },
      { id: 'arrow', type: 'arrow', x: 70, y: 10, points: [[0, 0], [120, 0]] },
      { id: 'review', type: 'text', x: 200, y: 0, width: 80, height: 20, text: 'review' },
    ];
    const frozen = JSON.parse(JSON.stringify(original));
    const updates: Array<Parameters<DiagramEditor['updateScene']>[0]> = [];
    const scrolled: Array<Parameters<DiagramEditor['scrollToContent']>[1]> = [];
    const editor: DiagramEditor = {
      getSceneElements: () => original,
      updateScene: (u) => updates.push(u),
      scrollToContent: (_els, opts) => scrolled.push(opts),
    };
    const converted = [
      { id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 40 },
      { id: 'label', type: 'text', x: 10, y: 10, width: 80, height: 20, containerId: 'box' },
    ];
    const src = diagramSource(original, {}, {});
    expect(src.selected).toBe(false);
    const added = applyDiagram(editor, converted, src.bounds, viewport, 'IMMEDIATELY');
    expect(added).toEqual(['box', 'label']);
    expect(updates).toHaveLength(1);
    expect(updates[0].captureUpdate).toBe('IMMEDIATELY');
    expect(updates[0].elements.slice(0, 3)).toEqual(frozen);
    expect(updates[0].elements[3]).toMatchObject({ id: 'box', x: 280 + DIAGRAM_GAP, y: 0 });
    expect(updates[0].elements[4]).toMatchObject({ id: 'label', x: 290 + DIAGRAM_GAP, y: 10 });
    // The container is selected, its label goes with it.
    expect(updates[0].appState.selectedElementIds).toEqual({ box: true });
    // Brought into view whole: zoomed out to fit when needed, never zoomed in past the view's zoom.
    expect(scrolled).toEqual([expect.objectContaining({ fitToViewport: true, maxZoom: viewport.zoom })]);
    expect(original).toEqual(frozen);
  });

  it('sends the selection with its labels and pictures; nothing selected sends everything', () => {
    const els = [
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
      { id: 'a-label', type: 'text', x: 1, y: 1, width: 5, height: 5, containerId: 'a' },
      { id: 'img', type: 'image', x: 50, y: 0, width: 10, height: 10, fileId: 'f1' },
      { id: 'gone', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, isDeleted: true },
    ];
    const picked = diagramSource(els, { a: true, img: true }, { f1: { id: 'f1' }, f2: { id: 'f2' } });
    expect(picked.elements.map((e) => e.id)).toEqual(['a', 'a-label', 'img']);
    expect(Object.keys(picked.files)).toEqual(['f1']);
    expect(diagramSource(els, {}, {}).elements).toHaveLength(3);
  });
});

describe('the name Walnut picks', () => {
  const scene = (walnutTitle: string | undefined, ...texts: Array<[string, number, number]>) => parseScene({
    elements: texts.map(([text, x, y], i) => ({ id: `t${i}`, type: 'text', x, y, text, originalText: text })),
    appState: walnutTitle ? { walnutTitle } : {},
  });

  it('is the first non-empty line of the top-left text, at most 60 characters', () => {
    expect(firstTextLine(scene('auto', ['lower', 0, 100], ['\n  Design a   system \nmore', 50, 10]))).toBe('Design a system');
    expect(firstTextLine(scene('auto', ['x'.repeat(80), 0, 0]))).toHaveLength(60);
    expect(firstTextLine(scene('auto'))).toBe('');
  });

  it('renames only an auto name, only to a text line, only when it differs', () => {
    expect(autoRenameTitle(scene('auto', ['Plan', 0, 0]), 'Drawing 2026-11-16 10.00')).toBe('Plan');
    expect(autoRenameTitle(scene('auto', ['Plan', 0, 0]), 'Plan')).toBeNull();
    expect(autoRenameTitle(scene('set', ['Plan', 0, 0]), 'Mine')).toBeNull();
    expect(autoRenameTitle(scene(undefined, ['Plan', 0, 0]), 'Old')).toBeNull();
    expect(autoRenameTitle(scene('auto'), 'Old')).toBeNull();
  });
});

describe("where a composer's Draw saves", () => {
  it('uses an explicit target, then the composer’s own task and session, then its file target', () => {
    expect(drawingPlace({ drawingTarget: { sessionId: 's-main' } })).toEqual({ sessionId: 's-main' });
    expect(drawingPlace({ mentionSelfTaskId: 't1', sessionMentionSelfId: 's1' })).toEqual({ taskId: 't1', sessionId: 's1' });
    // A composer that only uploads files to a session (the dock, a plan popover) still draws there.
    expect(drawingPlace({ fileTarget: { sessionId: 's2' } })).toEqual({ sessionId: 's2' });
    expect(drawingPlace({ drawingTarget: { taskId: 't9', sessionId: 's9' }, sessionMentionSelfId: 's1' })).toEqual({ taskId: 't9', sessionId: 's9' });
    expect(drawingPlace({ fileTarget: {} })).toEqual({});
  });

  // 2026-11-20, the user: "each session has its own drawing open by default".
  it("each session's Draw is its own: two sessions never share a drawing draft", () => {
    const a = composerDrawing(undefined, { mentionSelfTaskId: 't1', sessionMentionSelfId: 's1' });
    const b = composerDrawing(undefined, { mentionSelfTaskId: 't2', sessionMentionSelfId: 's2' });
    expect(a).toEqual({ taskId: 't1', sessionId: 's1', draftId: 's1' });
    expect(b.draftId).not.toBe(a.draftId);
    // The composer's own draft wins (one per session and thread); a task alone is its own too.
    expect(composerDrawing('draft:session:s1', { sessionMentionSelfId: 's1' }).draftId).toBe('draft:session:s1');
    expect(composerDrawing(undefined, { mentionSelfTaskId: 't3' }).draftId).toBe('task:t3');
    expect(composerDrawing(undefined, { mentionSelfTaskId: 't4' }).draftId).not.toBe(composerDrawing(undefined, { mentionSelfTaskId: 't3' }).draftId);
    expect(composerDrawing(undefined, { fileTarget: { sessionId: 's9' } }).draftId).toBe('s9');
  });
});

// Review 2026-11-20: a drawing gives its place only while its edits can come back.
describe('leaving a drawing for New drawing or another file', () => {
  it('lets a drawing in Notes go only when its file is there and this browser kept its edits', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../web/src/components/drawing/DrawingWorkspace.tsx', import.meta.url), 'utf8');
    const leave = src.slice(src.indexOf('const canLeave = async'), src.indexOf('const openFile = async'));
    expect(leave).toMatch(/if \(shown\.path && shown\.state !== 'missing' && shown\.state !== 'error'\) \{\s*controller\.flushDraft\(\);\s*if \(controller\.snapshot\(\)\.kept\) return true;/);
    // Its refusal answers the click over a conflict bar too.
    expect(src).toMatch(/\{\(notice \|\| \(snap\?\.error && !conflict/);
  });
});

