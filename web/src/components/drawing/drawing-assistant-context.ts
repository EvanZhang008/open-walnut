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
export function drawingAssistantContext(path: string, title: string, walkthroughs = false): string {
  return [
    `The person has the drawing "${title}" open in Walnut's Drawing app, with this chat beside it, and asks you to change it.`,
    `Drawing path: ${path}`,
    'It is an editable whiteboard (follow the walnut-drawing skill): look at it with walnut_drawing_render, read element ids and the revision with walnut_drawing_read, then change it with walnut_drawing_update (walnut_drawing_append when you only add).',
    'Edit this drawing itself: every saved edit shows on the person\'s canvas at once. Do not make a new drawing or answer with an image unless they ask. Keep what they did not ask you to change.',
    'After an edit, render again and check it before you say it is done. A stale revision means they just drew something: read again and redo the edit on the new scene.',
    // The drawing_narration experiment: what they said while drawing is part of the drawing.
    ...(walkthroughs ? ['They may also ask about what they said while drawing (a recorded walkthrough). walnut_drawing_read answers with its overview: which element each part of the talk was about. For one part in detail, call walnut_drawing_narration.'] : []),
  ].join('\n');
}

/** The ids a tidy request names; past it, the request says how many more (a message stays short). */
const MAX_NAMED_IDS = 60;

/**
 * "Make a diagram" and "Text to diagram" in the App page, as a message into this drawing's
 * assistant conversation: the same agent does them, and the person sees what it looked at and
 * changed (2026-11-16, the user: "for each diagram use one task session, and even for make diagram
 * route to there, so it is more visualized"). Elsewhere (the composer's sketch, a note's preview,
 * beside a session) the editor keeps its one-call diagram.
 */
export type DrawingAssistantAsk =
  | { kind: 'tidy'; selectedIds: string[] | null }
  | { kind: 'text'; prompt: string };

export function drawingAssistantAsk(ask: DrawingAssistantAsk): string {
  if (ask.kind === 'text') {
    return `Text to diagram: draw this as a clean diagram in this drawing, beside what is already there.\n\n${ask.prompt.trim()}`;
  }
  const how = 'Look at it first, then in one walnut_drawing_update replace my hand-drawn strokes and rough boxes with clean shapes, labels and connected arrows where I drew them. Keep my typed text and everything else as it is.';
  if (!ask.selectedIds?.length) return `Make a diagram from this whole drawing. ${how}`;
  const named = ask.selectedIds.slice(0, MAX_NAMED_IDS).join(', ');
  const more = ask.selectedIds.length > MAX_NAMED_IDS ? ` and ${ask.selectedIds.length - MAX_NAMED_IDS} more` : '';
  return `Make a diagram from the shapes I selected (element ids: ${named}${more}). ${how}`;
}

/** The task of a drawing's conversation is named after the drawing, so it reads as that drawing's. */
export function drawingTaskTitle(title: string): string {
  return `Drawing: ${title.trim() || 'Untitled'}`;
}
