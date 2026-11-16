/**
 * The drawing file's scene, as Walnut stores it (the editor's own JSON format):
 *   { type: 'excalidraw', version: 2, source: 'walnut', elements, appState, files }
 * Pure functions only, no editor import: the heavy editor loads on demand
 * (ExcalidrawCanvas.tsx), and everything here runs in node tests too. What a new scene holds and
 * which words it shows come from the module the server uses (src/core/drawings/scene-text.ts).
 */
import { emptySceneValue, sceneText as sceneWords } from '../../../../src/core/drawings/scene-text';

export interface DrawingElement {
  id: string;
  type: string;
  version?: number;
  versionNonce?: number;
  isDeleted?: boolean;
  text?: string;
  fileId?: string | null;
  [key: string]: unknown;
}

export interface DrawingBinaryFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created?: number;
  [key: string]: unknown;
}

export interface DrawingScene {
  type: 'excalidraw';
  version: 2;
  source: 'walnut';
  elements: DrawingElement[];
  appState: Record<string, unknown>;
  files: Record<string, DrawingBinaryFile>;
  /** Top-level keys this editor does not know, written back as they were read. */
  extra?: Record<string, unknown>;
}

/** One drawing file, as the server answers it. */
export interface DrawingDocument {
  path: string;
  title: string;
  revision: string;
  scene: DrawingScene;
  /** The scene was saved, but its Notes entry (the companion note) was not updated; a read retries it. */
  indexWarning?: string;
}

export interface DrawingListItem {
  path: string;
  title: string;
  updatedAt: string;
  taskId?: string;
}

/**
 * The view settings a file keeps. Scroll and zoom are left out on purpose: panning
 * must never count as an edit, or every pan would save a new revision.
 */
export const KEPT_APP_STATE = ['viewBackgroundColor', 'gridSize', 'gridStep', 'gridModeEnabled'] as const;

export function emptyScene(): DrawingScene {
  return parseScene(emptySceneValue())!;
}

const SCENE_KEYS = new Set(['type', 'version', 'source', 'elements', 'appState', 'files']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isElement(value: unknown): value is DrawingElement {
  return isRecord(value) && typeof value.id === 'string' && !!value.id && typeof value.type === 'string' && !!value.type;
}

function keptAppState(appState: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(appState)) return out;
  for (const key of KEPT_APP_STATE) if (appState[key] !== undefined && appState[key] !== null) out[key] = appState[key];
  return out;
}

/** Live image elements name the files the scene needs; the rest are dropped. */
function usedFiles(elements: readonly DrawingElement[], files: unknown): Record<string, DrawingBinaryFile> {
  const out: Record<string, DrawingBinaryFile> = {};
  if (!isRecord(files)) return out;
  for (const el of elements) {
    const id = el.type === 'image' && typeof el.fileId === 'string' ? el.fileId : null;
    const file = id ? files[id] : undefined;
    if (id && isRecord(file) && typeof file.dataURL === 'string') out[id] = file as DrawingBinaryFile;
  }
  return out;
}

/**
 * A scene read from the server or a draft, checked: null when it is not one (no elements list,
 * an element without an id or a type, a files or appState field that is not an object). A
 * broken file must read as broken, never as an empty drawing that the next save writes over.
 * Deleted elements are dropped. Its whole appState and any unknown top-level keys are kept, so a
 * save writes back what this editor does not know (DrawingSync lays the editor's view settings
 * over them).
 */
