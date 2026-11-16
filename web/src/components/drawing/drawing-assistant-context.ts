/**
 * What the Drawing app's assistant (DrawingAssistant.tsx) is told about the drawing, and the key its
 * conversation is remembered under. Pure, so the words the agent reads are tested as they are.
 */

import { moveAskSession } from '@/components/chat/ask-object-session';

/** The console's own Walnut, the same one Ask Walnut and Mail's questions talk to. */
export const DRAWING_ASSISTANT_AGENT = 'general';

/** One remembered conversation per drawing file. */
export function drawingAssistantKey(path: string): string {
  return `drawing:${path}`;
}

/** The same drawing under a new name (renamed here, elsewhere or by Walnut): its conversation follows. */
export function followDrawingRename(from: string, to: string): void {
  moveAskSession({ agentId: DRAWING_ASSISTANT_AGENT, key: drawingAssistantKey(from) }, { agentId: DRAWING_ASSISTANT_AGENT, key: drawingAssistantKey(to) });
}

/**
 * Sent ahead of the first question. It names the drawing by its path (what every drawing tool takes)
 * and the tools in the order the walnut-drawing skill uses them, so the agent edits this file in
 * place rather than answering with a picture or making a new drawing.
 */
export function drawingAssistantContext(path: string, title: string): string {
  return [
    `The person has the drawing "${title}" open in Walnut's Drawing app, with this chat beside it, and asks you to change it.`,
    `Drawing path: ${path}`,
    'It is an editable whiteboard (follow the walnut-drawing skill): look at it with walnut_drawing_render, read element ids and the revision with walnut_drawing_read, then change it with walnut_drawing_update (walnut_drawing_append when you only add).',
    'Edit this drawing itself: every saved edit shows on the person\'s canvas at once. Do not make a new drawing or answer with an image unless they ask. Keep what they did not ask you to change.',
    'After an edit, render again and check it before you say it is done. A stale revision means they just drew something: read again and redo the edit on the new scene.',
  ].join('\n');
}
