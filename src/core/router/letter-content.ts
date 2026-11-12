import type { RouterItem, RouterRoute } from './types.js';

/** The reason is the envelope; the briefing and original message are the document. */
export function routerLetterContent(item: Partial<Pick<RouterItem, 'subject' | 'sender'>>, route: Pick<RouterRoute, 'reason'>, brief: string) {
  const subject = (item.subject || '(no subject)').replace(/\s+/g, ' ').slice(0, 100);
  const from = (item.sender || 'unknown sender').replace(/\s+/g, ' ').slice(0, 200);
  return {
    subject: `For you: ${subject}`,
    text: route.reason,
    markdown: [route.reason.trim(), '', '## What needs you', '', brief.trim(), '', '## Original message', '', `**From:** ${from}  `, `**Subject:** ${subject}`].join('\n'),
  };
}
