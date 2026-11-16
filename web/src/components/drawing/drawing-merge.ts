/**
 * Three-way merge of a drawing, element by element, for a save that met a change made elsewhere
 * (a 409: an agent rewrote a label while the person drew).
 *
 *   base   = the scene the last save (or load) left on the server
 *   mine   = what is on screen
 *   theirs = what the server holds now
 *
 * An element is changed on a side when it was added, deleted, or its version (and nonce) moved
 * since base; an element without a version is compared by its whole value. For each id: only one
 * side changed it, take that side (a deletion included); neither, keep it; both, and to the same
 * version, keep it; both, differently, is a real conflict, settled by `prefer` (the person's
 * Keep mine or Use theirs), or reported when nothing is preferred. Order: theirs, then what only
 * mine added, in mine's order. View settings: mine when mine changed them, else theirs.
 */
import type { DrawingElement, DrawingScene } from './drawing-scene';

export interface DrawingMerge {
  scene: DrawingScene;
  /** Ids changed on both sides to different versions. */
  conflicts: string[];
}

function versionOf(el: DrawingElement): string {
  return el.version !== undefined ? `${el.version}:${el.versionNonce ?? ''}` : `json:${JSON.stringify(el)}`;
}

function changed(side: DrawingElement | undefined, base: DrawingElement | undefined): boolean {
  if (!side || !base) return side !== base;
  return versionOf(side) !== versionOf(base);
}

function byId(scene: DrawingScene): Map<string, DrawingElement> {
  return new Map(scene.elements.map((el) => [el.id, el]));
}

export function mergeScenes(base: DrawingScene, mine: DrawingScene, theirs: DrawingScene, prefer?: 'mine' | 'theirs'): DrawingMerge {
  const b = byId(base);
  const m = byId(mine);
  const t = byId(theirs);
  const conflicts: string[] = [];
  const pick = (id: string): DrawingElement | undefined => {
    const be = b.get(id);
    const me = m.get(id);
    const te = t.get(id);
    const mineMoved = changed(me, be);
    const theirsMoved = changed(te, be);
    if (mineMoved && !theirsMoved) return me;
    if (!mineMoved) return te;
    // Both moved: the same result on both sides is no conflict.
    if (!me && !te) return undefined;
    if (me && te && versionOf(me) === versionOf(te)) return te;
    conflicts.push(id);
    return prefer === 'mine' ? me : te;
  };
  const elements: DrawingElement[] = [];
  for (const el of theirs.elements) {
    const chosen = pick(el.id);
    if (chosen) elements.push(chosen);
  }
  for (const el of mine.elements) {
    if (t.has(el.id)) continue;
    const chosen = pick(el.id);
    if (chosen) elements.push(chosen);
  }
  // What mine deleted that theirs also deleted, or that theirs never had, is gone already; an id
  // only in base that both dropped needs nothing.
  const appState = JSON.stringify(mine.appState) !== JSON.stringify(base.appState) ? mine.appState : theirs.appState;
  const files: DrawingScene['files'] = {};
  for (const el of elements) {
    const id = el.type === 'image' && typeof el.fileId === 'string' ? el.fileId : null;
    const file = id ? (mine.files[id] ?? theirs.files[id]) : undefined;
    if (id && file) files[id] = file;
  }
  return {
    scene: { type: 'excalidraw', version: 2, source: 'walnut', elements, appState, files, ...(theirs.extra ? { extra: theirs.extra } : {}) },
    conflicts,
  };
}
