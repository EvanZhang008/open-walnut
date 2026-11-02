/**
 * "Budget reached / Budget paused": a session's budget paused it (usage/session-budget.ts). One
 * letter per pause, marked `budget-paused:<pauseId>`.
 *
 * No longer needed once its session is no longer paused (the budget was raised or removed, the
 * session went away) or its task is complete: the budget sweep records which pauses each host still
 * holds (session-budget.ts `pausesSeen`), and a pause its host no longer lists is over.
 */
import type { ByLang, LetterLang } from './languages.js';
import { letterKind } from './kind.js';

export interface BudgetPausedParams {
  title: string;
  reason?: string;
  spentUsd?: number | null;
  limitUsd?: number | null;
  unpricedModel?: string;
  checkError?: string;
  stopError?: string;
}

interface Words {
  unknown: string;
  aSession: string;
  aModel: string;
  subjectUnpriced: (title: string) => string;
  subjectUnreadable: (title: string) => string;
  subjectReached: (title: string, spent: string) => string;
  paused: (title: string) => string;
  whyUnpriced: (model: string, spent: string, limit: string) => string;
  whyUnreadable: (error: string | undefined, spent: string, limit: string) => string;
  whyReached: (spent: string, limit: string) => string;
  stopFailed: (error: string) => string;
  stopped: string;
  nextUnpriced: string;
  nextUnreadable: string;
  nextReached: string;
  over: string;
  taskDone: string;
}

const WORDS: ByLang<Words> = {
  en: {
    unknown: 'unknown',
    aSession: 'A session',
    aModel: 'a model',
    subjectUnpriced: (t) => `Budget paused "${t}": a request had no price`,
    subjectUnreadable: (t) => `Budget paused "${t}": its usage could not be read`,
    subjectReached: (t, spent) => `Budget reached: "${t}" paused at ${spent}`,
    paused: (t) => `**${t}** was paused.`,
    whyUnpriced: (model, spent, limit) => `It made a request on **${model}**, which has no price in Walnut's price list, so its spend could not be counted. Spent so far on priced requests: ${spent} of ${limit}.`,
    whyUnreadable: (error, spent, limit) => `Its usage could not be read for a minute, so its spend is unknown${error ? ` (${error})` : ''}. Last known: ${spent} of ${limit}.`,
    whyReached: (spent, limit) => `It spent ${spent}, at or over its ${limit} budget.`,
    stopFailed: (error) => `The stop could not be confirmed (${error}); it is retried on every check, and no new message is sent to it.`,
    stopped: 'Its process was stopped and no new message is sent to it.',
    nextUnpriced: 'To continue, add a price for that model under usage prices in Settings, or raise or remove the budget in the session\'s Usage & Budget.',
    nextUnreadable: 'Once its usage can be read again and it is under the budget, your next message goes through. You can also remove the budget in the session\'s Usage & Budget.',
    nextReached: 'To continue, raise or remove the budget in the session\'s Usage & Budget, then send a message.',
    over: 'Not needed any more: the session is no longer paused by its budget.',
    taskDone: 'Not needed any more: its task is complete.',
  },
  zh: {
    unknown: '未知',
    aSession: '一个会话',
    aModel: '某个模型',
    subjectUnpriced: (t) => `预算暂停了"${t}"：有一次请求没有价格`,
    subjectUnreadable: (t) => `预算暂停了"${t}"：读不到它的用量`,
    subjectReached: (t, spent) => `预算用完："${t}"在花费 ${spent} 时暂停`,
    paused: (t) => `**${t}** 已暂停。`,
    whyUnpriced: (model, spent, limit) => `它向 **${model}** 发了请求，而 Walnut 的价格表里没有这个模型的价格，所以无法计算花费。有价格的请求目前花了 ${spent}，预算 ${limit}。`,
    whyUnreadable: (error, spent, limit) => `已经一分钟读不到它的用量，所以花费未知${error ? `（${error}）` : ''}。最后一次读到：${spent}，预算 ${limit}。`,
    whyReached: (spent, limit) => `它花了 ${spent}，达到或超过了 ${limit} 的预算。`,
    stopFailed: (error) => `没能确认它已停止（${error}）；每次检查都会重试，也不会再给它发新消息。`,
    stopped: '它的进程已停止，也不会再给它发新消息。',
    nextUnpriced: '要继续，请在"设置"的用量价格里给这个模型加上价格，或在会话的"用量与预算"里提高或去掉预算。',
    nextUnreadable: '等它的用量能再读到且低于预算时，你的下一条消息就会发出去。你也可以在会话的"用量与预算"里去掉预算。',
    nextReached: '要继续，请在会话的"用量与预算"里提高或去掉预算，然后发一条消息。',
    over: '不再需要：这个会话已不再被预算暂停。',
    taskDone: '不再需要：它的任务已完成。',
  },
};

/** Dollars as the letter says them; "unknown" in the letter's language when not a number. */
export function budgetMoney(n: number | null | undefined, lang: LetterLang = 'en'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return WORDS[lang].unknown;
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

export function budgetSettleReason(lang: LetterLang, why: 'over' | 'taskDone'): string {
  return WORDS[lang][why];
}

export const BUDGET_PAUSED = letterKind<BudgetPausedParams>({
  id: 'budget-paused',
  type: 'review',
  callers: ['src/core/usage/session-budget.ts'],
  marked: true,
  render: (lang, b) => {
    const w = WORDS[lang];
    const title = b.title || w.aSession;
    const short = title.slice(0, 80);
    const spent = budgetMoney(b.spentUsd, lang);
    const limit = budgetMoney(b.limitUsd, lang);
    const why = b.reason === 'unpriced' ? w.whyUnpriced(b.unpricedModel ?? w.aModel, spent, limit)
      : b.reason === 'unreadable' ? w.whyUnreadable(b.checkError, spent, limit)
        : w.whyReached(spent, limit);
    return {
      subject: b.reason === 'unpriced' ? w.subjectUnpriced(short) : b.reason === 'unreadable' ? w.subjectUnreadable(short) : w.subjectReached(short, spent),
      markdown: [
        // Chinese runs sentences together; English puts a space between them.
        `${w.paused(title)}${lang === 'zh' ? '' : ' '}${why}`,
        b.stopError ? w.stopFailed(b.stopError) : w.stopped,
        b.reason === 'unpriced' ? w.nextUnpriced : b.reason === 'unreadable' ? w.nextUnreadable : w.nextReached,
      ].join('\n\n'),
    };
  },
  samples: [
    { title: 'Fix the build', spentUsd: 10.4, limitUsd: 10 },
    { title: 'Fix the build', reason: 'unpriced', unpricedModel: 'new-model', spentUsd: 1, limitUsd: 10, stopError: 'pid gone' },
    { title: 'Fix the build', reason: 'unreadable', checkError: 'timeout', spentUsd: 2, limitUsd: 10 },
  ],
  stillNeeded: {
    check: async (letter, ctx) => (await import('../../usage/session-budget.js')).budgetLetterSettleReason(letter, ctx),
  },
});
