/**
 * Step two of the reflection: one model call decides whether a candidate (signals.ts) is a real bad
 * decision of the session, and every claim it makes must be quoted from the record: the session's
 * own words, the user's, and the rule it broke. verifyFinding checks each quote word for word
 * against what the judge was shown, and a finding whose quotes do not match is dropped, so a
 * judge that invents a rule or a sentence produces nothing (2026-11-19, Walnut VP: "only catch
 * real bad decisions, with evidence: quote the session and the rule").
 */
import type { ReflectionSignal } from './signals.js';

export type FindingKind =
  | 'hack_to_avoid_change' | 'change_too_big_excuse' | 'broke_user_rule' | 'question_not_for_user'
  | 'unchecked_claim' | 'decided_differently' | 'too_many_rounds' | 'risky_retry' | 'other';

export interface Finding {
  kind: FindingKind;
  session_quote: string;
  user_quote: string;
  rule_quote: string;
  what_went_wrong: string;
  correct_action: string;
  /** The session's turns after the user's message already did the correct action in full. */
  already_fixed: boolean;
  /** The message to the session: what was wrong, the right way, what to do now. */
  correction: string;
  /** One or two sentences, general (no names of this case), that would have prevented it; '' when a listed one covers it. */
  guidance: string;
  /** The number of the listed guidance line it repeats, 0 for none. */
  same_as: number;
  skill: { name: string; description: string; text: string } | null;
}

export type Verdict =
  | { verdict: 'bad_decision'; finding: Finding }
  | { verdict: 'no_issue'; why: string }
  | { verdict: 'unverified'; why: string };

export interface JudgeInput {
  signal: ReflectionSignal;
  /** The task, as the user reads it. */
  taskTitle: string;
  /** The turns, rendered (context.ts renderTurns). */
  turnsText: string;
  /** When the moment is: the user's message judged (the last of them), or the decision ask's turn end. */
  momentAt: string;
  /** The session's turns only, and the user's only: what quotes are checked against. */
  sessionText: string;
  userText: string;
  /** The rules the session had to follow, each block headed: the user's standing rules, its lead's memory. */
  rulesText: string;
  /** The team guidance already written, one line each, numbered from 1. */
  guidance: readonly string[];
  /** The user's reply-language setting, which the correction is written in. */
  replyLanguage: string | null;
}

/** One model call; `nodeId` is the node whose reflection pays for it (Usage). */
export type CallModel = (system: string, user: string, nodeId?: string) => Promise<string>;

const SIGNAL_LINE: Record<ReflectionSignal, string> = {
  frustration: 'The user\'s message reads frustrated or angry. Find out whether the session did something that earned it.',
  overruled: 'The user\'s message turns down what the session recommended or decided. Find out whether the session judged wrongly, and what rule or fact it missed.',
  many_rounds: 'The user sent many messages in a short time, several of them follow-up questions. Find out whether one clear answer could have settled it, and what made the extra rounds.',
  decision_ask: 'The session ended its turn asking the user to decide or approve, and the user has not read it yet. Find out whether what it recommends or asks is a bad decision.',
};

