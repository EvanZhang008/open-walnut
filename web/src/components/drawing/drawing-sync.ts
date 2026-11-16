/**
 * Keeps one drawing in step with where it is stored, independent of React and of the editor.
 *
 * A drawing is a FILE in Notes (`.excalidraw`, the drawings API). Two ways in:
 *  - `{ kind: 'file', path }`: an existing file (the App, a pane, a note's preview).
 *  - `{ kind: 'sketch', key }`: the composer's Draw for one draft. It starts empty; the first
 *    real content creates the file in the task (or session, or Inbox) and saves into it, so a
 *    drawing is in Notes without a Save press. The draft's key then points at that file, so the
 *    next Draw of the same draft opens it again; Attach lets go of it (the next Draw starts anew).
 *
 * Saving: a moment after each change, compare-and-set on the revision the edit started from.
 * What the server does not have yet waits in this tab's store (drawing-store.ts), never in the
 * shared draft store:
 *   file:<path>       { v: 1, baseRevision, scene }        unsaved edits of a file
 *   sketch:<draftId>  { v: 1, scene, path?, baseRevision? } a sketch not on the server yet
 *                     { v: 1, path }                        the file this draft drew
 * Reopening takes those back. One that does not parse is moved aside (`<key>:unreadable`), never
 * overwritten and never read as an empty drawing.
 *
 * A save that meets a change made elsewhere (409) merges element by element (drawing-merge.ts):
 * what only one side changed is kept from that side, and only shapes both sides changed are the
 * person's to settle (Keep mine, Use theirs, or Save mine as a copy). A 409 whose copy is exactly
 * what this save sent (an earlier try that timed out here but reached the server) is a success.
 *
 * Rules the tests pin (tests/web/drawing-sync.test.ts):
 *  - An edit made while a create, save or copy is on its way is kept and saved after it.
 *  - Nothing is overwritten quietly, and a refused save (too large, invalid) stops with the
 *    reason, keeping the drawing on screen and in the store; only a network failure is retried.
 *  - A change made elsewhere (an agent's update) is taken in only while nothing here is unsaved,
 *    and never as an undo step (ExcalidrawCanvas clears the history on such a load).
 *  - After `dispose()` the controller never reports again; its last save still finishes, and a
 *    controller opened on the same file (or draft) waits for it before reading.
 *  - A composer's sketch that is not in Notes yet keeps its draft: nothing else opens over it.
 */
import { ApiError } from '@/api/client';
import { DrawingConflictError, DrawingUnreadableError, isMissingDrawing, drawingErrorMessage, type DrawingApi } from './drawing-api';
import { mergeScenes } from './drawing-merge';
import { emptyScene, isEditorFormOf, parseScene, sceneFingerprint, sceneForStorage, sceneHasContent, withLoadedKeys, type DrawingDocument, type DrawingScene } from './drawing-scene';

/** `open`: the composer's Draw switches to this file (picked from the list, or New). */
export type DrawingSource = { kind: 'file'; path: string } | { kind: 'sketch'; key: string; open?: string };

export type DrawingSaveState =
  | 'loading'    // reading the file
  | 'sketch'     // the composer's Draw, nothing drawn yet
  | 'saved'      // the server has exactly what is on screen
  | 'unsaved'    // changed, a save is scheduled
  | 'saving'     // a create or save is on its way
  | 'offline'    // a save failed on the network; kept and retried
  | 'conflict'   // shapes changed here and elsewhere: the person decides
  | 'missing'    // the file is gone
  | 'error';     // the file could not be read, or a save was refused (the reason is in `error`)

export interface DrawingSnapshot {
  source: DrawingSource;
  /** The file shown (null: a sketch that is not a file yet). */
  path: string | null;
  title: string;
  revision: string | null;
  /** What the editor should show (null while loading). */
  scene: DrawingScene | null;
  /** Bumped whenever the editor must load `scene` (first load, a change elsewhere, a merge). */
  sceneKey: number;
  state: DrawingSaveState;
  /** The copy on the server, while in conflict. */
  conflict: DrawingDocument | null;
  /** How many shapes both sides changed (0 with a conflict: the whole drawing, no common base known). */
  conflictShapes: number;
  error: string | null;
  /** Saved, but the drawing's Notes entry was not updated (the server's indexWarning); `retryIndex()` asks again. */
  warning: string | null;
  /** What is on screen is not all on the server yet. */
  unsaved: boolean;
  /** The unsaved edits are in the store (false: a full or disabled store refused them). */
  kept: boolean;
}

