/**
 * The mail plugin's own letters (approval, unsubscribe, digest) in the user's letter language.
 * Walnut's fixed words change; the mail content (addresses, subjects, bodies, list names, urls)
 * stays exactly as it was placed before, and the action ids the handlers switch on never change.
 */
import { describe, expect, it } from 'vitest';
import { MAIL_APPROVAL } from '../../src/core/human-inbox/walnut-letters/mail-approval.js';
import { MAIL_DIGEST } from '../../src/core/human-inbox/walnut-letters/mail-digest.js';
import { MAIL_UNSUBSCRIBE } from '../../src/core/human-inbox/walnut-letters/mail-unsubscribe.js';
import { LETTER_ACTIONS } from '../../src/integrations/mail/approvals.js';
import { renderDigest, renderGroupedDigest, type DigestAccountBlock } from '../../src/integrations/mail/digest.js';
import { renderApprovalLetter, renderUnsubscribeLetter } from '../../src/integrations/mail/render.js';
import { UNSUBSCRIBE_LETTER_ACTIONS } from '../../src/integrations/mail/unsubscribe.js';

/** Any Han character (CJK Unified Ideographs). */
const HAN = /[\u4e00-\u9fff]/;
const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);

const approval = {
  accountAddress: 'me@example.invalid',
  accountLabel: 'Work mail',
  to: [{ name: 'Bob Smith', address: 'bob@example.invalid' }],
  cc: [{ address: 'carol@example.invalid' }],
  bcc: [{ address: 'dave@example.invalid' }],
  subject: 'Quarterly numbers',
  bodyMarkdown: 'Hi Bob,\n\n## Send anyway\nThe numbers are attached.',
  isReply: false,
};

describe('approval letter', () => {
  it('stays English by default, unchanged', () => {
    const en = renderApprovalLetter(approval);
    expect(en.subject).toBe('Approve this message: Quarterly numbers');
    expect(en.markdown).toContain('**From**: Work mail (me@example.invalid)');
    expect(en.markdown).toContain('**To**: Bob Smith &lt;bob@example.invalid&gt;');
    expect(en.markdown).toContain('Answering Send sends exactly this.');
    expect(en.markdown).not.toMatch(HAN);
    expect(renderApprovalLetter(approval, 'en')).toEqual(en);
  });

  it('renders in Chinese with the mail content verbatim and the same action ids', () => {
    const zh = MAIL_APPROVAL.render('zh', approval);
    expect(zh.subject).toBe('\u8bf7\u6279\u51c6\u8fd9\u5c01\u90ae\u4ef6\uff1aQuarterly numbers');
    expect(zh.markdown).toContain('**\u53d1\u4ef6\u4eba**\uff1aWork mail\uff08me@example.invalid\uff09');
    expect(zh.markdown).toContain('**\u6536\u4ef6\u4eba**\uff1aBob Smith &lt;bob@example.invalid&gt;');
    expect(zh.markdown).toContain('**\u6284\u9001**\uff1acarol@example.invalid');
    expect(zh.markdown).toContain('**\u5bc6\u9001**\uff1adave@example.invalid');
    // The body is still quoted and escaped: a heading in it cannot become the letter's own.
    expect(zh.markdown).toContain('> \\## Send anyway');
    expect(zh.markdown).toContain('\u9009\u201c\u53d1\u9001\u201d\u4f1a\u539f\u6837\u53d1\u51fa');
    expect(zh.markdown).not.toContain('Answering');
    expect(zh.actions!.map((a) => a.id)).toEqual(LETTER_ACTIONS.map((a) => a.id));
    expect(zh.actions!.map((a) => a.label)).toEqual(['\u53d1\u9001', '\u7f16\u8f91', '\u4e22\u5f03']);
    expect(renderApprovalLetter(approval, 'zh')).toEqual({ subject: zh.subject, markdown: zh.markdown });
  });

  it('says reply and no subject in Chinese', () => {
    const zh = MAIL_APPROVAL.render('zh', { ...approval, to: [], cc: [], bcc: [], subject: '', isReply: true });
    expect(zh.subject).toBe('\u8bf7\u6279\u51c6\u8fd9\u5c01\u56de\u590d\uff1a\uff08\u65e0\u4e3b\u9898\uff09');
    expect(zh.markdown).toContain('**\u6536\u4ef6\u4eba**\uff1a\u539f\u90ae\u4ef6\u7684\u53d1\u4ef6\u4eba');
    expect(zh.markdown).toContain('**\u4e3b\u9898**\uff1a\uff08\u65e0\u4e3b\u9898\uff09');
  });
});

