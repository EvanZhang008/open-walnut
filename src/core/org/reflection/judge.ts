/**
 * Step two of the reflection: one model call decides whether a candidate (signals.ts) is a real bad
 * decision of the session, and every claim it makes must be quoted from the record: the session's
 * own words, the user's, and the rule it broke. verifyFinding checks each quote word for word
 * against what the judge was shown, and a finding whose quotes do not match is dropped, so a
 * judge that invents a rule or a sentence produces nothing (2026-11-19, Walnut VP: "only catch
 * real bad decisions, with evidence: quote the session and the rule").
 */
import type { ReflectionSignal } from './signals.js';
import { screenTitle } from '../../title-answer.js';

/** Every kind a finding can be. A new kind needs its replay case (tests/core/org/reflection-categories.test.ts). */
export const FINDING_KINDS = [
  'hack_to_avoid_change', 'change_too_big_excuse', 'broke_user_rule', 'question_not_for_user', 'unchecked_claim',
  'decided_differently', 'too_many_rounds', 'risky_retry', 'regression', 'built_different', 'approved_for_user',
  'duplicate_display', 'wrong_language', 'unclear_ask', 'unreviewed_design', 'other',
] as const;
export type FindingKind = typeof FINDING_KINDS[number];

/** The kinds that are a defect of the product, not of one turn: the task it was said in owns the fix or hands it on. */
export const PRODUCT_DEFECT_KINDS: ReadonlySet<FindingKind> = new Set(['regression', 'built_different', 'duplicate_display']);

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
  /** His complaint as the pain registry files it (pains.ts): an existing pain's id or '' for a new one, its title, who meets it. */
  pain?: { same_as: string; title: string; scope: 'all_users' | 'only_him' };
}

export type Verdict =
  | { verdict: 'bad_decision'; finding: Finding }
  | { verdict: 'no_issue'; why: string }
  | { verdict: 'unverified'; why: string };

export interface JudgeInput {
  signal: ReflectionSignal;
  /** The task, as the user reads it. */
  taskTitle: string;
  /** The thread his message was filed in (a Main or lead task's Threads), when it was. */
  threadTitle?: string;
  /** Other signals the message carries besides `signal`. */
  also?: readonly ReflectionSignal[];
  /** needs_ask: the ask as Needs you showed it to him. */
  askText?: string;
  /** needs_ask: his messages of the last 48 hours in the task and its lead's threads, rendered. */
  evidenceText?: string;
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
  /** The pains already in the node's registry (pains.ts), newest first: a complaint is matched against them. */
  pains?: ReadonlyArray<{ id: string; title: string }>;
}

/** One model call; `nodeId` is the node whose reflection pays for it (Usage). */
export type CallModel = (system: string, user: string, nodeId?: string) => Promise<string>;

const SIGNAL_LINE: Record<ReflectionSignal, string> = {
  frustration: 'The user\'s message reads frustrated or angry. Find what the agents did that earned it, and the rule that prevents it.',
  overruled: 'The user\'s message turns down what the session recommended or decided. Find out whether the session judged wrongly, and what rule or fact it missed.',
  many_rounds: 'The user sent many messages in a short time, several of them follow-up questions. Find out whether one clear answer could have settled it, and what made the extra rounds.',
  needs_ask: 'The task put an ask to the user (Needs you, shown below as THE ASK). Find out whether it was his to answer at all: asking the user to decide or approve something he should never have seen is the bad decision here; a bad recommendation in it is one too. Then whether a reader who never saw the task understands it from the ask alone (unclear_ask).',
  not_for_user: 'The user\'s words say the question put to him was not his (already done or answered, his approval already given, the agent\'s own call). Find why it reached him, and the rule that keeps such asks off his list.',
  regression: 'The user\'s message says something that worked is broken, gone or changed. Find the change that broke it.',
  built_different: 'The user\'s message says what was built or decided is not what he said, or that an agent said yes for him. Find where his words were changed.',
  duplicate_display: 'The user\'s message says the same thing shows more than once. Find what shows it twice.',
  wrong_language: 'An answer to the user was not in the language his reply-language setting names.',
  unclear_ask: 'The user\'s words say he could not tell what a question or card put to him meant. Find what made it unreadable on its own, and the rule that makes every ask self-explaining.',
  unreviewed_design: 'The user\'s words say a design, picture or screenshot shown to him had visible faults or was never reviewed. Find whether anyone who did not make it looked at every picture before he saw it.',
};