export interface DraftStore {
  read(key: string): string;
  write(key: string, text: string): void;
}

export const SAVE_DELAY_MS = 800;
export const SAVE_MAX_WAIT_MS = 5_000;
export const DRAFT_DELAY_MS = 300;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000];
/** Answers that saving again cannot change: the scene is too large, or not one the server takes. */
const REFUSED = new Set([400, 403, 413, 422]);

export function fileDraftKey(path: string): string { return `file:${path}`; }
export function sketchDraftKey(draftId: string): string { return `sketch:${draftId}`; }

type FileDraft = { baseRevision: string; scene: DrawingScene };
type SketchDraft = { path?: string; baseRevision?: string; scene?: DrawingScene };

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/** Reads a draft; one that does not parse is moved aside and reported. */
function readDraftOf<T>(store: DraftStore, key: string, parse: (v: Record<string, unknown>) => T | null): { draft: T | null; unreadable: boolean } {
  const raw = store.read(key);
  if (!raw) return { draft: null, unreadable: false };
  const value = parseJson(raw);
  const draft = value ? parse(value) : null;
  if (draft) return { draft, unreadable: false };
  store.write(`${key}:unreadable`, raw);
  store.write(key, '');
  return { draft: null, unreadable: true };
}

function parseFileDraft(v: Record<string, unknown>): FileDraft | null {
  const scene = parseScene(v.scene);
  return typeof v.baseRevision === 'string' && scene ? { baseRevision: v.baseRevision, scene } : null;
}

function parseSketchDraft(v: Record<string, unknown>): SketchDraft | null {
  if (v.path !== undefined && (typeof v.path !== 'string' || !v.path)) return null;
  if (v.baseRevision !== undefined && typeof v.baseRevision !== 'string') return null;
  const scene = v.scene === undefined ? undefined : parseScene(v.scene);
  if (scene === null) return null;
  if (!v.path && !scene) return null;
  return { ...(v.path ? { path: v.path as string } : {}), ...(v.baseRevision ? { baseRevision: v.baseRevision as string } : {}), ...(scene ? { scene } : {}) };
}

export interface DrawingSyncOptions {
  api: DrawingApi;
  store: DraftStore;
  onChange: (snapshot: DrawingSnapshot) => void;
  /** Where a new file goes (the sketch's first content, Save mine as a copy). */
  scope?: { taskId?: string; sessionId?: string };
}

/** Saves still finishing for a controller that is gone, by file and by draft. */
const settling = new Map<string, Promise<void>>();

export class DrawingSync {
  private snap: DrawingSnapshot;
  private disposed = false;
  private path: string | null;
  private readonly sketchKey: string | null;
  /** A sketch's content has reached its file at least once. */
  private promoted = true;
  /** The revision the server holds, and the content the editor showed for it. */
  private base: { revision: string; fp: string } | null = null;
  /** That revision's scene, for a three-way merge (null: unknown, e.g. edits restored from an older revision). */
  private baseScene: DrawingScene | null = null;
  private local: DrawingScene | null = null;
  private localFp = '';
  /** The scene last loaded into the editor, until the editor's first report on it. */
  private loaded: { key: number; scene: DrawingScene } | null = null;
  /** What the loaded scene holds that the editor does not report (unknown appState and top-level keys). */
  private loadedKeys: Pick<DrawingScene, 'appState' | 'extra'> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private firstUnsavedAt = 0;
  private saving: Promise<void> | null = null;
  private again = false;
  private retries = 0;
  private refreshing = false;
  /** A refresh was asked for while a read or a save was out: run it once that ends. */
  private refreshAgain = false;

