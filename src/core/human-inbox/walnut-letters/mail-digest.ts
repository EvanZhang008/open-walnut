/**
 * "Mail digest: N unread across N accounts": the mail plugin's daily report of what sits unread
 * (integrations/mail/digest.ts), in plain or grouped mode. The layout, byte budgets and escaping
 * live in integrations/mail/digest-render.ts; every fixed word lives here. Account labels, senders,
 * subjects and group labels are inserted as the mail gave them, escaped.
 */
import {
  renderDigestIn,
  renderGroupedDigestIn,
  type DigestAccountBlock,
  type DigestGroupLine,
} from '../../../integrations/mail/digest-render.js';
import type { ByLang } from './languages.js';
import { letterKind } from './kind.js';

export interface MailDigestParams {
  blocks: DigestAccountBlock[];
  /** Grouped mode: one line per group with unread. */
  groups?: DigestGroupLine[];
  now: number;
}

export interface MailDigestWords {
  subject: (unread: number, accounts: number) => string;
  text: (unread: number, accounts: number, snapshot: string) => string;
  groupedHeadline: (need: number, sorted: number) => string;
  groupedSubject: (headline: string) => string;
  groupedText: (headline: string, snapshot: string) => string;
  /** Appended to an account heading. */
  blockUnread: (unread: number) => string;
  openMail: string;
  moreItems: (count: number) => string;
  moreAccounts: (count: number) => string;
  moreGroups: (count: number) => string;
  /** `label` is escaped already. */
  groupLine: (label: string, unread: number) => string;
  sortedHeading: string;
  nothingNeedsYou: string;
  snapshotAt: (iso: string) => string;
  snapshotUnknown: string;
  noSender: string;
  noSubject: string;
  summaryUnavailable: string;
  sourceMissing: string;
  dateUnknown: string;
  justNow: string;
  minutesAgo: (n: number) => string;
  hoursAgo: (n: number) => string;
  daysAgo: (n: number) => string;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export const MAIL_DIGEST_WORDS: ByLang<MailDigestWords> = {
  en: {
    subject: (unread, accounts) => `Mail digest: ${unread} unread across ${plural(accounts, 'account')}`,
    text: (unread, accounts, snapshot) => `${unread} unread across ${plural(accounts, 'account')}. ${snapshot}`,
    groupedHeadline: (need, sorted) => `${need} need you · ${sorted} sorted into groups`,
    groupedSubject: (headline) => `Mail digest: ${headline}`,
    groupedText: (headline, snapshot) => `${headline}. ${snapshot}`,
    blockUnread: (unread) => ` (${unread} unread)`,
    openMail: 'Open Mail',
    moreItems: (n) => `and ${n} more`,
    moreAccounts: (n) => `and ${plural(n, 'more account')}`,
    moreGroups: (n) => `and ${plural(n, 'more group')}`,
    groupLine: (label, unread) => `- ${label}: ${unread} unread`,
    sortedHeading: '### Sorted into groups',
    nothingNeedsYou: 'Nothing needs you.',
    snapshotAt: (iso) => `Mailbox snapshot at ${iso}`,
    snapshotUnknown: 'Mailbox counts in this summary are a snapshot, not live status.',
    noSender: '(no sender)',
    noSubject: '(no subject)',
    summaryUnavailable: 'Email summary unavailable',
    sourceMissing: ' [Email actions unavailable: source identity missing]',
    dateUnknown: 'date unknown',
    justNow: 'just now',
    minutesAgo: (n) => `${n}m ago`,
    hoursAgo: (n) => `${n}h ago`,
    daysAgo: (n) => `${n}d ago`,
  },
  zh: {
    subject: (unread, accounts) => `邮件摘要：${accounts} 个账户共 ${unread} 封未读`,
    text: (unread, accounts, snapshot) => `${accounts} 个账户共 ${unread} 封未读。${snapshot}`,
    groupedHeadline: (need, sorted) => `${need} 封需要你处理 · ${sorted} 封已分组`,
    groupedSubject: (headline) => `邮件摘要：${headline}`,
    groupedText: (headline, snapshot) => `${headline}。${snapshot}`,
    blockUnread: (unread) => `（${unread} 封未读）`,
    openMail: '打开邮件',
    moreItems: (n) => `还有 ${n} 封`,
    moreAccounts: (n) => `还有 ${n} 个账户`,
    moreGroups: (n) => `还有 ${n} 个分组`,
    groupLine: (label, unread) => `- ${label}：${unread} 封未读`,
    sortedHeading: '### 已分组',
    nothingNeedsYou: '没有需要你处理的邮件。',
    snapshotAt: (iso) => `邮箱快照时间：${iso}`,
    snapshotUnknown: '本摘要里的数字是某一时刻的快照，不是实时状态。',
    noSender: '（无发件人）',
    noSubject: '（无主题）',
    summaryUnavailable: '暂无邮件摘要',
    sourceMissing: ' [无法对这封邮件操作：缺少来源标识]',
    dateUnknown: '日期未知',
    justNow: '刚刚',
    minutesAgo: (n) => `${n} 分钟前`,
    hoursAgo: (n) => `${n} 小时前`,
    daysAgo: (n) => `${n} 天前`,
  },
};

export const MAIL_DIGEST = letterKind<MailDigestParams>({
  id: 'mail-digest',
  // walnut.letters.send gives a letter with no actions its informational type.
  type: 'info',
  callers: ['src/integrations/mail/digest.ts'],
  marked: false,
  // A plugin letter carries no `createdByOp`; the mail plugin's only letter without buttons is this one.
  matchesUnmarked: (letter) => letter.sender?.pluginId === 'mail' && letter.type === 'info',
  render: (lang, { blocks, groups, now }) => {
    const w = MAIL_DIGEST_WORDS[lang];
    const { subject, markdown, text } = groups ? renderGroupedDigestIn(w, blocks, groups, now) : renderDigestIn(w, blocks, now);
    return { subject, markdown, text };
  },
  samples: [
    {
      blocks: [{
        accountId: 'work',
        label: 'Work',
        unread: 3,
        items: [{ sender: 'Bob', subject: 'Lunch?', sentAt: Date.UTC(2026, 0, 1, 11), account: 'work', message: 'm-1' }],
      }],
      now: Date.UTC(2026, 0, 1, 12),
    },
    {
      blocks: [],
      groups: [{ label: 'Build results', unread: 4 }],
      now: Date.UTC(2026, 0, 1, 12),
    },
  ],
  stillNeeded: { none: 'a daily report the user set up (or asked for from the Mail console): nothing in it to settle' },
});
