/**
 * Which place a DrawingWorkspace is in, and so which view choices it keeps (usePageView keys on
 * the 'drawing' page). Each place keeps its own: the App's page, a pane beside a session, the
 * composer's Draw dialog, and a note's attachment preview. The preview never shares the App
 * page's keys (opening a note's drawing must not move the App's list or full screen), never
 * remembers full screen (it starts in the note's panel on every open), and never changes which
 * file the App page opens next.
 */
export type WorkspacePlace = 'app' | 'beside' | 'composer' | 'preview';

export interface WorkspaceViewKeys {
  place: WorkspacePlace;
  /** The key of "drawings list shown", and its first value. */
  filesKey: string;
  filesDefault: boolean;
  /** The key of "full screen"; null: not kept, it starts off on every open. */
  fullScreenKey: string | null;
  /** Whether the file shown here is the one this scope's App page opens next. */
  keepsLastDocument: boolean;
  /** The key of "assistant shown"; null: no assistant here (beside a session the session is the
   *  assistant, and the composer's dialog and a note's preview are too small for a chat). */
  assistantKey: string | null;
}

export function workspacePlace(input: { draftId?: string; sessionId?: string; hasClose?: boolean; preview?: boolean }): WorkspacePlace {
  if (input.draftId) return 'composer';
  if (input.preview) return 'preview';
  return input.sessionId && input.hasClose ? 'beside' : 'app';
}

const KEYS: Record<WorkspacePlace, WorkspaceViewKeys> = {
  app: { place: 'app', filesKey: 'filesShown', filesDefault: true, fullScreenKey: 'fullScreen', keepsLastDocument: true, assistantKey: 'assistantShown' },
  // Beside a session the pane is narrow, so the list starts hidden there.
  beside: { place: 'beside', filesKey: 'filesShownBeside', filesDefault: false, fullScreenKey: 'fullScreenBeside', keepsLastDocument: true, assistantKey: null },
  composer: { place: 'composer', filesKey: 'filesShownInComposer', filesDefault: false, fullScreenKey: 'fullScreenInComposer', keepsLastDocument: false, assistantKey: null },
  // The note tree is already beside the preview, so its own list starts hidden.
  preview: { place: 'preview', filesKey: 'filesShownInPreview', filesDefault: false, fullScreenKey: null, keepsLastDocument: false, assistantKey: null },
};

export function workspaceViewKeys(place: WorkspacePlace): WorkspaceViewKeys {
  return KEYS[place];
}
