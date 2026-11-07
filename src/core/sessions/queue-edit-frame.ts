/**
 * An edit of a queued row keeps what Walnut wrote in front of the person's words.
 *
 * The queue card may show only the typed words (`words`, sessions/queue-row-view.ts):
 * no Walnut notice riding in front (lib/history-walnut-riders.ts) and no attachment
 * header (lib/attachment-headers.ts). An edit made from those words sends only
 * words, and taking them as the whole row dropped the pictures and files the
 * message carried, and the notice the session was owed. So the row's leading
 * frame (its riders and headers) goes back in front of edited words that carry
 * none of their own. An editor that kept the frame keeps its own.
 */
import { parseHinted } from '../hints/hint-format.js';
import { withoutLeadingRiders } from '../../lib/history-walnut-riders.js';
import { splitAttachmentHeaders } from '../../lib/attachment-headers.js';
import { withoutAiOnly } from '../../lib/ai-only-envelope.js';

/** The riders and attachment headers that lead these words ('' for none). */
export function leadingFrameOf(words: string): string {
  const rest = splitAttachmentHeaders(withoutLeadingRiders(words)).text;
  if (rest === words || !words.endsWith(rest)) return '';
  return words.slice(0, words.length - rest.length);
}

/**
 * The words to store for an edit of a row whose composed text is `previous`.
 * An App's AI-only brief is left to keepAiOnly (it is not part of the frame here).
 */
export function keepLeadingFrame(previous: string, edited: string): string {
  const frame = leadingFrameOf(withoutAiOnly(parseHinted(previous).text));
  if (!frame) return edited;
  // The editor sent its own riders or headers: they are its word on them.
  if (leadingFrameOf(withoutAiOnly(edited))) return edited;
  // A row of pictures alone has no blank line after its last path once its hint blocks
  // are parsed off (the parse trims): the new words still start their own paragraph.
  const sep = frame.endsWith('\n\n') ? '' : frame.endsWith('\n') ? '\n' : '\n\n';
  return `${frame}${sep}${edited}`;
}
