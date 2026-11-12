import type { RouterItem, RouterRoute } from './types.js';
import { redactLetterLines } from '../human-inbox/letter-credentials.js';

/**
 * The reason is the envelope; the briefing and original message are the document.
 * The brief quotes someone's mail, which may carry a credential (a sign-in link, a token):
 * its line comes out and the letter still goes (sending refuses a credential, and the
 * router's claim is already written, so a refusal would leave the item with no letter).
 */
export function routerLetterContent(item: Partial<Pick<RouterItem, 'subject' | 'sender'>>, route: Pick<RouterRoute, 'reason'>, brief: string) {
  const clean = (v: string) => redactLetterLines(v).text;
  const subject = clean((item.subject || '(no subject)').replace(/\s+/g, ' ').slice(0, 100));
  const from = clean((item.sender || 'unknown sender').replace(/\s+/g, ' ').slice(0, 200));
  return {
    subject: `For you: ${subject}`,
    text: clean(route.reason),
    markdown: clean([route.reason.trim(), '', '## What needs you', '', brief.trim(), '', '## Original message', '', `**From:** ${from}  `, `**Subject:** ${subject}`].join('\n')),
  };
}
