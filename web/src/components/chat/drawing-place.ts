/**
 * Where a composer's Draw saves its drawing: the task and session it belongs to. Every composer
 * reaches the drawing through one of these: an explicit target (a quick question, which writes in
 * a side thread of its session), the composer's own task or session (the mention self ids), or the
 * session its files go to (`fileTarget`). Without any, the drawing goes to the Inbox. A composer
 * that had a session but named none of these put its drawings in the Inbox, away from the task.
 */
export interface DrawingPlace { taskId?: string; sessionId?: string }

export function drawingPlace(input: {
  drawingTarget?: DrawingPlace;
  mentionSelfTaskId?: string;
  sessionMentionSelfId?: string;
  fileTarget?: { sessionId?: string } | null;
}): DrawingPlace {
  const taskId = input.drawingTarget?.taskId || input.mentionSelfTaskId || undefined;
  const sessionId = input.drawingTarget?.sessionId || input.sessionMentionSelfId || input.fileTarget?.sessionId || undefined;
  return { ...(taskId ? { taskId } : {}), ...(sessionId ? { sessionId } : {}) };
}

/**
 * The composer's Draw: where it saves (drawingPlace) and whose draft it is. The draft is the
 * composer's own (one per session and thread), else its session's, else its task's: each session
 * opens the drawing it drew last, or a new one, never another session's (2026-11-20, the user:
 * "each session has its own drawing open by default"). A bare session id stays the key it was,
 * so a sketch kept under it before still opens.
 */
export function composerDrawing(draftKey: string | undefined, input: Parameters<typeof drawingPlace>[0]): DrawingPlace & { draftId: string } {
  const place = drawingPlace(input);
  const draftId = draftKey || input.sessionMentionSelfId || place.sessionId || (place.taskId ? `task:${place.taskId}` : 'drawing');
  return { ...place, draftId };
}
