import type { RouterItem, RouterRoute } from './types.js';
import { redactLetterLines } from '../human-inbox/letter-credentials.js';
import type { ByLang, LetterLang } from '../human-inbox/walnut-letters/languages.js';

/** Walnut's own words around the router's brief, in the language of Walnut's letters (walnut-letters/languages.ts). */
const FRAME: ByLang<{ forYou: string; needs: string; original: string; from: string; subject: string; noSubject: string; unknown: string }> = {
  en: { forYou: 'For you', needs: 'What needs you', original: 'Original message', from: 'From', subject: 'Subject', noSubject: '(no subject)', unknown: 'unknown sender' },
  zh: { forYou: '给你', needs: '需要你做的', original: '原始邮件', from: '发件人', subject: '主题', noSubject: '（无主题）', unknown: '未知发件人' },
};

/**
 * The reason is the envelope; the briefing and original message are the document.
 * The brief quotes someone's mail, which may carry a credential (a sign-in link, a token):
 * its line comes out and the letter still goes (sending refuses a credential, and the
 * router's claim is already written, so a refusal would leave the item with no letter).
 */
export function routerLetterContent(item: Partial<Pick<RouterItem, 'subject' | 'sender'>>, route: Pick<RouterRoute, 'reason'>, brief: string, lang: LetterLang = 'en') {
  const w = FRAME[lang] ?? FRAME.en;
  const clean = (v: string) => redactLetterLines(v).text;
  const subject = clean((item.subject || w.noSubject).replace(/\s+/g, ' ').slice(0, 100));
  const from = clean((item.sender || w.unknown).replace(/\s+/g, ' ').slice(0, 200));
  return {
    subject: `${w.forYou}: ${subject}`,
    text: clean(route.reason),
    markdown: clean([route.reason.trim(), '', `## ${w.needs}`, '', brief.trim(), '', `## ${w.original}`, '', `**${w.from}:** ${from}  `, `**${w.subject}:** ${subject}`].join('\n')),
  };
}
