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

export function ownWordsOf(raw: string): string {
  let text = parseHinted(raw).text.trim();
  // The blocks may come in any order (an image header inside a profile banner's
  // message, a notice ahead of a recap), so peel until nothing more comes off.
  for (let i = 0; i < 6; i++) {
    const peeled = typedUserText(text);
    // An attachment header's last path line ends in a newline, also when it is all there is.
    const next = withoutAttachmentHeaders(`${peeled}\n`).trim();
    if (next === text) break;
    text = next;
  }
  return text;
}