  constructor(readonly source: DrawingSource, private readonly opts: DrawingSyncOptions) {
    this.path = source.kind === 'file' ? source.path : null;
    this.sketchKey = source.kind === 'sketch' ? source.key : null;
    this.snap = {
      source, path: this.path, title: source.kind === 'file' ? '' : 'Sketch',
      revision: null, scene: null, sceneKey: 0, state: 'loading',
      conflict: null, conflictShapes: 0, error: null, warning: null, unsaved: false, kept: true,
    };
  }

  snapshot(): DrawingSnapshot { return this.snap; }

  /** A server answer's Notes-entry warning, never hidden: shown until an answer comes without one. */
  private warningOf(doc: DrawingDocument): string | null {
    return doc.indexWarning ? `Saved, but its Notes entry was not updated: ${doc.indexWarning}` : null;
  }

  private state(): DrawingSaveState { return this.snap.state; }

  private emit(patch: Partial<DrawingSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    if (!this.disposed) this.opts.onChange(this.snap);
  }

  /** On screen and not all on the server. */
  private get dirty(): boolean {
    if (!this.local) return false;
    if (!this.path) return sceneHasContent(this.local);
    if (!this.promoted) return true;
    return !!this.base && this.localFp !== this.base.fp;
  }

  private setBase(revision: string, scene: DrawingScene | null): void {
    this.base = { revision, fp: scene ? sceneFingerprint(scene) : '' };
    this.baseScene = scene;
  }

  private loadIntoEditor(scene: DrawingScene, patch: Partial<DrawingSnapshot>): void {
    this.local = scene;
    this.localFp = sceneFingerprint(scene);
    this.loadedKeys = { appState: scene.appState, ...(scene.extra ? { extra: scene.extra } : {}) };
    const sceneKey = this.snap.sceneKey + 1;
    this.loaded = { key: sceneKey, scene };
    this.emit({ ...patch, scene, sceneKey });
  }

  /** Read the source and show it. */
  async start(): Promise<void> {
    const waits = [this.path, this.sketchKey].map((k) => (k ? settling.get(k) : undefined)).filter(Boolean);
    if (waits.length) await Promise.all(waits);
    if (this.disposed) return;
    if (!this.sketchKey) { await this.openFile(null); return; }
    let refused: string | null = null;
    if (this.source.kind === 'sketch' && this.source.open) {
      // Written only now: a sketch left behind has finished writing its own draft. One that is
      // still not in Notes stays: nothing opens over it.
      const left = readDraftOf(this.opts.store, this.sketchKey, parseSketchDraft).draft;
      if (left?.scene) refused = 'This drawing is not in Notes yet, so it stays open here. Open the other one once it is saved.';
      else this.opts.store.write(this.sketchKey, JSON.stringify({ v: 1, path: this.source.open }));
    }
    const { draft, unreadable } = readDraftOf(this.opts.store, this.sketchKey, parseSketchDraft);
    const notice = refused ?? (unreadable ? 'An earlier sketch here could not be read. It was kept aside, unchanged.' : null);
    if (draft?.path) {
      this.path = draft.path;
      this.promoted = !draft.scene;
      await this.openFile(draft.scene ? { scene: draft.scene, baseRevision: draft.baseRevision ?? '' } : null, notice);
      return;
    }
    this.loadIntoEditor(draft?.scene ?? emptyScene(), { state: draft?.scene ? 'unsaved' : 'sketch', error: notice, unsaved: !!draft?.scene });
    if (draft?.scene) this.scheduleSave(0);
  }

