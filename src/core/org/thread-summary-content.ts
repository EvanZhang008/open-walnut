/**
 * A thread's summary must say something on its own (2026-11-23, the user, on a card whose whole
 * summary was "the stand-up summary for yesterday and today was given to you": "the thread should be
 * readable self contained, I don't know what you are talking about"; "you should not say you
 * already told me ... the summary should tell me which task, how it stands"). His card shows only
 * the title and the summary, so a summary that only points at an answer elsewhere (given, sent,
 * told, see above, in the chat) shows him nothing, and one that says his own message back (summaryRepeatsHim)
 * tells him nothing new. Every writer of a summary asks both:
 * a thread_update reply (threads-model.ts updateThread) and the status line (sessions/status-threads.ts patchForLine).
 * The rule in words is the status question's line format (sessions/status-threads.ts keptBlock) and these refusals: every
 * node's prompt is at its budget, and a rule the code enforces needs no line there. Pure.
 */

/** Phrases that only point at an answer given somewhere else (Chinese and English). */
const POINTERS: readonly RegExp[] = [
  // "already given / told / sent / replied to you (the user)"; never him or them, who in a summary are a colleague or a vendor
  /(?:\u5df2|\u5df2\u7ecf|\u90fd)(?:\u7ecf)?[^\uff0c\u3002,.;\uff1b]{0,8}?(?:\u7ed9|\u544a\u8bc9|\u544a\u77e5|\u53d1\u7ed9|\u56de\u590d|\u7b54\u590d|\u8f6c\u7ed9|\u8bf4\u7ed9|\u8bb2\u7ed9|\u6c47\u62a5\u7ed9|\u540c\u6b65\u7ed9|\u4ea4\u7ed9|\u53d1\u9001\u7ed9|\u63d0\u4f9b\u7ed9)(?:\u4e86)?(?:\u4f60|\u60a8|\u7528\u6237)/i,
  // "already answered / said in the chat or reply"
  /(?:\u5df2|\u5df2\u7ecf)(?:\u5728)?(?:\u804a\u5929|\u5bf9\u8bdd|\u4f1a\u8bdd|chat|\u56de\u590d|\u56de\u7b54)(?:\u91cc|\u4e2d|\u4e0a)?(?:\u8bf4|\u8bb2|\u56de|\u7b54|\u7ed9|\u5199|\u53d1)/i,
  // "see above / see the chat / as above"
  /(?:\u89c1|\u8be6\u89c1|\u53c2\u89c1|\u770b)(?:\u4e0a|\u4e0a\u6587|\u4e0a\u9762|\u524d\u9762|\u804a\u5929|\u5bf9\u8bdd|\u56de\u590d|chat)/i,
  /\u5982\u4e0a/,
  /^(?:\u5df2|\u5df2\u7ecf)?(?:\u56de\u590d|\u7b54\u590d|\u56de\u7b54|\u544a\u77e5|\u53d1\u9001|\u53d1\u51fa|\u7ed9\u51fa)(?:\u4e86)?$/,
  /\b(?:told|given|sent|shown|showed|gave|passed|handed|reported|delivered|explained|answered)\b[^.;]{0,40}?\b(?:you|the user)\b/i,
  /\b(?:answered|replied|covered|explained|posted|shared)\b[^.;]{0,20}?\b(?:in|on|at)\s+(?:the\s+|my\s+|our\s+)?(?:chat|reply|answer|thread|message)\b/i,
  /\bsee\s+(?:above|below|the\s+chat|my\s+(?:chat\s+)?(?:reply|answer|message))\b/i,
  /\bas\s+(?:above|said|mentioned)\b/i,
  /^(?:already\s+)?(?:answered|replied|sent|told)\.?$/i,
];

/**
 * Chinese forms of "a decision of his waits": wait for you to pick / confirm / nod (a few words may
 * stand between before a whole verb), please (you) pick, please answer once more, I need you to
 * answer, you pick one. Each is read in one clause, never after a "not" shortly before it (no need
 * to wait for you, no longer needs you), and never as a description (a verb followed by the
 * possessive particle: "the version that waited for your confirm", "the card you picked").
 */