export const JUDGE_SYSTEM = [
  'You review one moment of a work session an AI agent ran for its user. Decide whether the session made a REAL bad decision, and only then say what it should have done.',
  'Bad decisions to look for:',
  '- hack_to_avoid_change: a workaround or shortcut chosen to keep the change small, instead of the correct change.',
  '- change_too_big_excuse: "many things depend on it" or "the change is too big" used as the reason not to make the correct change.',
  '- broke_user_rule: it went against one of the user\'s rules listed below (quote the rule).',
  '- question_not_for_user: it put to the user a choice that was not his to make: one it should have decided itself and reported; a follow-up step of something he already said yes to (he agreed to publish a change, then was asked about its description); something he already answered elsewhere (a card, a thread, another message); his words about ONE thing used as a gate for others (he asked to see one item first, the session gates every item).',
  '- unchecked_claim: it stated a cause, number or status as fact without having checked it.',
  '- decided_differently: it chose A and the user chose B, because it missed a rule or a fact it could have had.',
  '- risky_retry: it repeated or retried an action on something real the user owns (a real send from his account, a sign-in, a payment, a device) after a try failed, instead of stopping after one try to read the evidence.',
  '- too_many_rounds: the user needed several rounds for what one clear answer could settle (no conclusion first, half an answer, an unclear question).',
  '- regression: something that worked is broken by a newer change (a reply lost, a card still waiting after he answered, a view that used to fold now gone).',
  '- built_different: what was built is not what the user said (he asked for one simple thing, it shipped something else or more).',
  '- approved_for_user: an agent said yes in the user\'s name on a choice that is his (his RULES say which; where they say nothing: an outward send or anything in his name, spending, credentials, deleting his data, a public release, or one of several designs he was to pick from before he saw them); shipping work that passed review and tests is not this when his RULES let agents ship.',
  '- duplicate_display: the same thing is shown to him more than once (one item listed several times).',
  '- unclear_ask: a question, card or letter put to him that a reader who never saw the task cannot understand from it alone: it does not say what the feature or thing is, it points with words like "here", "this place", "it" with nothing they point at, an ask about where something goes or how it looks has no screenshot or design page, or a button does not say what choosing it does ("OK", "put it here"). A card waiting on his decision is unclear too when its summary is missing or its first sentence does not say what he decides and what the agent recommends, when it names a plan or design page without its path or link, or when it offers a choice with no buttons (the recommended one first and marked).',
  '- unreviewed_design: a design page, picture or screenshot reached him without one review by someone who did not make it, looking at every picture (overlap, cut-off text, misalignment, spacing, overflow, match with the real screen), or the report does not say what the review looked at and changed. Text-only or small colour changes do not count.',
  'A message that starts `Answer to "<ask>": ` is his answer from a card: the quoted ask is the agent\'s words, the rest is his.',
  'Read his words as he wrote them: a question or a complaint ("why does everything have to be round?") is not an instruction. The lesson and the guidance rest only on what he plainly asked for or ruled; never turn his question, a word he doubts, or your guess at what he wants into a rule. When it is unclear what he wants, the right way is to ask him or to follow his written RULES, not a rule of your own.',
  'For a frustrated message, find the cause in the agents\' work and give the rule that prevents it; answer no_issue only when the anger is at something outside the agents (a vendor, a colleague, himself).',
  'Judge what the user\'s message is ABOUT: the session actions it reacts to (usually the last SESSION turn before it, sometimes the run of turns that led to it; for an ask, THE ASK and the last SESSION turn; for many rounds, the rounds listed). A problem in an older turn the message is not about is no_issue here.',
  'NOT a bad decision (answer no_issue): the user simply preferred another reasonable option the session could not have known; the user is angry at himself, another person, a tool or the world, not at the session\'s work; the user is only asking to understand or for a summary; the session already did what was asked; the listed rules pull both ways on it (one says decide, another says ask him); anything you cannot quote.',
  'Evidence: session_quote is a short passage copied EXACTLY from a SESSION turn\'s text (not from a tool line); user_quote one copied exactly from a USER turn or his recent messages ("" only for an ask he has not answered); rule_quote one copied exactly from RULES, or "" when no listed rule covers it and the lesson is a missing fact. Copy, never paraphrase: the quotes are checked word for word and a finding with a quote that does not match is thrown away.',
  'already_fixed: true when the session\'s turns after the user\'s message already took up the right way in full (it agreed and is doing all of it, or did it).',
  'correction: 2 to 5 sentences to the session itself, in the language the reply-language line names: what was wrong, the right way, and what to do now. When the session already took up part of the right way, name only what it still misses; "" when nothing is missing. Write it only for the session to act on; never ask it to contact anyone.',
  'guidance: one or two sentences, in the language the reply-language line names, a general rule that would have prevented this in any session (no names from this case: no package, project or person names). It never contradicts his RULES: where they changed, the newer wording wins, and a lesson that would go against them is "". "" also when a GUIDANCE line already says it; then same_as is that line\'s number.',
  'pain: only when the user\'s words complain about something (not for an ask he has not answered): {"same_as": the id of the PAINS line that is the same problem (one fix would end both) or "", "title": a few words naming the problem in general terms, in the language the reply-language line names, "scope": "all_users" when any user of the product would meet it (a product defect, a default, an agent habit), "only_him" when it depends on his own account, machine, setup or habits}; otherwise null.',
  'skill: null, unless the right way needs several steps a session would follow again; then {"name": lowercase-with-dashes, "description": "when to use it", "text": the steps}.',
  'Answer with ONE JSON object and nothing else: {"verdict":"bad_decision"|"no_issue","why":"...","finding":{"kind","session_quote","user_quote","rule_quote","what_went_wrong","correct_action","already_fixed","correction","guidance","same_as","skill","pain"}} (finding only with bad_decision).',
].join('\n');