  private async openFile(restored: FileDraft | null, notice: string | null = null): Promise<void> {
    const path = this.path!;
    let doc: DrawingDocument | null;
    try {
      doc = await this.opts.api.get(path);
    } catch (err) {
      if (this.disposed) return;
      if (isMissingDrawing(err) && this.sketchKey) {
        // The file this draft drew is gone: what was never saved there is still a sketch.
        this.path = null;
        this.promoted = true;
        this.base = null;
        this.baseScene = null;
        this.loadIntoEditor(restored?.scene ?? emptyScene(), { path: null, state: restored ? 'unsaved' : 'sketch', unsaved: !!restored, error: notice });
        this.flushDraftNow();
        if (restored) this.scheduleSave(0);
        return;
      }
      this.emit(isMissingDrawing(err)
        ? { state: 'missing', error: 'This drawing no longer exists.' }
        : { state: 'error', error: drawingErrorMessage(err) });
      return;
    }
    if (this.disposed || !doc) return;
    this.setBase(doc.revision, doc.scene);
    let fileNotice = notice;
    if (!restored) {
      const read = readDraftOf(this.opts.store, fileDraftKey(path), parseFileDraft);
      restored = read.draft;
      if (read.unreadable) fileNotice = 'Unsaved edits kept for this drawing could not be read. They were kept aside, unchanged.';
    }
    const header = { path, title: doc.title, revision: doc.revision, error: fileNotice, warning: this.warningOf(doc) };
    if (restored && (!this.promoted || sceneFingerprint(restored.scene) !== this.base!.fp)) {
      // Edits that never reached the server: shown, and saved against the revision they began
      // from. A file changed since then answers 409; with no copy of that revision to merge
      // against, the person decides.
      if (restored.baseRevision && restored.baseRevision !== doc.revision) this.setBase(restored.baseRevision, null);
      this.loadIntoEditor(restored.scene, { ...header, state: 'unsaved', unsaved: true });
      this.scheduleSave(0);
      return;
    }
    this.promoted = true;
    if (restored) this.opts.store.write(fileDraftKey(path), '');
    this.loadIntoEditor(doc.scene, { ...header, state: 'saved', unsaved: false });
  }

  /** The editor's scene changed. `sceneKey` is the load it shows. */
  edit(fromEditor: DrawingScene, sceneKey: number): void {
    if (this.disposed || sceneKey !== this.snap.sceneKey) return;
    const scene = withLoadedKeys(fromEditor, this.loadedKeys);
    const fp = sceneFingerprint(scene);
    const loaded = this.loaded?.key === sceneKey ? this.loaded.scene : null;
    this.loaded = null;
    if (loaded && isEditorFormOf(loaded, scene)) {
      // The editor's own form of what was loaded: the same drawing, not an edit.
      if (this.base && this.base.fp === this.localFp) {
        this.base = { ...this.base, fp };
        this.baseScene = scene;
      }
      this.local = scene;
      this.localFp = fp;
      return;
    }
    if (fp === this.localFp) return;
    this.local = scene;
    this.localFp = fp;
    this.scheduleDraftWrite();
    const state = this.state();
    if (!this.dirty) {
      // Back to exactly what the server has (undo to the saved state), or an emptied sketch.
      this.cancelSave();
      this.emit({ scene, unsaved: false, ...(state === 'unsaved' ? { state: this.path ? 'saved' as const : 'sketch' as const } : {}) });
      return;
    }
    const keep = state === 'conflict' || state === 'saving' || state === 'offline' || state === 'missing' || state === 'error';
    this.emit({ scene, unsaved: true, ...(keep ? {} : { state: 'unsaved' as const }) });
    if (state !== 'conflict' && state !== 'missing' && state !== 'error') this.scheduleSave();
  }