const ASK_CJK: readonly RegExp[] = [
  /\u7b49(?:\u4f60|\u60a8)(?:\u6765)?(?:\u6311|\u9009|\u5b9a|\u62cd\u677f|\u51b3\u5b9a|\u6279|\u5ba1|\u786e\u8ba4|\u70b9\u5934|\u540c\u610f|\u4e00\u53e5|\u56de\u590d|\u8bf4)/,
  /\u7b49(?:\u4f60|\u60a8)[^\uff0c\u3002\uff1b,;]{1,14}?(?:\u70b9\u5934|\u540c\u610f|\u786e\u8ba4|\u62cd\u677f|\u51b3\u5b9a|\u6279\u51c6|\u56de\u590d|\u56de\u4e00\u53e5|\u6311\u4e00\u4e2a|\u9009\u4e00\u4e2a)/,
  /(?:\u8bf7|\u8ba9|\u7531)(?:\u4f60|\u60a8)(?:\u6765)?(?:\u518d)?(?:\u6311|\u9009|\u5b9a|\u62cd\u677f|\u51b3\u5b9a|\u786e\u8ba4|\u56de\u7b54|\u56de\u590d|\u6279)/,
  /\u8bf7\u518d(?:\u56de\u7b54|\u56de\u590d|\u786e\u8ba4|\u8bf4)/,
  /(?:\u9700\u8981|\u8981)(?:\u4f60|\u60a8)[^\uff0c\u3002\uff1b,;]{0,10}?(?:\u56de\u4e00\u53e5|\u56de\u590d|\u56de\u7b54|\u786e\u8ba4|\u51b3\u5b9a|\u62cd\u677f|\u70b9\u5934|\u540c\u610f|\u6311\u4e00\u4e2a|\u9009\u4e00\u4e2a)/,
  /(?:\u4f60|\u60a8)(?:\u6765)?(?:\u6311|\u9009)(?:\u4e00\u4e2a|\u54ea\u4e2a|\u4e00\u4e0b)/,
  // "pending your confirm", "please decide", "only your word is left", "you settle it", "tell me once".
  /\u5f85(?:\u4f60|\u60a8)(?:\u786e\u8ba4|\u5ba1\u6279|\u6279\u51c6|\u62cd\u677f|\u70b9\u5934|\u540c\u610f|\u51b3\u5b9a)/,
  /^\u8bf7(?:\u62cd\u677f|\u786e\u8ba4|\u6279\u51c6|\u5ba1\u6279|\u51b3\u5b9a|\u6311\u4e00\u4e2a|\u9009\u4e00\u4e2a)/,
  /\u53ea\u5dee\u4f60(?:\u4e00\u53e5|\u70b9\u5934|\u786e\u8ba4|\u540c\u610f|\u62cd\u677f)/,
  /(?:\u4f60|\u60a8)(?:\u5b9a\u4e00\u4e0b|\u62cd\u4e2a\u677f|\u770b\u8981\u4e0d\u8981|\u540c\u610f\u7684\u8bdd|\u8bf4\u4e00\u58f0)/,
  /\u56de\u6211\u4e00\u53e5/,
  /(?:\u4f60|\u60a8)(?:\u51b3\u5b9a\u4e00\u4e0b|\u62cd\u677f|\u770b\u7528\u54ea)/,
  /\u5982\u679c(?:\u4f60|\u60a8)\u540c\u610f/,
];
/** A "not" this close before a Chinese ask turns it into a result: not, no, never, without, no need, no longer. */
const NOT_CJK = /[\u4e0d\u6ca1\u65e0\u522b\u672a\u52ff\u514d]/;
/** Words that hold such a character and say no "not": no problem, whatever, the other, free, not bad, different. */
const NOT_CJK_WORDS = /\u6ca1\u95ee\u9898|\u4e0d\u7ba1|\u65e0\u8bba|\u522b\u7684|\u514d\u8d39|\u4e0d\u9519|\u4e0d\u540c/g;
const notBefore = (c: string, at: number): boolean => NOT_CJK.test(c.slice(Math.max(0, at - NOT_CJK_BEFORE), at).replace(NOT_CJK_WORDS, ''));
const NOT_CJK_BEFORE = 6;
/** The particle that makes the verb before it a description. */
const OF = '\u7684';
/** English: a decision noun is named, never "waiting for your Mac" or a bare "waits on you". */
const ASK_EN = /\b(?:for\s+you\s+to\s+(?:pick|choose|decide|approve|confirm)|wait(?:s|ing)?\s+on\s+you\s+to\s+(?:pick|choose|decide|approve|confirm)|can\s+you\s+(?:confirm|approve|pick|choose|decide)|let\s+me\s+know\s+(?:if\s+I\s+should|which)|if\s+you(?:'re|\s+are)\s+ok\s+with|wait(?:s|ing)?\s+(?:on|for)\s+your\s+(?:pick|call|choice|decision|approval|consent|yes|ok|go-ahead|nod|sign-off|answer)|needs\s+your\s+(?:pick|call|choice|decision|approval|consent|yes|ok|go-ahead|sign-off))\b/i;
const NOT_EN = /\b(?:no|not|never|nothing|without|don't|doesn't|isn't|aren't|won't)\b/i;
/** The clauses a summary is read in. */
const CLAUSE = /[\uff0c\u3002\uff1b\uff1a\uff01\uff1f\u3001,;:!?\n]|\.(?!\d)/;

/** One clause says a decision of his waits now. */
function clauseAsks(c: string): boolean {
  for (const re of ASK_CJK) {
    const m = re.exec(c);
    if (!m) continue;
    const end = m.index + m[0].length;
    if (c[end] === OF || notBefore(c, m.index)) continue;
    return true;
  }
  const e = ASK_EN.exec(c);
  return !!e && !NOT_EN.test(c.slice(0, e.index));
}

/** Past or present, a decision is named ("your pick is live"): for the pointer rule only. */
const NAMES_DECISION = /\b(?:your\s+(?:pick|call|choice|decision|approval)|(?:pick|choose)\s+one)\b/i;

/** The card asks him to decide something, or names a decision of his (asksHimNow, NAMES_DECISION). Pure. */
export function asksHimToDecide(text: string | null | undefined): boolean {
  const t = (text ?? '').replace(/\s+/g, ' ');
  return asksHimNow(t) || NAMES_DECISION.test(t);
}

/**
 * Asks read on the whole text, since the clause split drops their mark: a question to him ("post it or not?",
 * "should I ship it?", "do you want A or B?") unless it is answered right after ("roll back? No, it is fixed"), and
 * "your call: A or B". Never "should I have ...".
 */
const ASK_WHOLE = /(?:\u8981\u4e0d\u8981[^\u3002\uff1f\uff01?!]{0,20}[\uff1f?]|\bshould\s+I\b(?!\s+have\b)[^.?!]{0,40}\?|\bdo\s+you\s+want\b[^.?!]{0,40}\bor\b[^.?!]{0,40}\?|\byour\s+call\s*[:\uff1a])/gi;
/** An answer that follows the question at once: it was asked and answered in place. */
const ANSWERED_AFTER = /^\s*(?:\u4e0d\u7528|\u4e0d\u8981|\u4e0d\u9700\u8981|\u6ca1\u6709|\u4e0d[\uff0c,]|no\b|not\b|yes\b)/i;
/** Quoted words are someone else's (a bot's message, a rule's text), never his decision. */
const QUOTED = /"[^"]*"|\u201c[^\u201d]*\u201d|\u300c[^\u300d]*\u300d/g;

/**
 * The words say a decision of his waits now ("waiting for your nod", "please answer once more"),
 * read clause by clause: never a past pick ("your pick is live"), a "not" before it ("no need to
 * wait for your OK", "nothing waits on you"), or a description ("the card you picked"). 2026-11-24,
 * the threads inspection: four live cards asked him to decide from Done, with no buttons and nothing
 * in his Needs you, one of them after he had answered five times; its review: a result that only
 * mentions him must never be pushed into a fake Needs you. Pure.
 */
export function asksHimNow(text: string | null | undefined): boolean {
  const t = (text ?? '').replace(/\s+/g, ' ').replace(QUOTED, ' ');
  for (const q of t.matchAll(ASK_WHOLE)) {
    const at = q.index ?? 0;
    // Its own sentence only: a "no" in the sentence before ("No errors. Should I ship it?") says nothing of it.
    const sentence = t.slice(Math.max(0, at - 24), at).split(/[.!?\u3002\uff01\uff1f]/).pop() ?? '';
    if (notBefore(t, at) || NOT_EN.test(sentence) || ANSWERED_AFTER.test(t.slice(at + q[0].length))) continue;
    return true;
  }
  return t.split(CLAUSE).some((c) => clauseAsks(c.trim()));
}

/** Why a summary that asks him to decide may not stand on a thread out of his Needs you. */
export const ASKS_OUTSIDE_NEEDS = 'This summary asks him to decide, but the thread would not be in his Needs you: it reads '
  + 'as a result with no buttons, and he may never see it is his. Hand it to him (state needs, with user_kind and user_kind_why, '
  + 'and options when he picks among choices), or write only the result here and ask nothing.';

/**
 * Words that put what the card is about on another card or thread: "\u653e\u5230\u2026\u5361\u4e0a" (put on
 * the ... card), "\u53e6\u4e00\u5f20\u5361" (another card), a card named in quotes, "on the pick card", a thread id.
 */
const ON_ANOTHER_CARD: readonly RegExp[] = [
  /(?:\u653e|\u6302|\u5199|\u8d34|\u79fb|\u642c|\u53d1|\u5217|\u5408)(?:\u5230|\u5728|\u8fdb)[^\uff0c\u3002\uff1b,;]{0,14}?(?:\u5361\u7247|\u5361|\u7ebf\u7a0b)/,
  /(?:\u53e6\u4e00\u5f20|\u53e6\u5916\u4e00\u5f20|\u90a3\u5f20|\u65b0\u7684\u90a3\u5f20|\u65b0\u90a3\u5f20)(?:\u5361\u7247|\u5361)/,
  /[\u201c"\u300c\u300e][^\u201d"\u300d\u300f]{1,16}[\u201d"\u300d\u300f]\s*(?:\u5361\u7247|\u5361|\u7ebf\u7a0b)/,
  /\b(?:on|in)\s+(?:the|another|a\s+separate|that|its\s+own|a\s+new)\s+[\w"' -]{0,24}?(?:card|thread)\b/i,
  // "\u5728 X \u4efb\u52a1\u91cc\u7b49\u4f60\u51b3\u5b9a" (waiting for your decision in task X), "\u5728\u2026\u90a3\u91cc\u7531\u4f60\u51b3\u5b9a"
  /\u5728[^\uff0c\u3002\uff1b,;]{0,20}?(?:\u4efb\u52a1|\u7ebf\u7a0b|\u5361\u7247|\u5361)(?:\u91cc|\u90a3\u91cc|\u90a3\u8fb9|\u4e0a|\u4e2d)/,
  /\b(?:in|on)\s+(?:the\s+)?[\w"' -]{0,24}?\btask\b/i,
  /\bth-[0-9a-f]{6,}\b/,
];

/** A proof (a path or URL) is content by itself: a summary with one is never pointer-only. */
const PROOF_RE = /(?:https?:\/\/\S+|(?:^|\s)\/[\w.\-/]+\.\w{2,5}\b|\blt-[a-z0-9]+\b)/i;

/** What a clause carries, in words: two CJK characters count as one word. */
function units(clause: string): number {
  const cjk = clause.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const words = clause.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9][\w\-.]*/g)?.length ?? 0;
  return Math.ceil(cjk / 2) + words;
}

/** A clause shorter than this, beside a pointer, names only what was given ("the summary"), not what it says ("live on prod" does). */
const SHORT_CLAUSE = 3;
/** After its pointer, a clause that goes on this long says what happened ("already gave you the three tasks deadlines"). */
const SAYS_MORE = 4;
/**
 * What a pointer is followed by when it only names what was told: an open question ("told you where
 * the task is"; in Chinese the question word comes last: "told you which two tasks they are, where").
 * The answer itself, when there is one, is a clause of its own after it ("...: tomorrow 10:00").
 */
const OPEN_QUESTION = /^(?:where|which|what|how|when|who|why|whether)\b|\u54ea|\u4ec0\u4e48|\u600e\u4e48|\u5982\u4f55|\u591a\u5c11|\u4e3a\u4ec0\u4e48/i;

/** The clause only points elsewhere: a pointer, and after it nothing but an open question or a few words. */
function pointsOnly(clause: string): boolean {
  for (const re of POINTERS) {
    const m = re.exec(clause);
    if (!m) continue;
    const after = clause.slice(m.index + m[0].length).trim();
    if (units(after) < SAYS_MORE || OPEN_QUESTION.test(after)) return true;
  }
  return false;
}

/**
 * Why `summary` says nothing on its own, or null when it does. It points elsewhere when every
 * clause either points at an answer given somewhere else (and says nothing more after the pointer)
 * or is too short to carry one, and at least one clause points. A summary with a proof (a path, a
 * URL, a letter id) always says something.
 */
export function summaryPointsElsewhere(summary: string | null | undefined): string | null {
  const text = (summary ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // He is asked to decide, and what to decide is on another card: his card must hold it. A proof
  // beside it (a path, a link) does not hold the choices (the threads inspection, 2026-11-24).
  if (asksHimToDecide(text) && ON_ANOTHER_CARD.some((re) => re.test(text))) {
    return 'This summary asks him to decide but sends him to another card for the choices, and he may not find it: '
      + 'put the choices and your pick on this card (thread_update: state needs, with options), or, when the other card '
      + 'holds the decision, say only this card\'s own result here.';
  }
  if (PROOF_RE.test(text)) return null;
  // A dot, colon or comma between digits is part of a number, a version or a time ("1.35", "10:30").
  const clauses = text.split(/(?:[\u3002\uff0e!\uff01?\uff1f;\uff1b\uff1a\uff0c\u3001\n]|(?<!\d)[.:,]|[.:,](?!\d))+/).map((c) => c.trim()).filter(Boolean);
  let pointed = false;
  for (const c of clauses) {
    if (pointsOnly(c)) { pointed = true; continue; }
    if (units(c) >= SHORT_CLAUSE) return null;
  }
  return pointed
    ? 'This summary only says the answer was given somewhere else, and his card shows nothing else: write the answer itself, '
      + 'readable by someone who never saw your chat (the result or the question, naming the task by its title and where it '
      + 'stands). A thread with nothing left for him is done (close it).'
    : null;
}

/** A run of his own words this long, found in a summary, is his message said back to him. */
const HIS_RUN_CJK = 20;
const HIS_RUN = 70;
/** His words as compared: a path, a link, an id or code he gave is proof the summary may repeat. */
const flat = (text: string): string => text
  .replace(/`[^`]*`|https?:\/\/\S+|(?:~|\.{0,2})\/[\w.\-/]+|\b(?:lt|th|tm|rq)-[\w-]+/g, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Why `summary` repeats the user's own words, or null (2026-11-23, the user, on a card that opened
 * with his voice message quoted: "it repeats my question completely ... my words are sometimes
 * messy; summarize it, or just say the matter"). `his`: his messages in the thread. A short phrase
 * of his is fine; a run of 70 characters (20 when it is mostly CJK) is his message again, paths, links,
 * ids and code aside (they are proof). Pure.
 */
export function summaryRepeatsHim(summary: string | null | undefined, his: readonly string[]): string | null {
  const text = flat(summary ?? '');
  if (text.length < HIS_RUN_CJK) return null;
  for (const raw of his.slice(-6)) {
    const words = flat(raw);
    const cjk = (words.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0) * 2 >= words.length;
    const run = cjk ? HIS_RUN_CJK : HIS_RUN;
    for (let i = 0; i + run <= words.length; i += 4) {
      if (text.includes(words.slice(i, i + run))) {
        return 'This summary repeats the user\'s own message back to them. Say the matter in one line in your own words '
          + '(what it is and where it stands), never their words again.';
      }
    }
  }
  return null;
}
