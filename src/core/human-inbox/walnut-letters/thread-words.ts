/**
 * Walnut's own words written into a letter's record rather than a letter of its own: the reason a
 * decision letter is settled when its task completes (decision-settle.ts) and the away thread's
 * "needs your answer" turn (away-thread.ts). The user reads both on the letter, so they follow the
 * letter language like every Walnut letter (languages.ts; 2026-11-02 review: both were English).
 */
import type { ByLang } from './languages.js';

/** A decision letter settled because its task completed with it unanswered. `when` is "YYYY-MM-DD HH:MM" (UTC) or absent. */
export const COMPLETION_SETTLE_WORDS: ByLang<(title: string, when?: string) => string> = {
  en: (title, when) => `Its task "${title}" was completed${when ? ` on ${when} UTC` : ''} with this unanswered, so nothing waits on the answer.`,
  zh: (title, when) => `它的任务"${title}"${when ? `在 ${when} UTC ` : ''}完成时这封信还没回答，所以没有事情在等这个答案。`,
};

/** The away thread's turn pointing at a decision letter of its own. */
export const DECISION_NOTE_WORDS: ByLang<(subject: string) => string> = {
  en: (subject) => `Needs your answer: "${subject}", in its own letter, where one tap answers it.`,
  zh: (subject) => `需要你回答："${subject}"，在它自己的那封信里，点一下就能回答。`,
};
