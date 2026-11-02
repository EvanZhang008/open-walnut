/**
 * "Unsubscribe from <list>?": the mail plugin asks before leaving a list (integrations/mail/unsubscribe.ts),
 * plus the fixed turns it adds to the letter's thread after the answer. The AI rung, and the ONLY
 * thing the agent's op does.
 *
 * Written so that the human can answer it without opening anything else, which means it has to say
 * three things: which mail this is, what Walnut will actually DO if they tap Unsubscribe, and what it
 * cannot do. The third one is not politeness: the rungs differ in how final they are, and a letter
 * that promised "you will be off the list" for a page nobody has read yet would be the same lie the
 * verdict heuristics exist to avoid.
 *
 * Every value from the sender (the name, the subject, the `List-Id`) goes through `escapeMarkdown`
 * first, for the same reason the approval letter's does: this document is what a decision rests on,
 * and a subject able to forge a heading in it could change what the person thinks they are agreeing
 * to. The url is the one exception and it is fenced instead (see `fencedUrl`).
 */
import type { MailAddress } from '../../../integrations/mail/types.js';
import { addressLine, escapeMarkdown, fencedUrl } from '../../../integrations/mail/letter-markdown.js';
import type { ByLang } from './languages.js';
import { letterKind } from './kind.js';

/** How much of a list name or a subject rides a letter that is asking one short question. */
const UNSUBSCRIBE_NAME_CHARS = 200;

export interface UnsubscribeLetterInput {
  /** Which of the person's accounts holds the message. */
  accountLabel: string;
  sender: MailAddress;
  subject: string;
  /** What is being left: the sender's own `List-Id` when it published one, else its address. */
  listName: string;
  /** True when `listName` came from `List-Id`. False means it is the sender, which is coarser. */
  byListId: boolean;
  /** The best rung this message offers. */
  method: 'one-click' | 'mailto' | 'link';
  /** The page Walnut would open, when the chosen rung has one. */
  url?: string;
  /** Where that link came from. `'body'` means the account gave Walnut no unsubscribe headers. */
  urlSource?: 'header' | 'body';
  /** The mail address the list takes an unsubscribe at, for the mailto rung. */
  mailto?: string;
}

export interface MailUnsubscribeWords {
  subject: (name: string) => string;
  noSubject: string;
  unnamed: string;
  from: string;
  subjectLabel: string;
  account: string;
  /** The label of the line naming what is left: a list, or (no List-Id) the sender. */
  what: (byListId: boolean) => string;
  oneClick: (byListId: boolean) => string;
  oneClickFallback: string;
  link: (byListId: boolean) => string;
  bodyLink: string;
  mailto: (byListId: boolean, to: string) => string;
  closing: string;
  /** Fixed ids: the handler switches on them. */
  actions: ReadonlyArray<{ id: 'unsubscribe' | 'not-now'; label: string; description: string }>;
  // Thread turns after an answer.
  notNow: string;
  pageIs: string;
  couldNot: (reason: string) => string;
  nothingChanged: (said: string) => string;
}

export const MAIL_UNSUBSCRIBE_WORDS: ByLang<MailUnsubscribeWords> = {
  en: {
    subject: (name) => `Unsubscribe from ${name || 'this list'}?`,
    noSubject: '(no subject)',
    unnamed: '(unnamed)',
    from: '**From**: ',
    subjectLabel: '**Subject**: ',
    account: '**Account**: ',
    what: (byListId) => `**${byListId ? 'List' : 'Sender'}**: `,
    oneClick: (byListId) => `This ${byListId ? 'list' : 'sender'} publishes a one-click unsubscribe, so answering`
      + ' Unsubscribe makes Walnut send one request and nothing else: no page to read, no confirmation,'
      + ' and the sender learns nothing about you beyond the link they already gave out.',
    oneClickFallback: 'If their endpoint refuses, Walnut opens the same link as a page and reads what it says.',
    link: (byListId) => `Answering Unsubscribe makes Walnut open this ${byListId ? 'list' : 'sender'}'s unsubscribe`
      + ' page and read what came back. It can only report what that page says: a page that confirms you are'
      + ' off the list is final, and a page that wants a button pressed is not, in which case the answer'
      + ' comes back here with the link so you can finish it.',
    bodyLink: 'That link came out of the message itself, because this account gives Walnut no unsubscribe'
      + ' headers to read. It is the only way out this message offers: there is no one-click'
      + ' request to make and no address to write to.',
    mailto: (byListId, to) => `This ${byListId ? 'list' : 'sender'} only takes an unsubscribe by mail`
      + `${to ? `, to ${to}` : ''}.`
      + ' Answering Unsubscribe asks Walnut to write that mail from this account, which is a thing'
      + ' only you can authorise; Walnut never decides to send mail on its own.',
    closing: 'Walnut has done nothing yet: it asked instead, because leaving a list is yours to decide.'
      + ' Answering Not now changes nothing and leaves the mail where it is.',
    actions: [
      { id: 'unsubscribe', label: 'Unsubscribe', description: 'Leave this list now, the best way Walnut can' },
      { id: 'not-now', label: 'Not now', description: 'Change nothing and keep the mail where it is' },
    ],
    notNow: 'Nothing was done: you are still on this list, and the mail is'
      + ' where it was. Ask again from the Mail console whenever you want to leave it.',
    pageIs: 'The page is:',
    couldNot: (reason) => `Walnut could not carry that out: ${reason}`,
    nothingChanged: (said) => `${said} Nothing was changed.`,
  },
  zh: {
    subject: (name) => (name ? `退订 ${name}？` : '退订这个邮件列表？'),
    noSubject: '（无主题）',
    unnamed: '（未命名）',
    from: '**发件人**：',
    subjectLabel: '**主题**：',
    account: '**账户**：',
    what: (byListId) => `**${byListId ? '邮件列表' : '发送方'}**：`,
    oneClick: (byListId) => `这个${byListId ? '邮件列表' : '发送方'}提供一键退订，所以选“退订”时，Walnut 只发出一个请求，`
      + '别的什么都不做：不用看网页，不用确认，对方除了已经给出的链接外，得不到你的任何信息。',
    oneClickFallback: '如果对方的接口拒绝，Walnut 会把同一个链接当作网页打开，并读取页面上写了什么。',
    link: (byListId) => `选“退订”后，Walnut 会打开这个${byListId ? '邮件列表' : '发送方'}的退订页面，读取返回的内容。`
      + '它只能转述页面上写了什么：页面确认你已退订，就算完成；页面还要你点一个按钮，就不算完成，'
      + '这时结果会连同链接回到这里，由你来完成。',
    bodyLink: '这个链接是从邮件正文里找到的，因为这个账户不向 Walnut 提供退订用的邮件头。'
      + '这是这封邮件唯一的退订方式：没有一键退订请求可发，也没有可以写信的地址。',
    mailto: (byListId, to) => `这个${byListId ? '邮件列表' : '发送方'}只接受用邮件退订${to ? `，地址是 ${to}` : ''}。`
      + '选“退订”就是让 Walnut 用这个账户写这封信，这件事只有你能授权；Walnut 从不自己决定发邮件。',
    closing: 'Walnut 还什么都没做：它先来问你，因为是否退订由你决定。选“暂不”不会有任何改动，邮件也留在原处。',
    actions: [
      { id: 'unsubscribe', label: '退订', description: '现在就用 Walnut 能用的最好方式退订' },
      { id: 'not-now', label: '暂不', description: '不做任何改动，邮件留在原处' },
    ],
    notNow: '什么都没做：你仍在这个列表里，邮件也在原处。想退订时，随时可以在邮件控制台里再次申请。',
    pageIs: '页面地址：',
    couldNot: (reason) => `Walnut 没能完成这一步：${reason}`,
    nothingChanged: (said) => `${said} 没有做任何改动。`,
  },
};

