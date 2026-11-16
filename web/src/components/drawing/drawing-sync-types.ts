/**
 * The shapes DrawingSync (drawing-sync.ts) works with: its source, its snapshot, its options.
 */
import type { DrawingApi } from './drawing-api';
import type { DraftStore } from './drawing-drafts';
import type { DrawingDocument, DrawingScene } from './drawing-scene';

/**
 * `open`: the composer's Draw switches to this file (picked from the list).
 * `fresh`: "New drawing" (a new number each press): the key starts blank unless it still holds a
 * sketch that is not in Notes, which is kept and shown instead.
 */
export type DrawingSource = { kind: 'file'; path: string } | { kind: 'sketch'; key: string; open?: string; fresh?: number };

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

export const SAVE_DELAY_MS = 800;
export const SAVE_MAX_WAIT_MS = 5_000;
export const DRAFT_DELAY_MS = 300;

export interface DrawingSyncOptions {
  api: DrawingApi;
  store: DraftStore;
  onChange: (snapshot: DrawingSnapshot) => void;
  /** Where a new file goes (the sketch's first content, Save mine as a copy). */
  scope?: { taskId?: string; sessionId?: string };
  /** False while an automatic rename should wait (a text box is still open in the editor). */
  canAutoRename?: () => boolean;
}
