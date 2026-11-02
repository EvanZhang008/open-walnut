/**
 * "Approve this message: <subject>": the mail plugin asks before a draft leaves the user's machines
 * (integrations/mail/approvals.ts), plus every turn Walnut adds to that letter's thread afterwards
 * (approvals.ts, sends.ts) and the notes it withdraws one with.
 *
 * The letter is rendered FROM THE STORED ROW and from nothing else: the human approves what is on
 * disk, so a request body that changed after the draft was written cannot change what the letter
 * says. The recipient lines come first because they are the part a mistake actually costs something,
 * and the last line states the contract in plain words: answering Send sends exactly this.
 *
 * Every character of the draft (addresses, subject, body) is escaped and every body line quoted
 * before it is placed, so a body containing `## Send anyway` cannot forge a heading or a line that
 * looks like Walnut speaking. Error reasons and send details are inserted as given.
 */
import type { MailAddress } from '../../../integrations/mail/types.js';
import { addressLine, escapeMarkdown, quotedMarkdown } from '../../../integrations/mail/letter-markdown.js';
import type { ByLang } from './languages.js';
import { letterKind } from './kind.js';

export interface ApprovalLetterInput {
  accountAddress: string;
  accountLabel: string;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  bodyMarkdown: string;
  isReply: boolean;
}

/** How much draft body rides the letter. Past this the human is reading, not deciding. */
const LETTER_BODY_MAX_CHARS = 8_000;

export interface MailApprovalWords {
  subject: (isReply: boolean, subject: string) => string;
  noSubject: string;
  nobody: string;
  /** The To line of a reply that names nobody: the mail service addresses it. */
  replyAddressed: string;
  truncated: string;
  from: (label: string, address: string) => string;
  to: string;
  cc: string;
  bcc: string;
  subjectLabel: string;
  contract: string;
  /** Fixed ids: the handler switches on them. */
  actions: ReadonlyArray<{ id: 'send' | 'edit' | 'discard'; label: string; description: string }>;
  // Thread turns after an answer.
  changed: string;
  alreadySent: string;
  superseded: string;
  editReply: string;
  discardReply: string;
  couldNot: (reason: string) => string;
  // Withdraw notes.
  changedBeforeOut: string;
  consoleSent: string;
  spentRevision: string;
  stoppedEditable: string;
  stoppedBeforeOut: string;
  unfrozenEditable: string;
  edited: string;
  discarded: string;
  // The send's outcome (sends.ts).
  sentAt: (clock: string, recipients: number) => string;
  failed: (detail: string) => string;
  unknown: (detail: string) => string;
  reaped: string;
}

/** A thread turn or withdraw note, picked from the words when it is written. */
export type MailApprovalNote = (w: MailApprovalWords) => string;