export const MAIL_UNSUBSCRIBE = letterKind<UnsubscribeLetterInput>({
  id: 'mail-unsubscribe',
  type: 'action_required',
  callers: ['src/integrations/mail/unsubscribe.ts'],
  marked: false,
  // A plugin letter carries no `createdByOp`; the mail plugin's sender stamp and the action ids say it.
  matchesUnmarked: (letter) => letter.sender?.pluginId === 'mail'
    && (letter.actions ?? []).map((a) => a.id).join(',') === 'unsubscribe,not-now',
  render: (lang, input) => {
    const w = MAIL_UNSUBSCRIBE_WORDS[lang];
    const list = escapeMarkdown(input.listName.slice(0, UNSUBSCRIBE_NAME_CHARS));
    // One block, single-spaced: these four are a header the eye reads down, not four paragraphs.
    const header = [
      `${w.from}${addressLine(input.sender)}`,
      `${w.subjectLabel}${escapeMarkdown(input.subject.slice(0, UNSUBSCRIBE_NAME_CHARS)) || w.noSubject}`,
      `${w.account}${escapeMarkdown(input.accountLabel)}`,
      `${w.what(input.byListId)}${list || w.unnamed}`,
    ].join('\n');

    const blocks: string[] = [header];
    if (input.method === 'one-click') {
      blocks.push(w.oneClick(input.byListId), fencedUrl(input.url ?? ''), w.oneClickFallback);
    } else if (input.method === 'link') {
      blocks.push(w.link(input.byListId), fencedUrl(input.url ?? ''), input.urlSource === 'body' ? w.bodyLink : '');
    } else {
      const to = input.mailto ? escapeMarkdown(input.mailto.slice(0, UNSUBSCRIBE_NAME_CHARS)) : '';
      blocks.push(w.mailto(input.byListId, to));
    }
    blocks.push(w.closing);
    return {
      subject: w.subject(input.listName.slice(0, UNSUBSCRIBE_NAME_CHARS)),
      markdown: blocks.filter((block) => block !== '').join('\n\n'),
      actions: w.actions.map((one) => ({ ...one })),
    };
  },
  samples: [
    {
      accountLabel: 'Work',
      sender: { name: 'News', address: 'news@example.invalid' },
      subject: 'This week',
      listName: 'news.example.invalid',
      byListId: true,
      method: 'one-click',
      url: 'https://example.invalid/u?t=1',
      urlSource: 'header',
    },
    {
      accountLabel: 'Home',
      sender: { address: 'promo@example.invalid' },
      subject: '',
      listName: 'promo@example.invalid',
      byListId: false,
      method: 'link',
      url: 'https://example.invalid/leave',
      urlSource: 'body',
    },
    {
      accountLabel: 'Home',
      sender: { address: 'list@example.invalid' },
      subject: 'Digest',
      listName: '',
      byListId: true,
      method: 'mailto',
      mailto: 'leave@example.invalid',
    },
  ],
  stillNeeded: {
    none: 'the mail plugin owns its unsubscribe letters: the ledger row names the letter, a second ask is refused'
      + ' while it is open, and any answer to it is acted on or told why not in its thread (unsubscribe.ts)',
  },
});
