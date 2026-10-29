/**
 * A task answering a letter in the user's place quotes the user's own words, and an answer that
 * approves a step that is hard to undo or leaves Walnut needs words that name that step.
 *
 * 2026-10-29: Main answered two letters for the user from one ambiguous voice line ("clear
 * everything"), and its answers approved a rewrite of public git history and an npm unpublish.
 * The user reversed it three minutes later ("no need to rewrite history, no need to withdraw"),
 * after one outward edit had already gone out. Answering for the user stays an agent action (AGENTS.md,
 * "Every human action is an agent action too"); what this adds is the team charter's approval rule
 * for outward and irreversible steps: the user's own words are the approval, so they are recorded
 * (`LetterAnsweredBy.userWords`) and must name the step they approve.
 *
 * The steps are found by words in the answer (the option's label and description, or the reply's
 * text, plus the note beside a pick), English and Chinese. An answer that asks for a step needs
 * user's words that ask for it too ("do not rewrite history" asks for no rewrite); a step the
 * answer only rules out ("keep it, do not rewrite") approves nothing. A "negation" that urges the
 * step ("don't forget to delete") asks for it. An answer that carries no meaning of its own ("Yes", "Option A", "as you recommend", "go
 * ahead") is read with the letter's subject and preview, since that is what it says yes to. Naming
 * the option is not enough: "all as recommended" does not name the deletes the recommendation
 * holds, and one vague line is exactly how 10-29 went.
 */
import type { LetterAction } from './types.js';

export interface RiskyStep { id: string; label: string; re: RegExp }

/** The kinds of step the team charter keeps for the user: outward, irreversible, spending, credentials. */
export const RISKY_STEPS: readonly RiskyStep[] = [
  { id: 'history', label: 'rewriting git history or force-pushing', re: /\brewrit|\bforce[- ]?push|\bpush[ \t]+(?:[^\s;|&]+[ \t]+){0,4}?(?:-f\b|--force)|filter-(?:repo|branch)|\breset\s+--hard|\bsquash(?!\s+(?:and|&)\s+merge)|\u6539\u5199|\u91cd\u5199|\u5f3a\u63a8|\u5f3a\u5236\u63a8\u9001/i },
  { id: 'unpublish', label: 'unpublishing, deprecating or withdrawing a release', re: /\bunpublish|\bdeprecat|\byank|\bretract|\bwithdraw|\u64a4\u56de|\u6536\u56de|\u64a4\u9500|\u64a4\u4e0b|\u4e0b\u67b6|\u4e0b\u7ebf/i },
  { id: 'delete', label: 'deleting something', re: /\bdelet|\bremov|\bwipe|\bpurg|\berase|\bdestroy|\bdrop\b|\u5220|\u9500\u6bc1|\u79fb\u9664|\u62b9\u6389/i },
  { id: 'outward', label: 'publishing or sending something outside Walnut', re: /\bpublish|\bpost(?:ing)? (?:it|to|on|the)\b|\btweet|\bsend (?:it|them|the|an?|to)\b|\bemail (?:them|him|her|the)\b|\bpush(?:ed|ing)? (?:it )?to\b|\bmake (?:it )?public|\u53d1\u5e03|\u53d1\u5e16|\u53d1\u9001|\u53d1\u7ed9|\u53d1\u51fa|\u63a8\u5230|\u63a8\u4e0a|\u516c\u5f00/i },
  { id: 'spend', label: 'spending money', re: /\bbuy\b|\bpurchas|\bpay\b|\bpayment|\bsubscrib|\bspend|\u8d2d\u4e70|\u4ed8\u6b3e|\u4ed8\u8d39|\u82b1\u94b1|\u8ba2\u9605/i },
  { id: 'access', label: 'credentials or permissions', re: /\brotat|\brevok|\bpassword|\bcredential|\bapi[- ]?key|\bpermission|\bgrant (?:access|it)|\u5bc6\u7801|\u8f6e\u6362|\u540a\u9500|\u6743\u9650|\u6388\u6743/i },
];

