/**
 * The check every correction, held correction and new lesson passes before it leaves the reflection:
 * one that tells a session to use the user's own browser, accounts or sign-ins, to act in his name, or
 * to write in a production system or a cloud account is never sent as written. The session gets a
 * fixed note instead: the step is not taken on the reflection's word; ask the person the rules name.
 *
 * Code, not only the judge's prompt (2026-11-25 audit: a prompt rule alone let two corrections through
 * in a day; one had a session use the user's Chrome and sign-in to submit a change in a cloud test
 * stage, the other had it sign in to his Google account). Two layers: fixed words that always hold a
 * text (the tools and places that are his: walnut browser, his Chrome, a sign-in command), then one
 * short model call that reads the text in any language. A call that fails, or an answer that cannot
 * be read, holds the text: a correction too few is the lesser harm.
 */
import crypto from 'node:crypto';
import type { CallModel, Finding } from './judge.js';
import { normalizeForQuote, quoteHolds } from './judge.js';
import { readReflectionState, updateReflectionState } from './state.js';

export const GATED_STEPS = ['user_browser', 'user_account', 'in_his_name', 'production_write', 'cloud_account_write'] as const;
export type GatedStep = typeof GATED_STEPS[number];

const STEP_WORDS: Record<GatedStep, string> = {
  user_browser: 'use the user\'s own browser',
  user_account: 'use or sign in to one of the user\'s accounts',
  in_his_name: 'send, post, comment or approve in the user\'s name',
  production_write: 'change something in a production system',
  cloud_account_write: 'change something in a cloud account or a cloud service\'s stage',
};

/**
 * Words of a lesson whose point is not to ask (decide yourself, tell him after, no card for him), English and
 * Chinese: such a lesson is never rewritten to ask first.
 */
const NO_ASK_RE = new RegExp([
  String.raw`\bwithout asking\b`, String.raw`\b(?:do not|don't|never|not)\s+(?:ask|re-?ask)\b`, String.raw`\bdecide (?:it )?(?:yourself|on your own)\b`,
  String.raw`\btell (?:him|her|them|the user) (?:after|afterwards)\b`, String.raw`\binstead of asking\b`,
  // Chinese: not ask / no longer ask / decide oneself / tell him afterwards / not made into a card or question for him
  '\u4e0d(?:\u518d|\u8981|\u5fc5|\u7528)?(?:\u95ee|\u8be2\u95ee|\u8bf7\u793a)', '\u81ea(?:\u5df1|\u884c)(?:\u5c31)?(?:\u5b9a|\u51b3\u5b9a|\u505a\u4e3b)',
  '\u4e8b\u540e(?:\u4e00\u53e5\u8bdd)?(?:\u544a|\u8bf4|\u62a5)', '\u540e\u518d\u544a\u8bc9', '\u56de\u5934\u95ee', '\u4e0d(?:\u518d)?(?:\u6302|\u505a)(?:\u6210)?[^\u3002]{0,12}(?:\u5361|\u9009\u62e9\u9898|\u95ee\u9898)',
].join('|'), 'i');

/** The rewrite's answer when asking first would turn the lesson around. */
export const ASK_FIRST_CONFLICTS = 'CONFLICTS';

export const ASK_FIRST_SYSTEM = [
  'A lesson for AI agent sessions would have them take a step that is the user\'s to allow. Rewrite it so it keeps its point and the user\'s intent, but tells sessions to ask the person their rules name before that step and take it only on that person\'s explicit yes, never to take it on their own.',
  `When any part of the lesson's point is NOT to ask (the user already said yes, to the group or once for all; act on his standing words; do not ask about each one; decide it yourself and tell him after; do not make it a card or a question for him), asking first would turn it around: answer only ${ASK_FIRST_CONFLICTS}.`,
  'Name the step in general words, never "his", "her" or "the user\'s" before browser, account, login or sign-in, and no tool names (say "a step only the user may allow"). One or two sentences, in the language of the lesson, general (no names of one case). Answer only the rewritten lesson.',
].join('\n');

/**
 * A held lesson that quotes the user, rewritten to ask first and checked again: kept, never dropped for good
 * (2026-11-26 audit: six lessons with his own words were held out of the queue). Null when the rewrite fails
 * or is held too.
 */