export function judgePrompt(input: JudgeInput): string {
  const guidance = input.guidance.length ? input.guidance.map((g, i) => `${i + 1}. ${g}`).join('\n') : '(none yet)';
  const also = (input.also ?? []).filter((s) => s !== input.signal);
  return [
    `TASK: ${input.taskTitle}`,
    ...(input.threadTitle ? [`THREAD: ${input.threadTitle} (his message was filed in this thread of the task; SESSION turns are the task's answers in it)`] : []),
    `WHY YOU ARE LOOKING: ${SIGNAL_LINE[input.signal]}`,
    ...also.map((s) => `ALSO: ${SIGNAL_LINE[s]}`),
    `THE MOMENT: ${input.momentAt}. USER messages after it are not part of this review (they are judged on their own); SESSION turns after it show what the session did next.`,
    `REPLY LANGUAGE: ${input.replyLanguage ?? 'the language the user writes in'}`,
    '', 'RULES:', input.rulesText || '(none)',
    '', 'GUIDANCE (already written for this team):', guidance,
    ...(input.pains?.length ? ['', 'PAINS (his complaints already in the registry, id then title):', ...input.pains.map((p) => `${p.id} ${p.title}`)] : []),
    ...(input.askText ? ['', 'THE ASK (what Needs you showed him, in the task\'s own words):', input.askText] : []),
    ...(input.evidenceText !== undefined
      ? ['', 'THE USER\'S MESSAGES OF THE LAST 48 HOURS (in this task and its lead\'s threads: what he already said yes to or answered):', input.evidenceText || '(none)']
      : []),
    '', 'THE SESSION (oldest first):', input.turnsText || '(no turns)',
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

/**
 * The quote as the source holds it: each piece as written there (its own case and marks), joined
 * with " ... " where the judge skipped, and the last piece carried on to the mark that ends its
 * sentence when one comes within a few characters (a question mark, an exclamation), so a question
 * of his reads as a question in the record (2026-11-23 audit: "...round?" filed as "everything must
 * be round" became a guidance line). Whitespace is folded. The judge's own copy when a piece cannot
 * be placed. Pure.
 */
export function quoteAsWritten(quote: string, source: string): string {
  // The normalized source, with each of its characters' place in `source`.
  let norm = '';
  const at: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < source.length; i++) {
    for (const ch of source[i].normalize('NFKC').toLowerCase()) {
      if (/[\u2018\u2019\u201c\u201d"'`*_]/.test(ch)) continue;
      if (/\s/.test(ch)) { if (!lastSpace) { norm += ' '; at.push(i); } lastSpace = true; continue; }
      norm += ch; at.push(i); lastSpace = false;
    }
  }
  const pieces = quote.split(/\.{3}|\u2026/).map(normalizeForQuote).filter(Boolean);
  if (!pieces.length) return quote;
  const spans: Array<[number, number]> = [];
  let from = 0;
  for (const p of pieces) {
    const k = norm.indexOf(p, from);
    if (k < 0) return quote;
    spans.push([at[k], at[k + p.length - 1] + 1]);
    from = k + p.length;
  }
  // The sentence's end mark, when it is near: at most four more characters, none of them a break.
  const last = spans[spans.length - 1];
  const tail = /^[^\n?!.,;:\u3002\uff1f\uff01\uff0c\uff1b\uff1a]{0,4}?\s?[?!\uff1f\uff01]+/u.exec(source.slice(last[1]));
  if (tail) last[1] += tail[0].length;
  const fold = (t: string) => t.replace(/\s+/g, ' ').trim();
  const out = spans.map(([a, b]) => fold(source.slice(a, b))).join(' ... ');
  return out.length <= 600 ? out : quote;
}

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The judge's answer read and checked. Pure. */
export function verifyFinding(raw: string, input: Pick<JudgeInput, 'signal' | 'sessionText' | 'userText' | 'rulesText' | 'guidance' | 'pains'>): Verdict {
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  let parsed: { verdict?: unknown; why?: unknown; finding?: Record<string, unknown> };
  try { parsed = JSON.parse(json); } catch { return { verdict: 'unverified', why: 'the judge did not answer JSON' }; }
  if (parsed.verdict !== 'bad_decision') return { verdict: 'no_issue', why: str(parsed.why) || 'no bad decision' };
  const f = parsed.finding ?? {};
  const finding: Finding = {
    // wrong_language is the deterministic check's own (language.ts), never the judge's.
    kind: (FINDING_KINDS as readonly unknown[]).includes(f.kind) && f.kind !== 'wrong_language' ? f.kind as FindingKind : 'other',
    session_quote: str(f.session_quote, 600), user_quote: str(f.user_quote, 600), rule_quote: str(f.rule_quote, 600),
    what_went_wrong: str(f.what_went_wrong, 800), correct_action: str(f.correct_action, 800),
    already_fixed: f.already_fixed === true, correction: str(f.correction, 1500), guidance: str(f.guidance, 400),
    same_as: Number.isInteger(f.same_as) && (f.same_as as number) > 0 && (f.same_as as number) <= input.guidance.length ? f.same_as as number : 0,
    skill: null,
  };
  const pn = f.pain as Record<string, unknown> | null | undefined;
  // A pain's title is a model's title answer: it goes through the title rule (title-answer.ts), and one it refuses names no pain.
  const painTitle = pn && typeof pn === 'object' ? screenTitle(str(pn.title, 160)) : null;
  if (pn && painTitle) {
    // An id the judge was not shown is a new pain, never a guess at one.
    const same = str(pn.same_as, 40);
    finding.pain = { same_as: input.pains?.some((p) => p.id === same) ? same : '', title: painTitle, scope: pn.scope === 'only_him' ? 'only_him' : 'all_users' };
  }
  const sk = f.skill as Record<string, unknown> | null | undefined;
  if (sk && typeof sk === 'object' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(str(sk.name, 48)) && str(sk.text, 8000)) {
    finding.skill = { name: str(sk.name, 48), description: str(sk.description, 200), text: str(sk.text, 8000) };
  }
  if (!finding.session_quote || !quoteHolds(finding.session_quote, input.sessionText)) {
    return { verdict: 'unverified', why: `session quote not in the record: "${finding.session_quote.slice(0, 120)}"` };
  }
  // An ask he has not answered has no words of his to quote.
  const userQuoteNeeded = input.signal !== 'needs_ask';
  if ((userQuoteNeeded || finding.user_quote) && !quoteHolds(finding.user_quote, input.userText)) {
    return { verdict: 'unverified', why: `user quote not in the record: "${finding.user_quote.slice(0, 120)}"` };
  }
  if (finding.user_quote) finding.user_quote = quoteAsWritten(finding.user_quote, input.userText);
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
