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
 * Saving (drawing-sync-base.ts): a moment after each change, compare-and-set on the revision the
 * edit started from. What the server does not have yet waits in this tab's store (drawing-store.ts,
 * the drafts in drawing-drafts.ts), never in the shared draft store. Reopening takes those back.
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
 *  - A create carries its own id, so a retry whose first answer was lost never makes a second file.
 *  - A change made elsewhere (an agent's update) is taken in only while nothing here is unsaved,
 *    and never as an undo step (ExcalidrawCanvas clears the history on such a load).
 *  - After `dispose()` the controller never reports again; its last save still finishes, and a
 *    controller opened on the same file (or draft) waits for it before reading.
 *  - A composer's sketch that is not in Notes yet keeps its draft: nothing else opens over it.
 *  - "New drawing" is a sketch too (`fresh`): no file exists until the first real content.
 *  - Naming: a file Walnut named ('auto', drawing-scene.ts titleMode) is renamed once after a
 *    save to its first text line (closing the editor right after typing included); a name a
 *    person set is never changed. A rename runs between saves (it holds the same lock), and the
 *    controller follows the file to its new path, also one renamed elsewhere.
 */
import { DrawingConflictError, drawingErrorMessage } from './drawing-api';
import { fileDraftKey } from './drawing-drafts';
import { mergeScenes } from './drawing-merge';
import { autoRenameTitle, sceneFingerprint, type DrawingDocument, type DrawingScene } from './drawing-scene';
import { DrawingSyncBase } from './drawing-sync-base';

export const NOT_SAVED_YET = 'This drawing has changes that are not saved yet. Try again once it says Saved.';

export { fileDraftKey, sketchDraftKey, newSketchKey, hasUnsavedSketch, type DraftStore } from './drawing-drafts';
export {
  DRAFT_DELAY_MS, SAVE_DELAY_MS, SAVE_MAX_WAIT_MS,
  type DrawingSaveState, type DrawingSnapshot, type DrawingSource, type DrawingSyncOptions,
} from './drawing-sync-types';

export class DrawingSync extends DrawingSyncBase {
  /** The automatic rename was tried (it runs once per controller, never in a loop). */
  private renameTried = false;

  /** The name Walnut picked would follow the first text line now. */
  private autoRenameDue(): string | null {
    if (this.renameTried || this.again || !this.path || !this.local || this.dirty || this.state() !== 'saved') return null;
    return autoRenameTitle(this.local, this.snap.title);
  }

  /** A name Walnut picked follows the first text line, once, after a save that left nothing unsaved. */
  protected async maybeAutoRename(): Promise<void> {
    // The editor's open text box is waited for; once it is closing (dispose) the name goes now.
    if (!this.disposed && this.opts.canAutoRename && !this.opts.canAutoRename()) return;
    const title = this.autoRenameDue();
    if (!title) return;
    this.renameTried = true;
    const failure = await this.renameNow(title);
    if (failure) this.emit({ warning: `Saved, but its name could not follow its first line: ${failure}` });
  }

  /**
   * The editor's text box closed. A rename that waited for it runs now: the save it followed may
   * have ended while the box was open, and closing it often changes nothing more to save.
   */
  textEditEnded(): void {
    if (this.disposed || this.saving) return;
    void this.finalRename();
  }

  protected finalRename(): Promise<void> | null {
    return this.autoRenameDue() ? this.hold(this.maybeAutoRename()) : null;
  }

  /**
   * Rename the file (a person's name: the server marks it 'set'). Everything on screen is saved
   * first. Resolves with null when done, or the reason it was not.
   */
  async rename(title: string): Promise<string | null> {
    const name = title.replace(/\s+/g, ' ').trim();
    if (!name) return 'A drawing needs a name.';
    if (this.disposed) return null;
    if (!this.path) return 'Draw something first: the drawing goes to Notes then, and can be named.';
    const saved = await this.saveAll();
    if (this.disposed) return null;
    if (!saved) return NOT_SAVED_YET;
    if (name === this.snap.title) return null;
    let failure: string | null = null;
    this.renameTried = true;
    await this.hold(this.renameNow(name).then((r) => { failure = r; }));
    return failure;
  }

  /** One rename call; a stale revision with the same content is retried once, never more. */
  private async renameNow(title: string, retried = false): Promise<string | null> {
    const path = this.path!;
    const revision = this.base!.revision;
    let doc: DrawingDocument;
    try {
      doc = await this.opts.api.rename(path, revision, title);
    } catch (err) {
      if (this.disposed) return null;
      if (err instanceof DrawingConflictError) {
        const same = this.base && this.path === path && sceneFingerprint(err.current.scene) === this.base.fp;
        if (same && !retried) {
          this.base = { ...this.base!, revision: err.current.revision };
          return this.renameNow(title, true);
        }
        // Changed elsewhere: take that in first; the name stays as it is.
        this.refreshAgain = true;
        return 'This drawing was changed somewhere else. Try again.';
      }
      return drawingErrorMessage(err);
    }
    // Taken in even after dispose (the last save's rename): the drafts must name the new path.
    this.adopt(path, doc);
    return null;
  }

  /** The server's answer to a rename: the same drawing at `doc.path`. */
  private adopt(oldPath: string, doc: DrawingDocument): void {
    const wasClean = !!this.base && this.localFp === this.base.fp;
    const mode = doc.scene.appState.walnutTitle;
    if (typeof mode === 'string') {
      this.loadedKeys = { ...(this.loadedKeys ?? {}), appState: { ...(this.loadedKeys?.appState ?? {}), walnutTitle: mode } };
      this.relayLoadedKeys();
    }
    this.path = doc.path;
    this.base = { revision: doc.revision, fp: wasClean ? this.localFp : sceneFingerprint(doc.scene) };
    this.baseScene = wasClean ? this.local : doc.scene;
    if (oldPath !== doc.path) {
      this.opts.store.write(fileDraftKey(oldPath), '');
      // Nobody hears this controller any more: the next one opened on the old path follows.
      if (this.disposed) this.rememberMove(oldPath, doc.path);
    }
    this.flushDraftNow();
    this.emit({ path: doc.path, title: doc.title, revision: doc.revision, error: null, warning: this.warningOf(doc) });
  }

  /**
   * The file was renamed elsewhere (another tab, an agent): follow it to its new path. A save that
   * found the old path gone ('missing') was only looking in the wrong place: it is saved there now.
   */
  followMove(from: string, to: string): void {
    if (this.disposed || this.path !== from || from === to) return;
    this.path = to;
    this.opts.store.write(fileDraftKey(from), '');
    this.flushDraftNow();
    if (this.state() !== 'missing') {
      this.emit({ path: to });
      void this.refresh();
      return;
    }
    const dirty = this.dirty;
    this.emit({ path: to, error: null, state: dirty ? 'unsaved' : 'saved', unsaved: dirty });
    if (dirty) void this.save();
    else void this.refresh();
  }

  protected conflicted(err: DrawingConflictError, revision: string, sent: DrawingScene, sentFp: string): void {
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

  /** Save now and say whether the server holds all of it: what someone about to read the file
   *  (Walnut's agent, a rename) gets is what is on the canvas. */
  async saveAll(): Promise<boolean> {
    await this.save();
    while (this.saving) await this.saving.catch(() => {});
    return !!this.path && !this.dirty && this.state() === 'saved';
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
}
