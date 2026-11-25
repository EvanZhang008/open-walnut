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
import type { CallModel, Finding } from './judge.js';

export const GATED_STEPS = ['user_browser', 'user_account', 'in_his_name', 'production_write', 'cloud_account_write'] as const;
export type GatedStep = typeof GATED_STEPS[number];

const STEP_WORDS: Record<GatedStep, string> = {
  user_browser: 'use the user\'s own browser',
  user_account: 'use or sign in to one of the user\'s accounts',
  in_his_name: 'send, post, comment or approve in the user\'s name',
  production_write: 'change something in a production system',
  cloud_account_write: 'change something in a cloud account or a cloud service\'s stage',
};

/** Fixed words that hold a text whatever the model says: the user's browser and the sign-in commands. */
const ALWAYS: ReadonlyArray<[RegExp, GatedStep]> = [
  [/\bwalnut\s+browser\b/i, 'user_browser'],
  [/\b(?:fill-login|fill-code|request-sign-in)\b/i, 'user_account'],
  [/\b(?:his|her|the user'?s|evan'?s)\s+(?:own\s+)?(?:chrome|browser|safari)\b/i, 'user_browser'],
  [/\b(?:his|her|the user'?s)\s+(?:own\s+)?(?:account|login|sign-?in|credentials?)\b/i, 'user_account'],
];

export interface GateResult { steps: GatedStep[]; why: string; by: 'words' | 'model' | 'failed' }

export const GATE_SYSTEM = [
  'You check one instruction an automated reviewer wants to send to an AI agent that works for a user.',
  'Say which of these steps the instruction tells the agent to take (do, not avoid or ask about):',
  '- user_browser: use the user\'s own web browser or browser session (his Chrome, a browser tool that drives it).',
  '- user_account: sign in to, or act through, any account of the user in a website or an app (Google, chat, mail, a document or ticket tool, a cloud console), his login or session.',
  '- in_his_name: send, post, comment, reply, edit, approve or sign anything in the user\'s name or from his accounts, to or before anyone (a channel, a DM, a document, a ticket comment, a code review).',
  '- production_write: turn on, change, approve, promote, roll out or delete anything in a production system (deploy pipelines, feature flags, traffic weights, promotions).',
  '- cloud_account_write: change, create or delete anything in a cloud account or any stage of a cloud service (test, beta and gamma stages included), permissions and roles included.',
  'Not a step: asking a person for it; reading, listing, checking or reporting (a read of a cloud account with the agent\'s own command-line access included; opening the user\'s browser is a step even to read); editing a card, a thread or a message to the user inside his own task tool; handing work to another agent\'s task; changing, testing, landing or deploying the agent\'s own code through its repository\'s own scripts; local commands that change nothing outside the machine.',
  'Answer only JSON: {"steps": [...the names above, none when it asks for none...], "why": "one short sentence"}',
].join('\n');

const ALL = new Set<string>(GATED_STEPS);

/** The fixed-words layer alone. Pure. */
export function gatedByWords(text: string): GateResult | null {
  const steps = [...new Set(ALWAYS.filter(([re]) => re.test(text)).map(([, s]) => s))];
  return steps.length ? { steps, why: 'it names the user\'s own browser or a sign-in step', by: 'words' } : null;
}

/** Read the model's answer: steps it names, or null when it cannot be read. Pure. */
export function readGateAnswer(raw: string): GateResult | null {
  const body = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  let a: unknown;
  try { a = JSON.parse(body); } catch { return null; }
  if (!a || typeof a !== 'object' || !Array.isArray((a as { steps?: unknown }).steps)) return null;
  const named = ((a as { steps: unknown[] }).steps).filter((s): s is GatedStep => typeof s === 'string' && ALL.has(s));
  // A name it made up is not a pass: it said something is a step, and the list does not know it.
  if (named.length !== (a as { steps: unknown[] }).steps.length) return { steps: named.length ? named : ['user_account'], why: 'the check named a step it does not know', by: 'model' };
  return { steps: named, why: String((a as { why?: unknown }).why ?? '').slice(0, 300), by: 'model' };
}

/** The whole check on some text the reflection would send or write. No steps: it may go as written. */
export async function gateText(text: string, callModel: CallModel, nodeId?: string): Promise<GateResult> {
  if (!text.trim()) return { steps: [], why: '', by: 'words' };
  const fixed = gatedByWords(text);
  if (fixed) return fixed;
  let raw: string;
  try {
    raw = await callModel(GATE_SYSTEM, `INSTRUCTION:\n${text}`, nodeId);
  } catch (err) {
    return { steps: ['user_account'], why: `the check could not run (${err instanceof Error ? err.message : String(err)}), so it is held`, by: 'failed' };
  }
  return readGateAnswer(raw) ?? { steps: ['user_account'], why: 'the check\'s answer could not be read, so it is held', by: 'failed' };
}

export type StepCheck = (text: string, nodeId: string) => Promise<GateResult>;

/** The check a pass uses: the one its deps name, or the fixed words alone (a test's deps). */
export const checkStepOf = (deps: { checkStep?: StepCheck }): StepCheck =>
  deps.checkStep ?? (async (text) => gatedByWords(text) ?? { steps: [], why: '', by: 'words' });

/** What a finding would tell the session: the parts the check reads. */
export const findingInstruction = (f: Pick<Finding, 'correction' | 'correct_action'>) => [f.correct_action, f.correction].filter(Boolean).join('\n\n');

/** The note a held finding becomes: never its instruction, only that a step is not to be taken on its word. Pure. */
export function gatedNote(nodeName: string, steps: readonly GatedStep[], sessionQuote: string): string {
  const what = steps.map((s) => STEP_WORDS[s]).join('; ');
  return [
    `${nodeName}'s reflection looked at your turn and held its correction back: the fix it saw would have you ${what}.`,
    'The reflection never tells a session to take such a step. This note is not a reason to take it: if the step is still needed, ask the person your rules name for it (the user, or whoever his rules say), with what the step is and what you recommend, and take it only on their word.',
    ...(sessionQuote ? ['', `Your turn it looked at: "${sessionQuote}"`] : []),
  ].join('\n');
}

export const stepWords = (steps: readonly GatedStep[]) => steps.map((s) => STEP_WORDS[s]).join('; ');