export const JUDGE_SYSTEM = [
  'You review one moment of a work session an AI agent ran for its user. Decide whether the session made a REAL bad decision, and only then say what it should have done.',
  'Bad decisions to look for:',
  '- hack_to_avoid_change: a workaround or shortcut chosen to keep the change small, instead of the correct change.',
  '- change_too_big_excuse: "many things depend on it" or "the change is too big" used as the reason not to make the correct change.',
  '- broke_user_rule: it went against one of the user\'s rules listed below (quote the rule).',
  '- question_not_for_user: it put to the user a choice that was not his to make (one it should have decided itself and reported).',
  '- unchecked_claim: it stated a cause, number or status as fact without having checked it.',
  '- decided_differently: it chose A and the user chose B, because it missed a rule or a fact it could have had.',
  '- risky_retry: it repeated or retried an action on something real the user owns (a real send from his account, a sign-in, a payment, a device) after a try failed, instead of stopping after one try to read the evidence.',
  '- too_many_rounds: the user needed several rounds for what one clear answer could settle (no conclusion first, half an answer, an unclear question).',
  'Judge what the user\'s message is ABOUT: the session actions it reacts to (usually the last SESSION turn before it, sometimes the run of turns that led to it; for a decision ask, the last SESSION turn; for many rounds, the rounds listed). A problem in an older turn the message is not about is no_issue here.',
  'NOT a bad decision (answer no_issue): the user simply preferred another reasonable option the session could not have known; the user is angry at himself, another person, a tool or the world, not at the session\'s work; the user is only asking to understand or for a summary; the session already did what was asked; the listed rules pull both ways on it (one says decide, another says ask him); anything you cannot quote.',
  'Evidence: session_quote is a short passage copied EXACTLY from a SESSION turn\'s text (not from a tool line); user_quote one copied exactly from a USER turn ("" only for a decision ask the user has not answered); rule_quote one copied exactly from RULES, or "" when no listed rule covers it and the lesson is a missing fact. Copy, never paraphrase: the quotes are checked word for word and a finding with a quote that does not match is thrown away.',
  'already_fixed: true when the session\'s turns after the user\'s message already took up the right way in full (it agreed and is doing all of it, or did it).',
  'correction: 2 to 5 sentences to the session itself, in the language the reply-language line names: what was wrong, the right way, and what to do now. When the session already took up part of the right way, name only what it still misses; "" when nothing is missing. Write it only for the session to act on; never ask it to contact anyone.',
  'guidance: one or two sentences, a general rule that would have prevented this in any session (no names from this case: no package, project or person names). "" when a GUIDANCE line already says it; then same_as is that line\'s number.',
  'skill: null, unless the right way needs several steps a session would follow again; then {"name": lowercase-with-dashes, "description": "when to use it", "text": the steps}.',
  'Answer with ONE JSON object and nothing else: {"verdict":"bad_decision"|"no_issue","why":"...","finding":{"kind","session_quote","user_quote","rule_quote","what_went_wrong","correct_action","already_fixed","correction","guidance","same_as","skill"}} (finding only with bad_decision).',
].join('\n');

export function judgePrompt(input: JudgeInput): string {
  const guidance = input.guidance.length ? input.guidance.map((g, i) => `${i + 1}. ${g}`).join('\n') : '(none yet)';
  return [
    `TASK: ${input.taskTitle}`,
    `WHY YOU ARE LOOKING: ${SIGNAL_LINE[input.signal]}`,
    `THE MOMENT: ${input.momentAt}. USER messages after it are not part of this review (they are judged on their own); SESSION turns after it show what the session did next.`,
    `REPLY LANGUAGE: ${input.replyLanguage ?? 'the language the user writes in'}`,
    '', 'RULES:', input.rulesText || '(none)',
    '', 'GUIDANCE (already written for this team):', guidance,
    '', 'THE SESSION (oldest first):', input.turnsText,
  ].join('\n');
}