export const MAIL_APPROVAL_WORDS: ByLang<MailApprovalWords> = {
  en: {
    subject: (isReply, s) => `${isReply ? 'Approve this reply' : 'Approve this message'}: ${s}`,
    noSubject: '(no subject)',
    nobody: '(nobody)',
    replyAddressed: 'the sender of the original message (the mail service addresses the reply)',
    truncated: '[...truncated for this letter; the draft holds the whole body]',
    from: (label, address) => `**From**: ${label} (${address})`,
    to: '**To**: ',
    cc: '**Cc**: ',
    bcc: '**Bcc**: ',
    subjectLabel: '**Subject**: ',
    contract: 'Answering Send sends exactly this. Answering Edit puts the draft back in the Mail console,'
      + ' and answering Discard throws it away without sending anything.',
    actions: [
      { id: 'send', label: 'Send', description: 'Send this message now, exactly as shown' },
      { id: 'edit', label: 'Edit', description: 'Put it back in the Mail console without sending' },
      { id: 'discard', label: 'Discard', description: 'Throw the draft away without sending' },
    ],
    changed: 'This draft changed after the letter went out, so nothing was sent now. Open the Mail console to'
      + ' see where it stands, and ask again from there if you still want it sent.',
    alreadySent: 'A send for this draft was already under way, so nothing was sent by this answer. Open the Mail'
      + ' console to see how it ended.',
    superseded: 'This letter is no longer the one Walnut is waiting on: the draft was edited, discarded, or sent'
      + ' from the console. Nothing was sent by this answer.',
    editReply: 'Nothing was sent. Edit it in the Mail console; asking again will send a fresh letter.',
    discardReply: 'Discarded, nothing was sent.',
    couldNot: (reason) => `Walnut could not carry that out: ${reason} Nothing was sent.`,
    changedBeforeOut: 'This draft changed before the letter went out; nothing was sent.',
    consoleSent: 'Sent from the console; this letter is no longer needed.',
    spentRevision: 'This revision was already sent once; nothing was sent now.',
    stoppedEditable: 'Walnut stopped before this could be sent; nothing was sent, and the draft is'
      + ' editable again.',
    stoppedBeforeOut: 'Nothing was sent: Walnut stopped before the message went'
      + ' out. The draft is editable again, so ask for it to be sent when you are ready.',
    unfrozenEditable: 'Nothing was sent. The draft is editable again in the Mail console.',
    edited: 'This draft was edited; a fresh letter follows.',
    discarded: 'This draft was discarded in the Mail console; nothing was sent.',
    sentAt: (clock, n) => `Sent at ${clock} to ${n} recipient${n === 1 ? '' : 's'}.`,
    failed: (detail) => `Nothing was sent: ${detail} You can retry from the Mail console.`,
    unknown: (detail) => `The server may or may not have sent this: ${detail} Check the Sent folder before `
      + 'trying again, because a second attempt could deliver it twice.',
    reaped: 'Walnut stopped while this message was being sent, so the outcome is unknown. Check the '
      + 'Sent folder before trying again, because a second attempt could deliver it twice.',
  },
  zh: {
    subject: (isReply, s) => `${isReply ? '请批准这封回复' : '请批准这封邮件'}：${s}`,
    noSubject: '（无主题）',
    nobody: '（没有收件人）',
    replyAddressed: '原邮件的发件人（回复地址由邮件服务决定）',
    truncated: '[……信里只显示了一部分，完整正文在草稿里]',
    from: (label, address) => `**发件人**：${label}（${address}）`,
    to: '**收件人**：',
    cc: '**抄送**：',
    bcc: '**密送**：',
    subjectLabel: '**主题**：',
    contract: '选“发送”会原样发出上面这封邮件。选“编辑”会把草稿放回邮件控制台，选“丢弃”会直接删掉草稿，什么都不发。',
    actions: [
      { id: 'send', label: '发送', description: '现在就按上面显示的内容发出' },
      { id: 'edit', label: '编辑', description: '放回邮件控制台，不发送' },
      { id: 'discard', label: '丢弃', description: '删掉草稿，不发送' },
    ],
    changed: '这封信发出后草稿又改过了，所以这次什么都没发。请打开邮件控制台查看现在的状态，如果仍想发送，请在那里重新申请。',
    alreadySent: '这份草稿已经有一次发送在进行，所以这次回答没有发出任何邮件。请打开邮件控制台查看结果。',
    superseded: 'Walnut 已经不在等这封信的回答了：草稿已被编辑、丢弃，或已从控制台发出。这次回答没有发出任何邮件。',
    editReply: '什么都没发。请在邮件控制台里编辑；再次申请发送时会收到一封新的信。',
    discardReply: '已丢弃，什么都没发。',
    couldNot: (reason) => `Walnut 没能完成这一步：${reason} 什么都没发。`,
    changedBeforeOut: '这封信发出前草稿改过了；什么都没发。',
    consoleSent: '已从控制台发出；这封信不再需要。',
    spentRevision: '这一版已经发送过一次；这次什么都没发。',
    stoppedEditable: 'Walnut 在发出之前停止了；什么都没发，草稿可以重新编辑。',
    stoppedBeforeOut: '什么都没发：Walnut 在邮件发出之前停止了。草稿可以重新编辑，准备好后再申请发送。',
    unfrozenEditable: '什么都没发。草稿可以在邮件控制台里重新编辑。',
    edited: '草稿已修改；随后会收到一封新的信。',
    discarded: '草稿已在邮件控制台里丢弃；什么都没发。',
    sentAt: (clock, n) => `已于 ${clock} 发给 ${n} 位收件人。`,
    failed: (detail) => `什么都没发：${detail} 可以在邮件控制台里重试。`,
    unknown: (detail) => `服务器可能已经发出，也可能没有：${detail} 重试前请先看看“已发送”文件夹，否则可能发出两封。`,
    reaped: 'Walnut 在发送这封邮件时停止了，结果未知。重试前请先看看“已发送”文件夹，否则可能发出两封。',
  },
};

export const MAIL_APPROVAL = letterKind<ApprovalLetterInput>({
  id: 'mail-approval',
  type: 'action_required',
  callers: ['src/integrations/mail/approvals.ts'],
  marked: false,
  // A plugin letter carries no `createdByOp`; the mail plugin's sender stamp and the action ids say it.
  matchesUnmarked: (letter) => letter.sender?.pluginId === 'mail'
    && (letter.actions ?? []).map((a) => a.id).join(',') === 'send,edit,discard',
  render: (lang, input) => {
    const w = MAIL_APPROVAL_WORDS[lang];
    const body = input.bodyMarkdown.length > LETTER_BODY_MAX_CHARS
      ? `${input.bodyMarkdown.slice(0, LETTER_BODY_MAX_CHARS)}\n\n${w.truncated}`
      : input.bodyMarkdown;
    const lines = [
      w.from(escapeMarkdown(input.accountLabel), escapeMarkdown(input.accountAddress)),
      `${w.to}${input.to.map(addressLine).join(', ') || (input.isReply ? w.replyAddressed : w.nobody)}`,
      ...(input.cc.length ? [`${w.cc}${input.cc.map(addressLine).join(', ')}`] : []),
      ...(input.bcc.length ? [`${w.bcc}${input.bcc.map(addressLine).join(', ')}`] : []),
      `${w.subjectLabel}${escapeMarkdown(input.subject) || w.noSubject}`,
      '',
      quotedMarkdown(body),
      '',
      w.contract,
    ];
    return {
      subject: w.subject(input.isReply, input.subject || w.noSubject),
      markdown: lines.join('\n'),
      actions: w.actions.map((one) => ({ ...one })),
    };
  },
  samples: [
    {
      accountAddress: 'me@example.invalid',
      accountLabel: 'Work',
      to: [{ name: 'Bob', address: 'bob@example.invalid' }],
      cc: [{ address: 'carol@example.invalid' }],
      bcc: [],
      subject: 'Quarterly numbers',
      bodyMarkdown: 'Hi Bob,\n\nThe numbers are attached.',
      isReply: false,
    },
    {
      accountAddress: 'me@example.invalid',
      accountLabel: 'Home',
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      bodyMarkdown: 'Thanks!',
      isReply: true,
    },
  ],
  stillNeeded: {
    none: 'the mail plugin settles its own approval letters: an edit, a discard or a console send withdraws it'
      + ' (approvals.ts withdrawFor), and an answer to a superseded one is told so in its thread',
  },
});