  private scheduleDraftWrite(): void {
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => { this.draftTimer = undefined; this.flushDraftNow(); }, DRAFT_DELAY_MS);
  }

  /** Write the unsaved edits to the store now (a reload, a close, a file switch). */
  flushDraft(): void {
    if (!this.disposed) this.flushDraftNow();
  }

  private flushDraftNow(): void {
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    if (!this.local) return;
    const { store } = this.opts;
    const scene = sceneForStorage(this.local);
    const writes: Array<[string, string]> = [];
    if (this.sketchKey && (!this.path || !this.promoted)) {
      const draft = sceneHasContent(this.local) || this.path
        ? { ...(this.path ? { path: this.path, baseRevision: this.base?.revision ?? '' } : {}), scene }
        : null;
      writes.push([this.sketchKey, draft ? JSON.stringify({ v: 1, ...draft }) : '']);
    } else if (this.path) {
      if (this.sketchKey) writes.push([this.sketchKey, JSON.stringify({ v: 1, path: this.path })]);
      writes.push([fileDraftKey(this.path), this.dirty && this.base ? JSON.stringify({ v: 1, baseRevision: this.base.revision, scene }) : '']);
    }
    let kept = true;
    for (const [key, text] of writes) {
      if (store.read(key) === text) continue;
      store.write(key, text);
      if (store.read(key) !== text) kept = false;
    }
    if (kept !== this.snap.kept) this.emit({ kept });
  }

  private cancelSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.firstUnsavedAt = 0;
  }

  private scheduleSave(delay = SAVE_DELAY_MS, exact = false): void {
    if (this.disposed) return;
    const now = Date.now();
    if (!this.firstUnsavedAt) this.firstUnsavedAt = now;
    // A long stroke still saves now and then, never only after the pen lifts.
    const wait = exact ? delay : Math.max(0, Math.min(delay, this.firstUnsavedAt + SAVE_MAX_WAIT_MS - now));
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.save(); }, wait);
  }

  /** Save now. Resolves when this save (and any edit made while it ran) is done. */
  save(): Promise<void> {
    if (this.saving) { this.again = true; return this.saving; }
    const run: Promise<void> = this.saveLoop().finally(() => {
      if (this.saving !== run) return;
      this.saving = null;
      // Asked for again in the moment the loop was ending.
      if (this.again) { this.again = false; void this.save(); }
      else if (this.refreshAgain) { this.refreshAgain = false; void this.refresh(); }
    });
    this.saving = run;
    return run;
  }

  private async saveLoop(): Promise<void> {
    do {
      this.again = false;
      const state = this.state();
      if (!this.local || state === 'conflict' || state === 'missing' || state === 'error' || state === 'loading') return;
      if (!this.dirty) {
        if (state === 'unsaved' || state === 'saving') this.emit({ state: this.path ? 'saved' : 'sketch', unsaved: false });
        return;
      }
      this.cancelSave();
      this.emit({ state: 'saving' });
      await this.saveOnce();
    } while (this.again);
  }

  /** A refused save (Try again), after the person changed what was refused. */
  retrySave(): Promise<void> {
    if (this.state() !== 'error' || !this.dirty) return Promise.resolve();
    this.emit({ state: 'unsaved', error: null });
    return this.save();
  }

  private failed(err: unknown): void {
    this.again = false;
    if (err instanceof DrawingConflictError) {
      this.emit({ state: 'conflict', conflict: err.current, conflictShapes: 0, error: null });
    } else if (err instanceof DrawingUnreadableError) {
      this.emit({ state: 'error', error: err.message });
    } else if (isMissingDrawing(err)) {
      this.emit({ state: 'missing', error: 'This drawing no longer exists. Save your drawing as a copy to keep it.' });
    } else if (err instanceof ApiError && REFUSED.has(err.status)) {
      this.emit({ state: 'error', error: `Not saved: ${drawingErrorMessage(err)} Your drawing is still here: export it, or change it and try again.` });
    } else {
      const delay = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)];
      this.retries++;
      this.emit({ state: 'offline', error: `Not saved: ${drawingErrorMessage(err)} Retrying.` });
      this.scheduleSave(delay, true);
    }
  }

  /** The server took `sent` (fingerprint `fp`) as `doc`. */
  private succeeded(doc: DrawingDocument, sent: DrawingScene, fp: string): void {
    this.retries = 0;
    this.base = { revision: doc.revision, fp };
    this.baseScene = sent;
    this.promoted = true;
    this.flushDraftNow();
    const patch = { revision: doc.revision, title: doc.title, error: null, warning: this.warningOf(doc) };
    if (this.dirty) {
      // Drawn while the save was on its way: those edits are saved next.
      this.emit({ ...patch, state: 'unsaved', unsaved: true });
      this.again = true;
    } else {
      this.emit({ ...patch, state: 'saved', unsaved: false });
    }
  }

  private async saveOnce(): Promise<void> {
    if (!this.path) {
      // The sketch's first content: its file is made in the task (or session, or Inbox).
      let doc: DrawingDocument;
      try {
        doc = await this.opts.api.create(this.opts.scope ?? {});
      } catch (err) {
        this.flushDraftNow();
        this.failed(err);
        return;
      }
      this.path = doc.path;
      this.promoted = false;
      this.setBase(doc.revision, doc.scene);
      // The draft remembers the new file before the save, so a reload never makes a second one.
      this.flushDraftNow();
      this.emit({ path: doc.path, title: doc.title, revision: doc.revision, warning: this.warningOf(doc) });
    }
    const path = this.path;
    // Taken now, not when the save was asked for: what was drawn while the file was made goes too.
    const scene = this.local!;
    const fp = this.localFp;
    const revision = this.base!.revision;
    try {
      this.succeeded(await this.opts.api.put(path, revision, scene), scene, fp);
    } catch (err) {
      if (err instanceof DrawingConflictError) { this.conflicted(err, revision, scene, fp); return; }
      this.flushDraftNow();
      this.failed(err);
    }
  }

  private conflicted(err: DrawingConflictError, revision: string, sent: DrawingScene, sentFp: string): void {
    const current = err.current;
    // An earlier try of this very save reached the server (its answer was lost here).
    if (sceneFingerprint(current.scene) === sentFp) { this.succeeded(current, sent, sentFp); return; }
    if (this.baseScene && this.base?.revision === revision && this.local) {
      const merged = mergeScenes(this.baseScene, this.local, current.scene);
      if (!merged.conflicts.length) {
        // Both sides kept: the merge goes on screen (not as an undo step) and is saved on theirs.
        this.setBase(current.revision, current.scene);
        this.loadIntoEditor(merged.scene, { revision: current.revision, title: current.title, state: 'unsaved', unsaved: true, error: null });
        this.flushDraftNow();
        this.again = true;
        return;
      }
      this.flushDraftNow();
      this.again = false;
      this.emit({ state: 'conflict', conflict: current, conflictShapes: merged.conflicts.length, error: null });
      return;
    }
    this.flushDraftNow();
    this.failed(err);
  }

  /** Take in a change made elsewhere, if nothing here is unsaved. */
  async refresh(): Promise<void> {
    if (this.disposed || this.dirty || !this.base || !this.path) return;
    // A change announced while a read or a save is out would otherwise wait for the next poll.
    if (this.refreshing || this.saving) { this.refreshAgain = true; return; }
    if (this.state() !== 'saved') return;
    this.refreshing = true;
    const known = this.base.revision;
    try {
      const doc = await this.opts.api.get(this.path, known);
      if (!doc || this.disposed || doc.revision === known) return;
      // Drawn here while the read was out, or saved meanwhile: the next save settles it.
      if (this.dirty || this.saving || !this.base || this.base.revision !== known) return;
      this.setBase(doc.revision, doc.scene);
      this.loadIntoEditor(doc.scene, { title: doc.title, revision: doc.revision, state: 'saved', unsaved: false, error: null, warning: this.warningOf(doc) });
    } catch (err) {
      if (this.disposed) return;
      if (isMissingDrawing(err)) this.emit({ state: 'missing', error: 'This drawing no longer exists.' });
      else if (err instanceof DrawingUnreadableError) this.emit({ state: 'error', error: err.message });
    } finally {
      this.refreshing = false;
      if (this.refreshAgain && !this.disposed) { this.refreshAgain = false; void this.refresh(); }
    }
  }

  /**
   * Read the file again so the server repairs its Notes entry. The warning goes only when an
   * answer comes without one; a newer revision is taken in only while nothing here is unsaved.
   */
  async retryIndex(): Promise<void> {
    if (this.disposed || !this.path || !this.snap.warning) return;
    try {
      const doc = await this.opts.api.get(this.path);
      if (this.disposed || !doc) return;
      const warning = this.warningOf(doc);
      if (doc.revision !== this.base?.revision && !this.dirty && !this.saving && this.state() === 'saved') {
        this.setBase(doc.revision, doc.scene);
        this.loadIntoEditor(doc.scene, { title: doc.title, revision: doc.revision, warning });
      } else {
        this.emit({ warning });
      }
    } catch {
      // Not reached: the warning stays on screen as it was, and the person can try again.
    }
  }

  /** Settle a conflict: `prefer` decides only the shapes both sides changed; everything else from both is kept. */
  private settle(prefer: 'mine' | 'theirs'): DrawingScene | null {
    const current = this.snap.conflict;
    if (!current || !this.local) return null;
    const merged = this.baseScene
      ? mergeScenes(this.baseScene, this.local, current.scene, prefer).scene
      : prefer === 'mine' ? this.local : current.scene;
    this.cancelSave();
    this.setBase(current.revision, current.scene);
    return merged;
  }

  /** Keep mine: my version of the shapes changed on both sides, with every other change of both. */
  async keepMine(): Promise<void> {
    const current = this.snap.conflict;
    const merged = this.settle('mine');
    if (!current || !merged) return;
    const patch = { conflict: null, conflictShapes: 0, revision: current.revision, error: null };
    if (sceneFingerprint(merged) !== this.localFp) this.loadIntoEditor(merged, { ...patch, state: 'unsaved', unsaved: true });
    else this.emit({ ...patch, state: 'unsaved', unsaved: this.dirty });
    this.flushDraftNow();
    await this.save();
  }

  /** Use theirs: their version of the shapes changed on both sides, with every other change of both. */
  useTheirs(): void {
    const current = this.snap.conflict;
    const merged = this.settle('theirs');
    if (!current || !merged) return;
    this.loadIntoEditor(merged, { conflict: null, conflictShapes: 0, title: current.title, revision: current.revision, state: 'unsaved', unsaved: true, error: null });
    this.flushDraftNow();
    void this.save();
  }

  /** After a copy: this file shows the server's copy, whole. */
  private takeTheirsWhole(current: DrawingDocument): void {
    this.cancelSave();
    this.setBase(current.revision, current.scene);
    this.promoted = true;
    this.loadIntoEditor(current.scene, { conflict: null, conflictShapes: 0, title: current.title, revision: current.revision, state: 'saved', unsaved: false, error: null });
    this.flushDraftNow();
  }

  /**
   * Save mine as a copy: a new file gets what is on screen, saved on the server before anything
   * here lets go of it, and saved again while the person keeps drawing until it holds the very
   * last stroke; then this file shows the server's copy. Resolves with the new path, or null when
   * the copy could not be made (the edits stay here, as they were).
   */
  async saveAsCopy(): Promise<string | null> {
    if (!this.local) return null;
    try {
      const doc = await this.opts.api.create({ title: `${this.snap.title || 'Drawing'} (copy)`, ...this.opts.scope });
      let revision = doc.revision;
      let sent = '';
      for (let tries = 0; tries < 5 && sent !== this.localFp; tries++) {
        const fp = this.localFp;
        revision = (await this.opts.api.put(doc.path, revision, this.local!)).revision;
        sent = fp;
      }
      if (sent !== this.localFp) {
        this.emit({ error: 'The copy was saved, but the newest strokes are only here. Pause a moment and save the copy again.' });
        return null;
      }
      const current = this.snap.conflict;
      if (current) this.takeTheirsWhole(current);
      else if (this.state() === 'missing' || this.state() === 'error') {
        this.local = null;
        if (this.path) this.opts.store.write(fileDraftKey(this.path), '');
      }
      return doc.path;
    } catch (err) {
      this.emit({ error: `The copy could not be made: ${drawingErrorMessage(err)}` });
      return null;
    }
  }

  /**
   * The composer attached this drawing: once it is all on the server, its draft lets go of the
   * file (the next Draw starts a new sketch; the file stays in Notes). Not saved yet: kept, and
   * the next Draw shows it again. Returns whether it let go.
   */
  async releaseComposerDraft(): Promise<boolean> {
    if (!this.sketchKey) return false;
    await this.save();
    if (this.dirty || !this.path || this.state() !== 'saved') return false;
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    this.opts.store.write(this.sketchKey, '');
    this.disposed = true;
    return true;
  }

  /** Stop reporting; the last edits go to the store and, for a file, to the server once more. */
  dispose(): void {
    if (this.disposed) return;
    if (this.draftTimer) this.flushDraftNow();
    this.disposed = true;
    const pending = !!this.saveTimer || this.state() === 'unsaved' || this.state() === 'offline';
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const last = this.saving ?? (this.dirty && pending ? this.save() : null);
    if (!last) return;
    const keys = [this.path, this.sketchKey].filter((k): k is string => !!k);
    const done = last.catch(() => {}).then(() => { for (const k of keys) if (settling.get(k) === done) settling.delete(k); });
    for (const k of keys) settling.set(k, done);
  }
}
