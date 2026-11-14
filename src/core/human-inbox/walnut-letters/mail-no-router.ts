/**
 * "New mail of <mailbox> is not being read by any router": every new mail of a mailbox goes only to
 * its router (src/integrations/mail/router-intake.ts), so a mailbox bound to no router, or whose
 * router is complete or gone, has its new mail read by nobody. The mail is kept (the intake's
 * pending queue, or the area's open items) and reaches a router once one is open again; this
 * letter says so, once per episode, marked `mail-no-router:<account>:<since>`
 * (core/router/account-intake.ts sendNoRouterLetter).
 *
 * No longer needed once the mailbox has an open router again (a paused one counts: its mail waits
 * for the resume the person chose).
 */
import type { ByLang, LetterLang } from './languages.js';
import { letterKind } from './kind.js';

export interface MailNoRouterParams {
  /** The mailbox's address or name, as its account shows it. */
  mailbox: string;
  /** `none`: bound to no router; `closed`: its router is complete or gone. */
  reason: 'none' | 'closed';
}

interface Words {
  subject: (mailbox: string) => string;
  none: (mailbox: string) => string;
  closed: (mailbox: string) => string;
  kept: string;
  fix: string;
  settled: string;
}

const WORDS: ByLang<Words> = {
  en: {
    subject: (m) => `New mail of ${m} is not being read by any router`,
    none: (m) => `Walnut hands every new mail of **${m}** to a mail router, but this mailbox has no router to go to.`,
    closed: (m) => `Walnut hands every new mail of **${m}** to its mail router, but that router is complete or gone, so nobody reads it.`,
    kept: 'Its new mail is kept (for up to 7 days) and goes to the router as soon as one is open again.',
    fix: 'To fix it, reopen the mailbox\'s router, or open Org and give the mailbox a router.',
    settled: 'Not needed any more: a router reads this mailbox\'s new mail again.',
  },
  zh: {
    subject: (m) => `${m} 的新邮件没有任何路由在读`,
    none: (m) => `Walnut 会把 **${m}** 的每封新邮件交给一个邮件路由，但这个邮箱没有可交的路由。`,
    closed: (m) => `Walnut 会把 **${m}** 的每封新邮件交给它的邮件路由，但那个路由已完成或已不存在，所以没人读这些邮件。`,
    kept: '新邮件会先保留（最多 7 天），一旦有路由重新打开就交给它。',
    fix: '解决办法：重新打开这个邮箱的路由，或打开 Org 给这个邮箱指定一个路由。',
    settled: '不再需要：已有路由重新在读这个邮箱的新邮件。',
  },
};

export function mailNoRouterSettled(lang: LetterLang): string {
  return WORDS[lang].settled;
}

export const MAIL_NO_ROUTER = letterKind<MailNoRouterParams>({
  id: 'mail-no-router',
  type: 'review',
  callers: ['src/core/router/account-intake.ts'],
  marked: true,
  render: (lang, p) => {
    const w = WORDS[lang];
    return {
      subject: w.subject(p.mailbox),
      markdown: [p.reason === 'closed' ? w.closed(p.mailbox) : w.none(p.mailbox), w.kept, w.fix].join('\n\n'),
    };
  },
  samples: [
    { mailbox: 'pat@example.invalid', reason: 'none' },
    { mailbox: 'pat@example.invalid', reason: 'closed' },
  ],
  stillNeeded: {
    check: async (letter, ctx) => (await import('../../router/account-intake.js')).noRouterLetterSettleReason(letter, ctx),
  },
});