export function parseScene(value: unknown): DrawingScene | null {
  if (!isRecord(value) || !Array.isArray(value.elements)) return null;
  if (value.type !== undefined && value.type !== 'excalidraw') return null;
  if (value.files !== undefined && !isRecord(value.files)) return null;
  if (value.appState !== undefined && value.appState !== null && !isRecord(value.appState)) return null;
  if (!value.elements.every(isElement)) return null;
  const elements = (value.elements as DrawingElement[]).filter((el) => el.isDeleted !== true);
  const extra: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) if (!SCENE_KEYS.has(key)) extra[key] = v;
  return {
    type: 'excalidraw', version: 2, source: 'walnut', elements,
    appState: isRecord(value.appState) ? { ...value.appState } : {},
    files: usedFiles(elements, value.files),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

/** The editor's scene with what it does not know from the loaded one: appState keys and top-level keys. */
export function withLoadedKeys(scene: DrawingScene, loaded: Pick<DrawingScene, 'appState' | 'extra'> | null): DrawingScene {
  if (!loaded) return scene;
  return {
    ...scene,
    appState: { ...loaded.appState, ...scene.appState },
    ...(loaded.extra ? { extra: loaded.extra } : {}),
  };
}

/** The scene as stored: the unknown top-level keys back at the top. */
export function sceneForStorage(scene: DrawingScene): Record<string, unknown> {
  const { extra, ...rest } = scene;
  return extra ? { ...extra, ...rest } : rest;
}

const cloneOf: <T>(value: T) => T = typeof structuredClone === 'function'
  ? (value) => structuredClone(value)
  : (value) => JSON.parse(JSON.stringify(value));

function versionKey(el: DrawingElement): string {
  return `${el.version ?? ''}:${el.versionNonce ?? ''}`;
}

/** Copies of the editor's elements, reused while an element's version is unchanged. */
export type ElementCopies = Map<string, { key: string; copy: DrawingElement }>;

/**
 * What the editor shows, as a scene to store: deleted elements and unused files dropped, each
 * element DEEP-copied. The editor mutates its element objects in place (a dragged point, a
 * moved arrow's bindings), and a save on its way must send what was there when it was taken.
 * `copies` (kept by the caller across changes) reuses the copy of an element whose version did
 * not move, so a stroke copies only the element being drawn.
 */
export function sceneFromEditor(elements: readonly unknown[], appState: unknown, files: unknown, copies?: ElementCopies): DrawingScene {
  const live: DrawingElement[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    if (!isElement(el) || el.isDeleted === true) continue;
    const key = versionKey(el);
    const cached = copies?.get(el.id);
    // Without a version there is nothing to tell an edit by: copy every time.
    const copy = cached && cached.key === key && el.version !== undefined ? cached.copy : cloneOf(el);
    copies?.set(el.id, { key, copy });
    seen.add(el.id);
    live.push(copy);
  }
  if (copies) for (const id of [...copies.keys()]) if (!seen.has(id)) copies.delete(id);
  return { type: 'excalidraw', version: 2, source: 'walnut', elements: live, appState: keptAppState(appState), files: usedFiles(live, files) };
}

function fingerprintOf(elements: readonly DrawingElement[], appState: Record<string, unknown>, files: Record<string, DrawingBinaryFile>): string {
  const parts = elements.map((el) => (typeof el.version === 'number'
    ? `${el.id}:${el.version}:${el.versionNonce ?? ''}`
    : `${el.id}:${JSON.stringify(el)}`));
  parts.push(`app:${JSON.stringify(appState)}`);
  // A file's id names its content (the editor never changes a file under the same id); the
  // length is a cheap second check for a store that did.
  parts.push(`files:${Object.keys(files).sort().map((id) => `${id}#${files[id].dataURL.length}`).join(',')}`);
  return parts.join('|');
}

/**
 * Equal for two scenes with the same content. Cheap enough for every editor change: an element
 * the editor touched has a new version; one without a version (written by an agent) is compared
 * by its whole value.
 */
export function sceneFingerprint(scene: DrawingScene): string {
  return fingerprintOf(scene.elements, scene.appState, scene.files);
}

/** `sceneFingerprint(sceneFromEditor(...))` without copying the elements: run on every editor change. */
export function editorFingerprint(elements: readonly unknown[], appState: unknown, files: unknown): string {
  const live = elements.filter((el): el is DrawingElement => isElement(el) && el.isDeleted !== true);
  return fingerprintOf(live, keptAppState(appState), usedFiles(live, files));
}

/**
 * The editor's first report after a scene was loaded into it is that scene in the editor's own
 * form (defaults filled in), not an edit, when it holds the same elements in the same order at
 * the same versions (an element loaded without a version may get one). Anything else, even as
 * the very first report, is the person's edit and is saved.
 */
export function isEditorFormOf(loaded: DrawingScene, shown: DrawingScene): boolean {
  if (loaded.elements.length !== shown.elements.length) return false;
  for (let i = 0; i < loaded.elements.length; i++) {
    const a = loaded.elements[i];
    const b = shown.elements[i];
    if (a.id !== b.id || a.type !== b.type) return false;
    if (a.version !== undefined && (a.version !== b.version || (a.versionNonce !== undefined && a.versionNonce !== b.versionNonce))) return false;
  }
  return JSON.stringify(loaded.appState) === JSON.stringify(shown.appState)
    && Object.keys(loaded.files).sort().join(',') === Object.keys(shown.files).sort().join(',');
}

export function sceneElementCount(scene: DrawingScene): number {
  return scene.elements.length;
}

/** The words on the drawing, top to bottom, for an agent reading what the person sees. */
export function sceneText(scene: DrawingScene): string {
  return sceneWords(scene).join('\n');
}

export function sceneHasContent(scene: DrawingScene | null | undefined): boolean {
  return !!scene && scene.elements.length > 0;
}

/** A file name for an export, from the drawing's title. */
export function exportFileName(title: string, ext: 'png' | 'svg'): string {
  // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
  const base = title.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'drawing';
  return `${base}.${ext}`;
}

/**
 * A server answer (or a 409's `current`) as a document; null when it is not one, including a
 * document whose scene does not parse.
 */
export function documentFrom(value: unknown): DrawingDocument | null {
  if (!isRecord(value)) return null;
  const source = isRecord(value.current) ? value.current : value;
  if (typeof source.path !== 'string' || !source.path) return null;
  if (typeof source.revision !== 'string' && typeof source.revision !== 'number') return null;
  const scene = parseScene(source.scene);
  if (!scene) return null;
  return {
    path: source.path,
    title: typeof source.title === 'string' && source.title.trim() ? source.title : 'Untitled drawing',
    revision: String(source.revision),
    scene,
    ...(typeof source.indexWarning === 'string' && source.indexWarning.trim() ? { indexWarning: source.indexWarning } : {}),
  };
}

/** A drawing's name is at most this long when Walnut picks it from the words on it. */
export const TITLE_MAX = 60;

/**
 * The words of the first text on the drawing, as typed: the text element nearest the top, then
 * the left (the order the companion note reads). Empty when there is none.
 */
export function firstText(scene: DrawingScene | null | undefined): string {
  if (!scene) return '';
  let best: { x: number; y: number; text: string } | null = null;
  for (const el of scene.elements) {
    if (el.type !== 'text' || el.isDeleted === true) continue;
    const raw = typeof el.originalText === 'string' && el.originalText ? el.originalText : el.text;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const x = Number(el.x) || 0;
    const y = Number(el.y) || 0;
    if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y, text: raw };
  }
  return best?.text ?? '';
}

/** The first non-empty line of the first text, trimmed, at most TITLE_MAX characters. */
export function firstTextLine(scene: DrawingScene | null | undefined): string {
  const line = firstText(scene).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return [...line].slice(0, TITLE_MAX).join('').trim();
}

/** How the file got its name: 'auto' (Walnut picked it, it may follow the first text) or 'set'. */
export function titleMode(scene: DrawingScene | null | undefined): 'auto' | 'set' | null {
  const mode = scene?.appState.walnutTitle;
  return mode === 'auto' || mode === 'set' ? mode : null;
}

/**
 * The name an automatic rename should give the drawing now, or null for none: only a name Walnut
 * picked ('auto', never one a person set), only from a first text line, and only when it differs.
 */
export function autoRenameTitle(scene: DrawingScene | null | undefined, currentTitle: string): string | null {
  if (titleMode(scene) !== 'auto') return null;
  const line = firstTextLine(scene);
  if (!line || line === currentTitle.trim()) return null;
  return line;
}
