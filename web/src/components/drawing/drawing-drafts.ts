/**
 * The drafts a drawing keeps of what the server does not have yet, and how they are read.
 *
 * Kept in this tab's store (drawing-store.ts), never in the shared draft store:
 *   file:<path>       { v: 1, baseRevision, scene }                 unsaved edits of a file
 *   sketch:<draftId>  { v: 1, scene, path?, baseRevision?, createId? } a sketch not on the server yet
 *                     { v: 1, path }                                 the file this draft drew
 * `createId` is the id of the create that makes the sketch's file: a create sent again (after a
 * reload, or a retry whose first answer was lost) gets the file the first one made.
 * One that does not parse is moved aside (`<key>:unreadable`), never overwritten and never read
 * as an empty drawing.
 */
import { parseScene, sceneHasContent, type DrawingScene } from './drawing-scene';

export interface DraftStore {
  read(key: string): string;
  write(key: string, text: string): void;
  /** Take over the draft of `key` that a tab which is gone left behind (drawing-store.ts), if there is one. */
  adopt?(key: string): void;
}

export function fileDraftKey(path: string): string { return `file:${path}`; }
export function sketchDraftKey(draftId: string): string { return `sketch:${draftId}`; }
/** The sketch "New drawing" starts in one place (the App, a pane) that has no composer draft. */
export function newSketchKey(placeId: string): string { return sketchDraftKey(`new:${placeId}`); }

/** A sketch kept under `key` that is not in Notes yet (a reload brings it back). */
export function hasUnsavedSketch(store: DraftStore, key: string): boolean {
  store.adopt?.(key);
  const raw = store.read(key);
  const value = raw ? parseJson(raw) : null;
  const draft = value ? parseSketchDraft(value) : null;
  return !!draft?.scene && sceneHasContent(draft.scene);
}

export type FileDraft = { baseRevision: string; scene: DrawingScene };
export type SketchDraft = { path?: string; baseRevision?: string; scene?: DrawingScene; createId?: string };

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/** Reads a draft; one that does not parse is moved aside and reported. */
export function readDraftOf<T>(store: DraftStore, key: string, parse: (v: Record<string, unknown>) => T | null): { draft: T | null; unreadable: boolean } {
  const raw = store.read(key);
  if (!raw) return { draft: null, unreadable: false };
  const value = parseJson(raw);
  const draft = value ? parse(value) : null;
  if (draft) return { draft, unreadable: false };
  store.write(`${key}:unreadable`, raw);
  store.write(key, '');
  return { draft: null, unreadable: true };
}

export function parseFileDraft(v: Record<string, unknown>): FileDraft | null {
  const scene = parseScene(v.scene);
  return typeof v.baseRevision === 'string' && scene ? { baseRevision: v.baseRevision, scene } : null;
}

export function parseSketchDraft(v: Record<string, unknown>): SketchDraft | null {
  if (v.path !== undefined && (typeof v.path !== 'string' || !v.path)) return null;
  if (v.baseRevision !== undefined && typeof v.baseRevision !== 'string') return null;
  const scene = v.scene === undefined ? undefined : parseScene(v.scene);
  if (scene === null) return null;
  if (!v.path && !scene) return null;
  // An id of the wrong shape only costs the retry its guard: the draft itself is still read.
  const createId = typeof v.createId === 'string' && v.createId ? v.createId : undefined;
  return {
    ...(v.path ? { path: v.path as string } : {}),
    ...(v.baseRevision ? { baseRevision: v.baseRevision as string } : {}),
    ...(scene ? { scene } : {}),
    ...(createId ? { createId } : {}),
  };
}

/**
 * A sketch draft whose drawing is already in Notes lets go of its place (New drawing, another
 * file opening there): its unsaved edits move to that file's own draft, which shows them again
 * when the file opens (and asks, if the file changed since). Returns false, and moves nothing,
 * when it cannot be let go without losing words: no file yet, edits of an unknown revision, or
 * the file already keeping other unsaved edits.
 */
export function releaseSketchToFile(store: DraftStore, draft: SketchDraft): boolean {
  if (!draft.path) return false;
  if (!draft.scene) return true;
  if (!draft.baseRevision) return false;
  const key = fileDraftKey(draft.path);
  store.adopt?.(key);
  if (store.read(key)) return false;
  const text = JSON.stringify({ v: 1, baseRevision: draft.baseRevision, scene: draft.scene });
  store.write(key, text);
  return store.read(key) === text;
}
