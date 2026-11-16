/**
 * "Make a diagram" and "Text to diagram": where the server's answer goes on the canvas, and how
 * it is added. Pure (no editor import), so tests/web/drawing-diagram.test.ts checks it in node.
 *
 * The answer is a diagram with (0,0) at its top left (src/core/drawings, POST /api/drawings/diagram).
 * It goes to the RIGHT of what it was made from, a gap apart, top edges aligned; from text, or
 * from an empty canvas, it goes to the middle of what is on screen. It is added as ONE update the
 * editor records for undo (one Ctrl/Cmd+Z takes it out), selected and scrolled into view. The
 * shapes it was made from are never moved, changed or removed.
 */

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

type Shape = Record<string, unknown>;

/** Space between the source and the diagram made from it, in scene pixels. */
export const DIAGRAM_GAP = 80;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The box around shapes (a line or arrow by its points); null for none. */
export function boundsOf(elements: readonly Shape[]): Bounds | null {
  let b: Bounds | null = null;
  const take = (x: number, y: number) => {
    if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
    else { b.minX = Math.min(b.minX, x); b.minY = Math.min(b.minY, y); b.maxX = Math.max(b.maxX, x); b.maxY = Math.max(b.maxY, y); }
  };
  for (const el of elements) {
    if (el.isDeleted === true) continue;
    const x = num(el.x);
    const y = num(el.y);
    if (Array.isArray(el.points) && el.points.length) {
      for (const p of el.points) if (Array.isArray(p)) take(x + num(p[0]), y + num(p[1]));
    } else {
      take(x, y);
      take(x + num(el.width), y + num(el.height));
    }
  }
  return b;
}

export interface Viewport { scrollX: number; scrollY: number; zoom: number; width: number; height: number }

/** The middle of what is on screen, in scene coordinates. */
export function viewportCenter(v: Viewport): { x: number; y: number } {
  const zoom = v.zoom > 0 ? v.zoom : 1;
  return { x: v.width / 2 / zoom - v.scrollX, y: v.height / 2 / zoom - v.scrollY };
}

/** Where the diagram's top left goes: right of `source`, or centred on screen without one. */
export function diagramOrigin(source: Bounds | null, result: Bounds, viewport: Viewport): { x: number; y: number } {
  if (source) return { x: source.maxX + DIAGRAM_GAP, y: source.minY };
  const c = viewportCenter(viewport);
  return { x: c.x - (result.maxX - result.minX) / 2, y: c.y - (result.maxY - result.minY) / 2 };
}

/** Copies moved by (dx, dy); the originals are left as they are. */
export function shiftElements<T extends Shape>(elements: readonly T[], dx: number, dy: number): T[] {
  return elements.map((el) => ({ ...el, x: num(el.x) + dx, y: num(el.y) + dy }));
}

/** What `applyDiagram` needs from the editor (ExcalidrawImperativeAPI has it). */
export interface DiagramEditor {
  getSceneElements(): readonly Shape[];
  updateScene(update: { elements: readonly Shape[]; appState: Record<string, unknown>; captureUpdate: unknown }): void;
  scrollToContent(elements: readonly Shape[], opts: { animate?: boolean; fitToViewport?: boolean; viewportZoomFactor?: number; maxZoom?: number }): void;
}

/**
 * Add the converted diagram (the editor's own elements) beside `source` in one recorded update,
 * select it and bring it into view. Returns the ids added.
 */
export function applyDiagram(editor: DiagramEditor, converted: readonly Shape[], source: Bounds | null, viewport: Viewport, captureUpdate: unknown): string[] {
  const result = boundsOf(converted);
  if (!result || !converted.length) return [];
  const origin = diagramOrigin(source, result, viewport);
  const added = shiftElements(converted, origin.x - result.minX, origin.y - result.minY);
  const selected: Record<string, true> = {};
  for (const el of added) if (typeof el.id === 'string' && !el.containerId) selected[el.id] = true;
  editor.updateScene({
    elements: [...editor.getSceneElements(), ...added],
    appState: { selectedElementIds: selected, selectedGroupIds: {} },
    captureUpdate,
  });
  // The whole diagram in view: zoomed out when it is bigger than the screen, never zoomed in.
  editor.scrollToContent(added, { animate: true, fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: viewport.zoom });
  return added.flatMap((el) => (typeof el.id === 'string' ? [el.id] : []));
}

/** Of the live shapes, the selected ones and the text and files to send (nothing selected: all of them). */
export function diagramSource(elements: readonly Shape[], selectedIds: Record<string, unknown>, files: Record<string, unknown>) {
  const live = elements.filter((el) => el.isDeleted !== true);
  const ids = new Set(Object.keys(selectedIds).filter((id) => selectedIds[id]));
  const picked = ids.size ? live.filter((el) => ids.has(String(el.id)) || (typeof el.containerId === 'string' && ids.has(el.containerId))) : live;
  const used: Record<string, unknown> = {};
  for (const el of picked) if (el.type === 'image' && typeof el.fileId === 'string' && files[el.fileId]) used[el.fileId] = files[el.fileId];
  return { elements: picked, files: used, selected: ids.size > 0, bounds: boundsOf(picked) };
}
