/**
 * The saving half of DrawingSync (drawing-sync.ts has the whole contract): reading the source,
 * taking the editor's edits, keeping drafts, the save loop with its retries, and taking in a change
 * made elsewhere. Naming, conflicts and copies are DrawingSync's, through the hooks at the end.
 */
import { ApiError } from '@/api/client';
import { randomId } from '@/utils/random-id';
import { DrawingConflictError, DrawingUnreadableError, isMissingDrawing, drawingErrorMessage } from './drawing-api';
import { fileDraftKey, parseFileDraft, parseSketchDraft, readDraftOf, type FileDraft } from './drawing-drafts';
import { KEPT_APP_STATE, emptyScene, firstText, isEditorFormOf, sceneFingerprint, sceneForStorage, sceneHasContent, withLoadedKeys, type DrawingDocument, type DrawingScene } from './drawing-scene';
import { SAVE_DELAY_MS, SAVE_MAX_WAIT_MS, DRAFT_DELAY_MS, type DrawingSaveState, type DrawingSnapshot, type DrawingSource, type DrawingSyncOptions } from './drawing-sync-types';

const RETRY_MS = [2_000, 5_000, 15_000, 30_000];
/** Answers that saving again cannot change: the scene is too large, or not one the server takes. */
const REFUSED = new Set([400, 403, 413, 422]);

/** Saves still finishing for a controller that is gone, by file and by draft. */
const settling = new Map<string, Promise<void>>();
/**
 * Files a controller that was gone renamed in its last save (old path -> new): a controller opened
 * on the old path right after finds it gone and follows it there. Kept a short while only.
 */
const movedAway = new Map<string, { to: string; at: number }>();
const MOVE_MEMORY_MS = 60_000;

export abstract class DrawingSyncBase {
  protected snap: DrawingSnapshot;
  protected disposed = false;
  protected path: string | null;
  protected readonly sketchKey: string | null;
  /** A sketch's content has reached its file at least once. */
  protected promoted = true;
  /** The revision the server holds, and the content the editor showed for it. */
  protected base: { revision: string; fp: string } | null = null;
  /** That revision's scene, for a three-way merge (null: unknown, e.g. edits restored from an older revision). */
  protected baseScene: DrawingScene | null = null;
  protected local: DrawingScene | null = null;
  protected localFp = '';
  /** The scene last loaded into the editor, until the editor's first report on it. */
  private loaded: { key: number; scene: DrawingScene } | null = null;
  /** What the loaded scene holds that the editor does not report (unknown appState and top-level keys). */
  protected loadedKeys: Pick<DrawingScene, 'appState' | 'extra'> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  protected draftTimer: ReturnType<typeof setTimeout> | undefined;
  private firstUnsavedAt = 0;
  protected saving: Promise<void> | null = null;
  protected again = false;
  private retries = 0;
  private refreshing = false;
  /** A refresh was asked for while a read or a save was out: run it once that ends. */
  protected refreshAgain = false;
  /** The id of the create that makes a sketch's file, until it answers (drawing-drafts.ts). */
  private createId: string | null = null;

