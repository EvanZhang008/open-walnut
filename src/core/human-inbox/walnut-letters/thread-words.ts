/**
 * Walnut's own words written into a letter's record rather than a letter of its own: the reason a
 * decision letter is settled when its task completes (decision-settle.ts), the lines Walnut puts
 * in front of a session's letter (the user's kind, a snoozed task), a withdrawal's thread turn,
 * and the reasons a kept-local task's letter is settled with. The user reads them on the letter, so they follow the letter
 * language like every Walnut letter (languages.ts; 2026-11-02 review: all were English, one of
 * them leading a Chinese letter).
 *
 * Every export here is a phrase table: tests/core/walnut-letters-ratchet.test.ts renders each in
 * every letter language, and fails on Walnut words written onto a letter from anywhere else.
 */
import type { UserKind } from '../../org/user-kind.js';
import type { ByLang } from './languages.js';

/** A decision letter settled because its task completed with it unanswered. `when` is "YYYY-MM-DD HH:MM" (UTC) or absent. */
export const COMPLETION_SETTLE_WORDS: ByLang<(title: string, when?: string) => string> = {
  en: (title, when) => `Its task "${title}" was completed${when ? ` on ${when} UTC` : ''} with this unanswered, so nothing waits on the answer.`,
  zh: (title, when) => `它的任务"${title}"${when ? `在 ${when} UTC ` : ''}完成时这封信还没回答，所以没有事情在等这个答案。`,
};

/** The user's kind as they read it in the line leading a decision letter (org/user-kind.ts). */
export const USER_KIND_LABELS: ByLang<Readonly<Record<UserKind, string>>> = {
  en: {
    outward: 'an outward message or post', spending: 'spending', credentials: 'a credential', permissions: 'a permission',
    cloud_delete: 'deleting cloud resources or data', irreversible: 'a hard-to-reverse choice', user_info: 'only you know this', user_own: 'your own matter',
  },
  zh: {
    outward: '对外发出的消息或帖子', spending: '花钱', credentials: '凭据', permissions: '权限',
    cloud_delete: '删除云上的资源或数据', irreversible: '难以撤回的选择', user_info: '只有你知道', user_own: '你自己的事',
  },
};

/** The line leading a session's decision letter: which of the user's kinds it is, and the session's reason. */
export const USER_KIND_LEAD_WORDS: ByLang<(kind: string, why: string) => string> = {
  en: (kind, why) => `Yours to decide (${USER_KIND_LABELS.en[kind as UserKind] ?? kind}): ${why}`,
  zh: (kind, why) => `由你决定（${USER_KIND_LABELS.zh[kind as UserKind] ?? kind}）：${why}`,
};

/** The line leading a letter about a snoozed task: until when, and the sender's reason for raising it now. */
export const SNOOZE_LEAD_WORDS: ByLang<(until: string, reason: string) => string> = {
  en: (until, reason) => `Snoozed until ${until}; raised now because: ${reason}`,
  zh: (until, reason) => `已延后到 ${until}；现在提出是因为：${reason}`,
};

/** The thread turn of a letter its sender took back, with the sender's note. */
export const WITHDRAWN_WORDS: ByLang<(note: string) => string> = {
  en: (note) => `Withdrawn: ${note}`,
  zh: (note) => `发件方已撤回：${note}`,
};

/** The answer recorded on a withdrawn letter. */
export const WITHDRAWN_LABEL_WORDS: ByLang<() => string> = {
  en: () => 'Withdrawn',
  zh: () => '已撤回',
};

/** A kept-local task's letter, settled because the user (or an agent at their words) decided in the task menu. */
export const HOLD_SETTLE_WORDS: ByLang<(how: string) => string> = {
  en: (how) => how === 'made_local' ? 'It was made local from the task menu'
    : how === 'agent_sent' ? 'An agent sent it, at the user\'s words' : 'You sent it from the task menu',
  zh: (how) => how === 'made_local' ? '已在任务菜单里设为仅本地'
    : how === 'agent_sent' ? '一个 agent 按你的话把它发了出去' : '你已在任务菜单里把它发了出去',
};

/** A kept-local task's letter, settled because its service's check is off and the task syncs again. */
export const HOLD_RELEASED_WORDS: ByLang<(service: string) => string> = {
  en: (service) => `Walnut no longer checks tasks before they sync to ${service}: the task syncs to it again`,
  zh: (service) => `Walnut 不再在任务同步到 ${service} 之前检查：这个任务又会同步过去了`,
};