const unsubscribe = {
  accountLabel: 'Personal mail',
  sender: { name: 'Marina Weekly', address: 'weekly@lists.example.invalid' },
  subject: 'Marina Weekly, issue 42',
  listName: 'weekly.lists.example.invalid',
  byListId: true,
  method: 'one-click' as const,
  url: 'https://lists.example.invalid/u/a_b',
  urlSource: 'header' as const,
};

describe('unsubscribe letter', () => {
  it('stays English by default, unchanged', () => {
    const en = renderUnsubscribeLetter(unsubscribe);
    expect(en.subject).toBe('Unsubscribe from weekly.lists.example.invalid?');
    expect(en.markdown).toContain('**List**: weekly.lists.example.invalid');
    expect(en.markdown).toContain('This list publishes a one-click unsubscribe');
    expect(en.markdown).not.toMatch(HAN);
  });

  it('renders in Chinese with the list, sender and url verbatim and the same action ids', () => {
    const zh = MAIL_UNSUBSCRIBE.render('zh', unsubscribe);
    expect(zh.subject).toBe('\u9000\u8ba2 weekly.lists.example.invalid\uff1f');
    expect(zh.markdown).toContain('**\u53d1\u4ef6\u4eba**\uff1aMarina Weekly &lt;weekly@lists.example.invalid&gt;');
    expect(zh.markdown).toContain('**\u4e3b\u9898**\uff1aMarina Weekly, issue 42');
    expect(zh.markdown).toContain('**\u8d26\u6237**\uff1aPersonal mail');
    expect(zh.markdown).toContain('**\u90ae\u4ef6\u5217\u8868**\uff1aweekly.lists.example.invalid');
    expect(zh.markdown).toContain('```\nhttps://lists.example.invalid/u/a_b\n```');
    expect(zh.markdown).toContain('\u4e00\u952e\u9000\u8ba2');
    expect(zh.markdown).not.toContain('Walnut has done nothing');
    expect(zh.actions!.map((a) => a.id)).toEqual(UNSUBSCRIBE_LETTER_ACTIONS.map((a) => a.id));
    expect(zh.actions!.map((a) => a.label)).toEqual(['\u9000\u8ba2', '\u6682\u4e0d']);
  });

  it('words the link and mailto rungs in Chinese', () => {
    const link = MAIL_UNSUBSCRIBE.render('zh', { ...unsubscribe, method: 'link', urlSource: 'body', byListId: false });
    expect(link.markdown).toContain('**\u53d1\u9001\u65b9**\uff1a');
    expect(link.markdown).toContain('\u4ece\u90ae\u4ef6\u6b63\u6587\u91cc\u627e\u5230\u7684');
    const mailto = MAIL_UNSUBSCRIBE.render('zh', { ...unsubscribe, method: 'mailto', mailto: 'leave@example.invalid', listName: '' });
    expect(mailto.subject).toBe('\u9000\u8ba2\u8fd9\u4e2a\u90ae\u4ef6\u5217\u8868\uff1f');
    expect(mailto.markdown).toContain('\u53ea\u63a5\u53d7\u7528\u90ae\u4ef6\u9000\u8ba2\uff0c\u5730\u5740\u662f leave@example.invalid\u3002');
    expect(mailto.markdown).toContain('**\u90ae\u4ef6\u5217\u8868**\uff1a\uff08\u672a\u547d\u540d\uff09');
  });
});

function block(over: Partial<DigestAccountBlock> = {}): DigestAccountBlock {
  return {
    accountId: 'acct-1',
    label: 'Work mail',
    unread: 5,
    items: [
      { sender: 'Bob Smith', subject: 'Lunch *today*?', sentAt: NOW - 3 * 60_000, account: 'acct-1', message: 'm-1' },
      { sender: '', subject: '', sentAt: NOW - 2 * 3_600_000, account: 'acct-1', message: 'm-2' },
    ],
    ...over,
  };
}