export async function askFirstLesson(lesson: string, steps: readonly GatedStep[], callModel: CallModel, check: StepCheck, nodeId: string): Promise<string | null | typeof ASK_FIRST_CONFLICTS> {
  // Its own words say not to ask: no call (the 11-26 replay: a lesson "decide it yourself, do not make it a
  // choice card" came back as "ask first" though the prompt names the case).
  if (NO_ASK_RE.test(lesson)) return ASK_FIRST_CONFLICTS;
  let raw = '';
  try {
    raw = (await callModel(ASK_FIRST_SYSTEM, `STEP: ${stepWords(steps)}\nLESSON: ${lesson}`, nodeId)).trim();
  } catch { return null; }
  // A lesson that says "do not ask again" is never written as "ask first" (review of 57063edbcd): held, said so.
  if (/^\W*CONFLICTS\W*$/.test(raw)) return ASK_FIRST_CONFLICTS;
  const text = raw.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 400);
  if (!text || text.includes('{')) return null;
  const g = await check(text, nodeId).catch(() => null);
  return g && verdictOf(g) === 'pass' ? text : null;
}

/** Fixed words that hold a text whatever the model says: the user's browser and the sign-in commands. */
const ALWAYS: ReadonlyArray<[RegExp, GatedStep]> = [
  [/\bwalnut\s+browser\b/i, 'user_browser'],
  [/\b(?:fill-login|fill-code|request-sign-in)\b/i, 'user_account'],
  [/\b(?:his|her|the user'?s|evan'?s)\s+(?:own\s+)?(?:chrome|browser|safari)\b/i, 'user_browser'],
  [/\b(?:his|her|the user'?s)\s+(?:own\s+)?(?:account|login|sign-?in|credentials?)\b/i, 'user_account'],
];

export interface GateResult { steps: GatedStep[]; why: string; by: 'words' | 'model' | 'failed'; settled?: Array<{ step: GatedStep; rule: string }> }

/**
 * The steps the user's own standing rules may settle: a sign-in or his browser's saved login, which his
 * rules tell agents to do themselves (2026-11-26 audit: the check held a correction that said what his
 * rule says, and a card waited three hours for him). Never a send in his name, a production write or a
 * cloud-account write: those stay his, whatever a rule seems to say.
 */
const SETTLEABLE: ReadonlySet<GatedStep> = new Set(['user_browser', 'user_account']);
/** Bumped when the check's rules change: verdicts and held lessons of an older version are judged again. */
export const GATE_VERSION = 2;

export const GATE_SYSTEM = [
  'You check one instruction an automated reviewer wants to send to an AI agent that works for a user.',
  'Say which of these steps the instruction tells the agent to take (do, not avoid or ask about):',
  '- user_browser: use the user\'s own web browser or browser session (his Chrome, a browser tool that drives it).',
  '- user_account: sign in to, or act through, any account of the user in a website or an app (Google, chat, mail, a document or ticket tool, a cloud console), his login or session.',
  '- in_his_name: send, post, comment, reply, edit, approve or sign anything in the user\'s name or from his accounts, to or before anyone (a channel, a DM, a document, a ticket comment, a code review).',
  '- production_write: turn on, change, approve, promote, roll out or delete anything in a production system (deploy pipelines, feature flags, traffic weights, promotions).',
  '- cloud_account_write: change, create or delete anything in a cloud account or any stage of a cloud service (test, beta and gamma stages included), permissions and roles included.',
  'Not a step: asking a person for it, or telling the agent to ask first and take the step only on that person\'s explicit yes to it; using, testing or recording the team\'s own product (its app, its web console, its test accounts, a copy of the user\'s data), or turning one of its own settings or flags on or off; reading, listing, checking or reporting (a read of a cloud account with the agent\'s own command-line access included; opening the user\'s browser is a step even to read); editing a card, a thread or a message to the user inside his own task tool; handing work to another agent\'s task; changing, testing, landing or deploying the agent\'s own code through its repository\'s own scripts; local commands that change nothing outside the machine.',
  'Answer only JSON: {"steps": [...the names above, none when it asks for none...], "why": "one short sentence", "settled": [{"step": "user_browser or user_account", "rule": "the words of USER RULES that tell agents to take that step themselves, copied exactly"}]}',
  'settled is only for user_browser and user_account, and only when USER RULES (given below the instruction, when there are any) tell agents to take that very step themselves (a sign-in, his saved login); [] otherwise. Copy the rule exactly: it is checked word for word.',
].join('\n');

const ALL = new Set<string>(GATED_STEPS);

/** The fixed-words layer alone. Pure. */
export function gatedByWords(text: string): GateResult | null {
  const steps = [...new Set(ALWAYS.filter(([re]) => re.test(text)).map(([, s]) => s))];
  return steps.length ? { steps, why: 'it names the user\'s own browser or a sign-in step', by: 'words' } : null;
}

/** Read the model's answer: steps it names, or null when it cannot be read; a step his rules settle (quoted exactly) is not held. Pure. */
export function readGateAnswer(raw: string, userRules = ''): GateResult | null {
  const body = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  let a: unknown;
  try { a = JSON.parse(body); } catch { return null; }
  if (!a || typeof a !== 'object' || !Array.isArray((a as { steps?: unknown }).steps)) return null;
  const named = ((a as { steps: unknown[] }).steps).filter((s): s is GatedStep => typeof s === 'string' && ALL.has(s));
  // A name it made up is no verdict: the text is checked again later, never passed and never called a step it is not.
  if (named.length !== (a as { steps: unknown[] }).steps.length) return null;
  const why = String((a as { why?: unknown }).why ?? '').slice(0, 300);
  const settled = settledOf((a as { settled?: unknown }).settled, userRules);
  return { steps: named.filter((st) => !settled.some((x) => x.step === st)), why, by: 'model', ...(settled.length ? { settled } : {}) };
}

/** A rule that settles a step is one unbroken passage of his rules, this long at least. */
export const SETTLE_RULE_MIN = 30;
/** And it is about signing in or the browser (review of 57063edbcd: any sentence of USER.md settled a step). */
const SIGN_IN_RE = /\b(?:log ?ins?|logins?|sign[- ]?ins?|passwords?|2fa|mfa|credentials?|browsers?|chrome|accounts?)\b|\u767b\u5f55|\u6d4f\u89c8\u5668|\u8d26\u53f7|\u5bc6\u7801/i;

/** The settled steps of an answer whose rule is one passage of USER RULES word for word about signing in, and only of the steps a rule may settle. Pure. */
function settledOf(raw: unknown, userRules: string): Array<{ step: GatedStep; rule: string }> {
  if (!Array.isArray(raw) || !userRules.trim()) return [];
  const src = normalizeForQuote(userRules);
  return raw.flatMap((x) => {
    const step = (x as { step?: unknown })?.step;
    const rule = String((x as { rule?: unknown })?.rule ?? '').trim();
    const passage = normalizeForQuote(rule);
    const holds = !/\.{3}|\u2026/.test(rule) && passage.length >= SETTLE_RULE_MIN && src.includes(passage) && SIGN_IN_RE.test(rule);
    return typeof step === 'string' && SETTLEABLE.has(step as GatedStep) && holds ? [{ step: step as GatedStep, rule: rule.slice(0, 300) }] : [];
  });
}

/**
 * The whole check on some text the reflection would send or write. No steps: it may go as written.
 * `by: 'failed'` is no verdict (the call failed, or its answer could not be read): the caller sends and
 * writes nothing of the text now and checks it again later; it never says a step the text may not hold.
 */
export async function gateText(text: string, callModel: CallModel, nodeId?: string, userRules = ''): Promise<GateResult> {
  if (!text.trim()) return { steps: [], why: '', by: 'words' };
  const fixed = gatedByWords(text);
  // Fixed words hold a text, except a sign-in his own rules tell agents to do: only then is the model asked about it too.
  const rules = userRules.trim();
  if (fixed && (!rules || fixed.steps.some((st) => !SETTLEABLE.has(st)))) return fixed;
  let raw: string;
  try {
    raw = await callModel(GATE_SYSTEM, `INSTRUCTION:\n${text}${rules ? `\n\nUSER RULES:\n${rules}` : ''}`, nodeId);
  } catch (err) {
    return fixed ?? { steps: [], why: `the check could not run (${err instanceof Error ? err.message : String(err)})`, by: 'failed' };
  }
  const read = readGateAnswer(raw, rules);
  if (!read) return fixed ?? { steps: [], why: 'the check\'s answer could not be read', by: 'failed' };
  if (!fixed) return read;
  // The fixed words' steps stay held unless the answer settles each by his rule.
  const steps = [...new Set([...read.steps, ...fixed.steps.filter((st) => !read.settled?.some((x) => x.step === st))])];
  return { ...read, steps, why: steps.length ? `${fixed.why}; ${read.why}` : read.why };
}

/** The rule text of a lesson the check could not judge: the backfill takes it up again (guidance-merge.ts). */
export const STEP_CHECK_FAILED = 'step_check_failed';
/** The rule text of a lesson the check held: the backfill rewrites one that quotes him to ask first (guidance-merge.ts). */
export const STEP_CHECK_HELD = 'step_check_held';

/** A verdict: the text may go (`pass`), holds a step (`held`), or was not judged now (`failed`). */
export const verdictOf = (g: GateResult): 'pass' | 'held' | 'failed' => (g.by === 'failed' ? 'failed' : g.steps.length ? 'held' : 'pass');

const keyOf = (text: string) => crypto.createHash('sha256').update(`v${GATE_VERSION}:${normalizeForQuote(text)}`).digest('hex').slice(0, 16);
/** Verdicts kept per node (state.ts stepChecked), newest last. */
export const STEP_CHECKS_KEPT = 600;

/**
 * The check with its verdict kept on the node's state: the same text is never asked twice (2026-11-25
 * review: the backfill asked about the same waiting lesson every pass). A failed check is not kept.
 */
export async function checkCached(nodeId: string, text: string, check: StepCheck, nowMs: number): Promise<GateResult> {
  const key = keyOf(text);
  const kept = (await readReflectionState(nodeId, nowMs)).stepChecked?.[key];
  if (kept) return { steps: kept.steps as GatedStep[], why: kept.why, by: 'model' };
  const g = await check(text, nodeId);
  if (g.by !== 'failed') {
    await updateReflectionState(nodeId, (s) => {
      const all = { ...(s.stepChecked ?? {}), [key]: { steps: [...g.steps], why: g.why.slice(0, 200) } };
      const keys = Object.keys(all);
      s.stepChecked = keys.length > STEP_CHECKS_KEPT ? Object.fromEntries(keys.slice(-STEP_CHECKS_KEPT).map((k) => [k, all[k]!])) : all;
    }, nowMs);
  }
  return g;
}

export type StepCheck = (text: string, nodeId: string) => Promise<GateResult>;

/**
 * Once per node after the check's rules change (GATE_VERSION): its verdicts and held lessons are dropped,
 * so each is judged again by the new rules (2026-11-26 audit: six lessons quoting the user were held for good
 * by rules that since let a step his own rules settle through). Answers whether it reset.
 */
export async function resetForGateVersion(nodeId: string, nowMs: number): Promise<boolean> {
  if ((await readReflectionState(nodeId, nowMs)).gateVersion === GATE_VERSION) return false;
  return updateReflectionState(nodeId, (s) => {
    if (s.gateVersion === GATE_VERSION) return false;
    s.gateVersion = GATE_VERSION;
    s.stepChecked = {};
    s.stepHeld = [];
    delete s.linesChecked;
    return true;
  }, nowMs);
}

/**
 * The check a pass uses: the model layer its deps name (none in a test's deps), and the fixed words always:
 * a step they find stays held unless the answer settles it by his own rule (gateText).
 */
export const checkStepOf = (deps: { checkStep?: StepCheck }): StepCheck =>
  async (text, nodeId) => {
    const fixed = gatedByWords(text);
    if (!deps.checkStep) return fixed ?? { steps: [], why: '', by: 'words' };
    const g = await deps.checkStep(text, nodeId);
    const left = (fixed?.steps ?? []).filter((st) => !g.settled?.some((x) => x.step === st));
    if (!left.length) return g;
    return { ...g, steps: [...new Set([...g.steps, ...left])], why: g.why ? `${fixed!.why}; ${g.why}` : fixed!.why, by: g.by === 'failed' ? 'words' : g.by };
  };

/** What a finding would tell the session: every part of it that is sent (what went wrong carries steps too). */
export const findingInstruction = (f: Pick<Finding, 'correction' | 'correct_action' | 'what_went_wrong'>) => [f.what_went_wrong, f.correct_action, f.correction].filter(Boolean).join('\n\n');

/**
 * The note a held finding becomes: never its instruction nor its diagnosis, only that a step is not to be
 * taken on its word (2026-11-26 audit: "what it saw" rode the note, and a session took a decision of the
 * user's on it). Pure.
 */
export function gatedNote(nodeName: string, steps: readonly GatedStep[], sessionQuote: string): string {
  const what = steps.map((s) => STEP_WORDS[s]).join('; ');
  return [
    `${nodeName}'s reflection looked at your turn and held its correction back: the fix it saw would have you ${what}.`,
    '',
    'The reflection never tells a session to take such a step, and this note is not a reason to take it. Where your rules or the user already settled that step for this kind of work, follow them; otherwise ask the person your rules name for it (the user, or whoever his rules say), with what the step is and what you recommend, and take it only on their word.',
    ...(sessionQuote ? ['', `Your turn it looked at: "${sessionQuote}"`] : []),
  ].join('\n');
}

export const stepWords = (steps: readonly GatedStep[]) => steps.map((s) => STEP_WORDS[s]).join('; ');