/** Whitespace, quote marks and case folded, so a quote copied across a line break still matches. */
export function normalizeForQuote(s: string): string {
  return s.normalize('NFKC').replace(/[\u2018\u2019\u201c\u201d"'`*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A quote holds when every piece of it (split at an ellipsis the judge may use to skip) is in
 * `source`, in order, and the pieces hold at least 8 characters in all.
 */
export function quoteHolds(quote: string, source: string): boolean {
  const src = normalizeForQuote(source);
  const pieces = quote.split(/\.{3}|\u2026/).map(normalizeForQuote).filter(Boolean);
  // A quote cut into crumbs proves nothing: at most three pieces, each long enough to be the session's own words.
  if (pieces.length > 3 || pieces.some((p) => p.length < 6) || pieces.reduce((n, p) => n + p.length, 0) < 8) return false;
  let from = 0;
  for (const p of pieces) {
    const at = src.indexOf(p, from);
    if (at < 0) return false;
    from = at + p.length;
  }
  return true;
}

const KINDS: readonly FindingKind[] = ['hack_to_avoid_change', 'change_too_big_excuse', 'broke_user_rule', 'question_not_for_user', 'unchecked_claim', 'decided_differently', 'too_many_rounds', 'risky_retry', 'other'];
const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The judge's answer read and checked. Pure. */
export function verifyFinding(raw: string, input: Pick<JudgeInput, 'signal' | 'sessionText' | 'userText' | 'rulesText' | 'guidance'>): Verdict {
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  let parsed: { verdict?: unknown; why?: unknown; finding?: Record<string, unknown> };
  try { parsed = JSON.parse(json); } catch { return { verdict: 'unverified', why: 'the judge did not answer JSON' }; }
  if (parsed.verdict !== 'bad_decision') return { verdict: 'no_issue', why: str(parsed.why) || 'no bad decision' };
  const f = parsed.finding ?? {};
  const finding: Finding = {
    kind: KINDS.includes(f.kind as FindingKind) ? f.kind as FindingKind : 'other',
    session_quote: str(f.session_quote, 600), user_quote: str(f.user_quote, 600), rule_quote: str(f.rule_quote, 600),
    what_went_wrong: str(f.what_went_wrong, 800), correct_action: str(f.correct_action, 800),
    already_fixed: f.already_fixed === true, correction: str(f.correction, 1500), guidance: str(f.guidance, 400),
    same_as: Number.isInteger(f.same_as) && (f.same_as as number) > 0 && (f.same_as as number) <= input.guidance.length ? f.same_as as number : 0,
    skill: null,
  };
  const sk = f.skill as Record<string, unknown> | null | undefined;
  if (sk && typeof sk === 'object' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(str(sk.name, 48)) && str(sk.text, 8000)) {
    finding.skill = { name: str(sk.name, 48), description: str(sk.description, 200), text: str(sk.text, 8000) };
  }
  if (!finding.session_quote || !quoteHolds(finding.session_quote, input.sessionText)) {
    return { verdict: 'unverified', why: `session quote not in the record: "${finding.session_quote.slice(0, 120)}"` };
  }
  const userQuoteNeeded = input.signal !== 'decision_ask';
  if ((userQuoteNeeded || finding.user_quote) && !quoteHolds(finding.user_quote, input.userText)) {
    return { verdict: 'unverified', why: `user quote not in the record: "${finding.user_quote.slice(0, 120)}"` };
  }
  if (finding.rule_quote && !quoteHolds(finding.rule_quote, input.rulesText)) {
    return { verdict: 'unverified', why: `rule quote not in the rules: "${finding.rule_quote.slice(0, 120)}"` };
  }
  if (!finding.correct_action || !finding.what_went_wrong) return { verdict: 'unverified', why: 'no wrong or right way given' };
  return { verdict: 'bad_decision', finding };
}

/** The whole step: prompt, one call, the checked verdict. A call that fails is unverified, never a finding. */
export async function judge(input: JudgeInput, callModel: CallModel, nodeId?: string): Promise<Verdict> {
  // A reply with no JSON at all (2026-11-19 replay: an empty thinking block and no text) is asked once more.
  for (let attempt = 0; ; attempt++) {
    let raw: string;
    try {
      raw = await callModel(JUDGE_SYSTEM, judgePrompt(input), nodeId);
    } catch (err) {
      return { verdict: 'unverified', why: `the judge call failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (raw.includes('{') || attempt >= 1) return verifyFinding(raw, input);
  }
}

/** The default model call: the configured main model, recorded in Usage under `reflection`. */
export const callModelDefault = (): CallModel => async (system, user, taskId) => {
  const { sendMessage } = await import('../../../model/model.js');
  const result = await sendMessage({
    system, messages: [{ role: 'user', content: user }], config: { maxTokens: 3000 }, purpose: 'background',
    usage: { source: 'reflection', agentId: 'org-reflection', ...(taskId ? { taskId } : {}) },
  });
  return (result.content ?? []).map((b) => (b.type === 'text' && 'text' in b ? (b as { text: string }).text : '')).join('').trim();
};