  constructor(readonly source: DrawingSource, protected readonly opts: DrawingSyncOptions) {
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
  protected warningOf(doc: DrawingDocument): string | null {
    return doc.indexWarning ? `Saved, but its Notes entry was not updated: ${doc.indexWarning}` : null;
  }

  protected state(): DrawingSaveState { return this.snap.state; }

  protected emit(patch: Partial<DrawingSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    if (!this.disposed) this.opts.onChange(this.snap);
  }

  /** On screen and not all on the server. */
  protected get dirty(): boolean {
    if (!this.local) return false;
    if (!this.path) return sceneHasContent(this.local);
    if (!this.promoted) return true;
    return !!this.base && this.localFp !== this.base.fp;
  }

  protected setBase(revision: string, scene: DrawingScene | null): void {
    this.base = { revision, fp: scene ? sceneFingerprint(scene) : '' };
    this.baseScene = scene;
  }

  protected loadIntoEditor(scene: DrawingScene, patch: Partial<DrawingSnapshot>): void {
    this.local = scene;
    this.localFp = sceneFingerprint(scene);
    this.loadedKeys = { appState: scene.appState, ...(scene.extra ? { extra: scene.extra } : {}) };
    const sceneKey = this.snap.sceneKey + 1;
    this.loaded = { key: sceneKey, scene };
    this.emit({ ...patch, scene, sceneKey });
  }

  /** A controller that is gone renamed its file on the way out: one opened on the old path follows. */
  protected rememberMove(from: string, to: string): void {
    const now = Date.now();
    for (const [key, move] of movedAway) if (now - move.at > MOVE_MEMORY_MS) movedAway.delete(key);
    movedAway.set(from, { to, at: now });
  }

  /** Read the source and show it. */
  async start(): Promise<void> {
    const waits = [this.path, this.sketchKey].map((k) => (k ? settling.get(k) : undefined)).filter(Boolean);
    if (waits.length) await Promise.all(waits);
    if (this.disposed) return;
    const { store } = this.opts;
    if (!this.sketchKey) { await this.openFile(null); return; }
    store.adopt?.(this.sketchKey);
    let refused: string | null = null;
    if (this.source.kind === 'sketch' && this.source.fresh) {
      // Read only now, like `open`: the controller left behind has written its last draft.
      const left = readDraftOf(store, this.sketchKey, parseSketchDraft).draft;
      if (left?.scene && sceneHasContent(left.scene)) refused = 'The last new drawing is not in Notes yet, so it stays open here. Start another once it is saved.';
      else store.write(this.sketchKey, '');
    } else if (this.source.kind === 'sketch' && this.source.open) {
      // Written only now: a sketch left behind has finished writing its own draft. One that is
      // still not in Notes stays: nothing opens over it.
      const left = readDraftOf(store, this.sketchKey, parseSketchDraft).draft;
      if (left?.scene) refused = 'This drawing is not in Notes yet, so it stays open here. Open the other one once it is saved.';
      else store.write(this.sketchKey, JSON.stringify({ v: 1, path: this.source.open }));
    }
    const { draft, unreadable } = readDraftOf(store, this.sketchKey, parseSketchDraft);
    const notice = refused ?? (unreadable ? 'An earlier sketch here could not be read. It was kept aside, unchanged.' : null);
    if (draft?.path) {
      this.path = draft.path;
      this.promoted = !draft.scene;
      await this.openFile(draft.scene ? { scene: draft.scene, baseRevision: draft.baseRevision ?? '' } : null, notice);
      return;
    }
    this.createId = draft?.createId ?? null;
    this.loadIntoEditor(draft?.scene ?? emptyScene(), { state: draft?.scene ? 'unsaved' : 'sketch', error: notice, unsaved: !!draft?.scene });
    if (draft?.scene) this.scheduleSave(0);
  }

  private async openFile(restored: FileDraft | null, notice: string | null = null, hops = 0): Promise<void> {
    const path = this.path!;
    let doc: DrawingDocument | null;
    try {
      doc = await this.opts.api.get(path);
    } catch (err) {
      if (this.disposed) return;
      const move = isMissingDrawing(err) && !this.sketchKey && hops < 5 ? movedAway.get(path) : undefined;
      if (move && Date.now() - move.at <= MOVE_MEMORY_MS) {
        // Renamed by the last save of a controller that is gone: the file is at its new path.
        this.path = move.to;
        await this.openFile(restored, notice, hops + 1);
        return;
      }
      if (isMissingDrawing(err) && this.sketchKey) {
        // The file this draft drew is gone: what was never saved there is still a sketch.
        this.path = null;
        this.promoted = true;
        this.base = null;
        this.baseScene = null;
        this.createId = null;
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
      this.opts.store.adopt?.(fileDraftKey(path));
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

  protected flushDraftNow(): void {
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    if (!this.local) return;
    const { store } = this.opts;
    const scene = sceneForStorage(this.local);
    const writes: Array<[string, string]> = [];
    if (this.sketchKey && (!this.path || !this.promoted)) {
      const draft = sceneHasContent(this.local) || this.path
        ? { ...(this.path ? { path: this.path, baseRevision: this.base?.revision ?? '' } : this.createId ? { createId: this.createId } : {}), scene }
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

  protected cancelSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.firstUnsavedAt = 0;
  }

  protected scheduleSave(delay = SAVE_DELAY_MS, exact = false): void {
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
    return this.hold(this.saveLoop());
  }

  /** Saves and renames take turns: one at a time, and what was asked meanwhile runs after. */
  protected hold(work: Promise<void>): Promise<void> {
    const run: Promise<void> = work.finally(() => {
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
        break;
      }
      this.cancelSave();
      this.emit({ state: 'saving' });
      await this.saveOnce();
    } while (this.again);
    await this.maybeAutoRename();
  }

  /** The local scene as the editor's next report will be: the loaded keys under the kept view settings. */
  protected relayLoadedKeys(): void {
    if (!this.local || !this.loadedKeys) return;
    const kept: Record<string, unknown> = {};
    for (const key of KEPT_APP_STATE) if (this.local.appState[key] !== undefined) kept[key] = this.local.appState[key];
    this.local = { ...this.local, appState: { ...this.loadedKeys.appState, ...kept }, ...(this.loadedKeys.extra ? { extra: this.loadedKeys.extra } : {}) };
    this.localFp = sceneFingerprint(this.local);
  }

  /** A refused save (Try again), after the person changed what was refused. */
  retrySave(): Promise<void> {
    if (this.state() !== 'error' || !this.dirty) return Promise.resolve();
    this.emit({ state: 'unsaved', error: null });
    return this.save();
  }

  /** A save to `sentPath` (null: a create) failed with `err`. */
  protected failed(err: unknown, sentPath: string | null = null): void {
    this.again = false;
    if (err instanceof DrawingConflictError) {
      this.emit({ state: 'conflict', conflict: err.current, conflictShapes: 0, error: null });
    } else if (err instanceof DrawingUnreadableError) {
      this.emit({ state: 'error', error: err.message });
    } else if (isMissingDrawing(err) && sentPath && this.path && sentPath !== this.path) {
      // Renamed elsewhere while the save was out (followMove): the save goes to the new path.
      this.emit({ state: 'unsaved', error: null });
      this.again = true;
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
  protected succeeded(doc: DrawingDocument, sent: DrawingScene, fp: string): void {
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
      // The sketch's first content: its file is made in the task (or session, or Inbox). The
      // create's id is in the draft before it is sent, so a retry or a reload never makes a second.
      let doc: DrawingDocument;
      const words = firstText(this.local);
      this.createId ??= randomId();
      this.flushDraftNow();
      try {
        doc = await this.opts.api.create({ ...(this.opts.scope ?? {}), ...(words ? { firstText: words } : {}), clientId: this.createId });
      } catch (err) {
        this.flushDraftNow();
        this.failed(err);
        return;
      }
      this.createId = null;
      this.path = doc.path;
      this.promoted = false;
      this.setBase(doc.revision, doc.scene);
      // What the new file holds that the editor does not report (its name mode) goes with each save.
      this.loadedKeys = { ...(this.loadedKeys ?? {}), appState: { ...doc.scene.appState, ...(this.loadedKeys?.appState ?? {}) } };
      this.relayLoadedKeys();
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
      this.failed(err, path);
    }
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

  /**
   * Stop reporting; the last edits go to the store and, for a file, to the server once more, with
   * the automatic rename that save would have run.
   */
  dispose(): void {
    if (this.disposed) return;
    if (this.draftTimer) this.flushDraftNow();
    this.disposed = true;
    const pending = !!this.saveTimer || this.state() === 'unsaved' || this.state() === 'offline';
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const last = this.saving ?? (this.dirty && pending ? this.save() : this.finalRename());
    if (!last) return;
    const keys = [this.path, this.sketchKey].filter((k): k is string => !!k);
    const done = last.catch(() => {}).then(() => { for (const k of keys) if (settling.get(k) === done) settling.delete(k); });
    for (const k of keys) settling.set(k, done);
  }

  /** After the saves of one loop: the automatic rename, when one is due (DrawingSync). */
  protected abstract maybeAutoRename(): Promise<void>;
  /** On dispose with nothing left to save: the automatic rename still due, or null. */
  protected abstract finalRename(): Promise<void> | null;
  /** A save met a newer revision (409). */
  protected abstract conflicted(err: DrawingConflictError, revision: string, sent: DrawingScene, sentFp: string): void;
}