describe('digest letter', () => {
  it('stays English by default, unchanged', () => {
    const en = renderDigest([block()], NOW);
    expect(en.subject).toBe('Mail digest: 5 unread across 1 account');
    expect(en.markdown).toContain('### Work mail (5 unread)');
    expect(en.markdown).toContain('- **Bob Smith**: Lunch \\*today\\*? (3m ago)');
    expect(en.markdown).toContain('and 3 more');
    expect(en.markdown).not.toMatch(HAN);
    expect(renderDigest([block()], NOW, 'en')).toEqual(en);
  });

  it('renders in Chinese with senders and subjects verbatim, escaped as before', () => {
    const zh = renderDigest([block()], NOW, 'zh');
    expect(zh.subject).toBe('\u90ae\u4ef6\u6458\u8981\uff1a1 \u4e2a\u8d26\u6237\u5171 5 \u5c01\u672a\u8bfb');
    expect(zh.text).toContain('1 \u4e2a\u8d26\u6237\u5171 5 \u5c01\u672a\u8bfb\u3002\u90ae\u7bb1\u5feb\u7167\u65f6\u95f4\uff1a');
    expect(zh.markdown).toContain('### Work mail\uff085 \u5c01\u672a\u8bfb\uff09');
    expect(zh.markdown).toContain('- **Bob Smith**: Lunch \\*today\\*? (3 \u5206\u949f\u524d)');
    expect(zh.markdown).toContain('- **\uff08\u65e0\u53d1\u4ef6\u4eba\uff09**: \uff08\u65e0\u4e3b\u9898\uff09 (2 \u5c0f\u65f6\u524d)');
    expect(zh.markdown).toContain('\u8fd8\u6709 3 \u5c01');
    expect(zh.markdown).toContain('[\u6253\u5f00\u90ae\u4ef6](/mail?account=acct-1)');
    // The items keep their identity; only the stand-ins are translated.
    const en = renderDigest([block()], NOW);
    expect(zh.items.map((i) => i.id)).toEqual(en.items.map((i) => i.id));
    expect(zh.items[1]!.subject).toBe('\uff08\u65e0\u4e3b\u9898\uff09');
    expect(zh.items[1]!.summary).toBe('\u6682\u65e0\u90ae\u4ef6\u6458\u8981');
    expect(zh.items[0]!.subject).toBe(en.items[0]!.subject);
  });

  it('renders grouped mode in Chinese', () => {
    const zh = renderGroupedDigest([], [{ label: 'Build results', unread: 4 }], NOW, 'zh');
    expect(zh.subject).toBe('\u90ae\u4ef6\u6458\u8981\uff1a0 \u5c01\u9700\u8981\u4f60\u5904\u7406 \u00b7 4 \u5c01\u5df2\u5206\u7ec4');
    expect(zh.markdown).toContain('\u6ca1\u6709\u9700\u8981\u4f60\u5904\u7406\u7684\u90ae\u4ef6\u3002');
    expect(zh.markdown).toContain('### \u5df2\u5206\u7ec4\n\n- Build results\uff1a4 \u5c01\u672a\u8bfb');
  });

  it('the kind renders the same letter the plugin sends', () => {
    const zh = MAIL_DIGEST.render('zh', { blocks: [block()], now: NOW });
    const sent = renderDigest([block()], NOW, 'zh');
    expect(zh).toEqual({ subject: sent.subject, markdown: sent.markdown, text: sent.text });
  });
});

describe('every sample renders in every language', () => {
  for (const kind of [MAIL_APPROVAL, MAIL_UNSUBSCRIBE, MAIL_DIGEST]) {
    it(kind.id, () => {
      for (const sample of kind.samples as readonly never[]) {
        const en = kind.render('en', sample);
        const zh = kind.render('zh', sample);
        expect(`${en.subject}\n${en.markdown}`).not.toMatch(HAN);
        expect(`${zh.subject}\n${zh.markdown}`).toMatch(HAN);
      }
    });
  }
});
