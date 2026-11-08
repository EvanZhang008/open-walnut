/**
 * The person's own words in a message Walnut handed a session, for every reader
 * that NAMES or SUMMARISES a session from it (the auto-title triggers, the title
 * reconciler's pick). Walnut puts things around those words: its notices in
 * front (history-walnut-riders.ts), its hint blocks (`<system-reminder>`
 * "Walnut (…)", hints/hint-format.ts; on an ACP engine the session instructions
 * ride the first prompt as one), its leading `[Name]…[/Name]` context blocks
 * (an Ask agent's profile on an ACP engine, a lane's conversation recap, task
 * context, history-injected-banner.ts) and the attachment headers. None of it is
 * what the person asked. 2026-10-30: an Ask Walnut chat on OpenCode was titled
 * "Walnut agent profile", read off the persona block its first message opens with.
 *
 * '' when the message is nothing but Walnut's additions.
 */
import { parseHinted } from '../hints/hint-format.js';
import { typedUserText } from '../../lib/history-injected-banner.js';
import { withoutAttachmentHeaders } from './session-uploads.js';

/**
 * What the web composer puts in front of the words when a message is anchored
 * (composeAnchoredText / composeOrientedText in web/src/utils/thread-tree.ts; the
 * card reads it back with questionBodyOf in web/src/utils/thread-card.ts): a
 * reply-tag banner, an orientation line ("(Back to the main conversation)",
 * "(Back to the earlier question about “…”)", "(Back to the earlier thread about
 * “…”)"), a file's ``About `<path>:<line>`:`` line and the quoted passage. They
 * tell the model where and about what; they are not what the person asked.
 * 2026-11-09: a task was titled "(Back to the main conversation)", and then
 * "About `/Users/…/preview.md:57`: > Paragraph 028", after questions asked with
 * Ask here. The person's words alone stay when nothing follows the framing.
 */
const QUESTION_BANNER_OPEN_RE = /^\[Question Q\d{1,5}\]\s*$/;
const QUESTION_BANNER_CLOSE_RE = /^\[\/Question Q\d{1,5}\]\s*$/;
const ORIENTATION_LINE_RE = /^\(Back to (?:the main conversation|the earlier (?:question|thread) about “.*”)\)\s*$/;
const FILE_ABOUT_LINE_RE = /^About `[^`\n]+`:\s*$/;

function withoutComposedFraming(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const skipBlank = () => { while (i < lines.length && !lines[i].trim()) i++; };
  skipBlank();
  if (i < lines.length && QUESTION_BANNER_OPEN_RE.test(lines[i])) {
    const close = lines.findIndex((l, k) => k > i && QUESTION_BANNER_CLOSE_RE.test(l));
    if (close > i) { i = close + 1; skipBlank(); }
  }
  const start = i;
  if (i < lines.length && ORIENTATION_LINE_RE.test(lines[i])) { i++; skipBlank(); }
  const aboutFile = i < lines.length && FILE_ABOUT_LINE_RE.test(lines[i]);
  if (aboutFile) { i++; skipBlank(); }
  // The quoted passage, only when the composer's framing or a typed line after it
  // shows it is the composer's: a person may open with a quote of their own.
  let k = i;
  while (k < lines.length && lines[k].startsWith('>')) k++;
  const rest = lines.slice(k).join('\n').trim();
  if (k > i && (aboutFile || i > start || rest)) i = k;
  const words = lines.slice(i).join('\n').trim();
  return words || text.trim();
}

export function ownWordsOf(raw: string): string {
  let text = parseHinted(raw).text.trim();
  // The blocks may come in any order (an image header inside a profile banner's
  // message, a notice ahead of a recap), so peel until nothing more comes off.
  for (let i = 0; i < 6; i++) {
    const peeled = withoutComposedFraming(typedUserText(text));
    // An attachment header's last path line ends in a newline, also when it is all there is.
    const next = withoutAttachmentHeaders(`${peeled}\n`).trim();
    if (next === text) break;
    text = next;
  }
  return text;
}