/** A negation right before a match: the step is ruled out there, not asked for. */
const NEGATED = /(?:\b(?:don'?t|do not|does not|did not|not|no need to|never|without|no)\s+(?:\w+\s+){0,2}|(?:\u4e0d\u8981|\u4e0d\u7528|\u4e0d\u5fc5|\u65e0\u9700|\u4e0d\u9700\u8981|\u6ca1\u6709\u5fc5\u8981|\u522b|\u4e0d|\u52ff|\u672a)[^\uff0c\u3002,.;\uff1b!?\uff01\uff1f\n]{0,3})$/i;
/** A "negation" that urges the step instead ("don't forget to delete", "\u522b\u5fd8\u4e86\u5220"). */
const URGES = /forget|hesitat|worr|wait to|\u5fd8|\u7136/i;

function matches(step: RiskyStep, text: string): Array<{ negated: boolean }> {
  const out: Array<{ negated: boolean }> = [];
  const re = new RegExp(step.re.source, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    out.push({ negated: NEGATED.test(before) && !URGES.test(before) });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** Does the text ask for this step somewhere (a match not ruled out by a negation just before it)? */
function asksFor(step: RiskyStep, text: string): boolean {
  return matches(step, text).some((m) => !m.negated);
}

/** The steps a piece of text asks for. */
export function stepsIn(text: string): RiskyStep[] {
  return text ? RISKY_STEPS.filter((s) => asksFor(s, text)) : [];
}

/** An answer that says only yes: what it approves is in the letter, not in it. */
const BARE_YES = /^[\s"'\u201c\u201d]*(?:yes|yep|yeah|ok(?:ay)?|sure|approved?|go(?:\s+ahead)?|do\s+it|confirm(?:ed)?|accept(?:ed)?|agreed?|proceed|lgtm|ship\s+it|sounds\s+good|please|\u540c\u610f|\u597d\u7684?|\u53ef\u4ee5|\u884c|\u662f\u7684?|\u5bf9|\u786e\u8ba4|\u6279\u51c6|\u7ee7\u7eed|\u6ca1\u95ee\u9898|\u5c31\u8fd9\u6837)(?:[\s,.!\uff0c\u3002\uff01\u3001]+(?:yes|yep|yeah|ok(?:ay)?|sure|approved?|go(?:\s+ahead)?|do\s+it|confirm(?:ed)?|accept(?:ed)?|agreed?|proceed|lgtm|ship\s+it|sounds\s+good|please|\u540c\u610f|\u597d\u7684?|\u53ef\u4ee5|\u884c|\u662f\u7684?|\u5bf9|\u786e\u8ba4|\u6279\u51c6|\u7ee7\u7eed|\u6ca1\u95ee\u9898|\u5c31\u8fd9\u6837|with|both|all|it|them|everything|that|\u90fd|\u5168\u90e8|\u5427))*[\s.!\u3002\uff01]*$/i;

export function isBareYes(text: string): boolean {
  return BARE_YES.test(text.trim());
}

/** An answer that points at something else: an option by letter or number, the recommendation, "that one". */
const POINTS_AWAY = /recommend|suggest|proposal|your call|as you said|the (?:first|second|third|former|latter|above)|that one|this one|\u63a8\u8350|\u5efa\u8bae|\u7167\u4f60|\u6309\u4f60|\u5c31\u6309|\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94]\u4e2a|\u4e0a\u9762|\u90a3\u4e2a|\u8fd9\u4e2a/i;
const OPTION_TOKEN = /^[\s"'\u201c\u201d]*(?:option|plan|choice|\u9009\u9879?|\u65b9\u6848)?\s*[a-z0-9\u4e00\u4e8c\u4e09\u56db\u4e94]\s*[.:)\uff09\uff1a]?[\s"'\u201c\u201d]*$/i;

/** Does this answer carry no meaning of its own, so the letter says what it approves? */
export function pointsAway(text: string): boolean {
  const t = text.replace(/[(\uff08][^()\uff08\uff09]*[)\uff09]\s*$/u, '').trim();
  return !t || isBareYes(t) || OPTION_TOKEN.test(t) || POINTS_AWAY.test(t);
}

export type AnswerCheck =
  | { ok: true }
  | { ok: false; code: 'user_words'; message: string }
  | { ok: false; code: 'human_approval'; message: string; steps: string[] };

export const USER_WORDS_MIN = 2;

/**
 * Judge a task's answer for the user. `userWords` are the user's own words, quoted by the task;
 * `letter` is what the letter asks (its subject and preview), read when the answer points at it.
 * Pure; letter-ops.ts throws on a refusal.
 */
export function checkTaskAnswer(input: {
  action?: Pick<LetterAction, 'id' | 'label' | 'description'>;
  /** A reply's text, or the note beside a pick. */
  text?: string;
  userWords?: string;
  letter?: { subject?: string; preview?: string };
}): AnswerCheck {
  const words = (input.userWords ?? '').trim();
  if (words.length < USER_WORDS_MIN) {
    return {
      ok: false, code: 'user_words',
      message: 'Answering for the user needs the user\'s own words: pass user_words with exactly what they said '
        + '(quoted, in their language) that names this answer. Without them, tell the user what you would answer '
        + 'and let them answer the letter.',
    };
  }
  const own = [input.action?.label, input.action?.description, input.text].filter((t): t is string => !!t?.trim()).join('\n');
  const vague = input.action
    ? pointsAway(input.action.label) || (!!input.text?.trim() && pointsAway(input.text))
    : pointsAway(input.text ?? '');
  const context = vague ? [input.letter?.subject, input.letter?.preview].filter((t): t is string => !!t?.trim()).join('\n') : '';
  const answer = context ? `${own}\n${context}` : own;
  // A step the answer asks for needs words asking for it; one it only rules out approves nothing.
  const unnamed = RISKY_STEPS.filter((s) => asksFor(s, answer) && !asksFor(s, words));
  if (!unnamed.length) return { ok: true };
  const list = unnamed.map((s) => s.label).join('; ');
  return {
    ok: false, code: 'human_approval', steps: unnamed.map((s) => s.id),
    message: `Not answered: this answer approves ${list}, which is hard to undo or leaves Walnut, and the user's words `
      + `you quoted ("${words.length > 160 ? `${words.slice(0, 160)}\u2026` : words}") do not name that step. `
      + 'Ask the user about that step by name, or let them answer the letter themselves.',
  };
}
