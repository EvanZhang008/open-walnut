/**
 * The small model that judges a task before text of it goes to an outside service: a new task
 * before its first push (sync-gate.ts), an edit before its push (push-check.ts). It reads the task's title, description and project and answers whether the
 * task is the user's private matter: their own promotion or performance, feedback about a
 * colleague, pay, health, immigration, money, family, a job search, a personal side project. A
 * private task stays local; work for the team syncs.
 *
 * It throws when it has no answer (a timeout, no model, an answer that is not the JSON asked
 * for): the gate keeps the task local then and tells the user, so a push never goes out unjudged.
 */
import { log } from '../../logging/index.js';
import { fastCallBudgetMs, fastCallText, fastModelFor } from '../cheap-model.js';

export interface PrivacyInput {
  title: string;
  description?: string;
  /** The task's note and summary, when they go out too (a push sends them). */
  note?: string;
  summary?: string;
  project?: string;
  /** The outside service's name, as the user reads it. */
  service?: string;
}

export interface PrivacyVerdict {
  private: boolean;
  /** A few words: which kind of private matter it is ("own promotion"), or why it is work. */
  reason: string;
}

export type PrivacyJudge = (input: PrivacyInput) => Promise<PrivacyVerdict>;

const SYSTEM = [
  'You decide whether a task is safe to copy into the shared work tracker of the user\'s team,',
  'where coworkers and managers can read it.',
  'PRIVATE means the task is about the user\'s own personal or confidential matters: their own promotion,',
  'performance review, level or rating; feedback, a complaint or an opinion about a specific colleague;',
  'pay, compensation, equity or bonus; health or medical matters; immigration or visa; personal money,',
  'taxes or banking; family or personal relationships; looking for another job, interviews elsewhere or',
  'resigning; a personal side project or hobby unrelated to the team\'s work.',
  'WORK means ordinary team work: code, bugs, reviews, designs, operations, meetings about the product,',
  'helping teammates with their work, writing a review FOR the team\'s product. When unsure, prefer PRIVATE.',
  'Answer with JSON only, no prose: {"private": true|false, "reason": "<three to six words>"}',
].join(' ');

let testJudge: PrivacyJudge | null = null;
/** Whether this server has had a model provider set up since it started (the server says so at
 *  boot and on every config change). Unknown counts as ready: the call then answers or throws. */
let modelReady: boolean | undefined;

export function setPrivacyModelReady(ready: boolean): void {
  // Once ready, always ready: a provider that drops out for a while (an expired sign-in) makes
  // the check fail, which keeps tasks local, never skips it.
  modelReady = modelReady === true || ready;
}

/** False only when the server knows it has no model to ask. */
export function privacyModelReady(): boolean {
  return testJudge !== null || modelReady !== false;
}

/** Tests replace the model (a server in a test never calls one). null restores it. */
export function setPrivacyJudgeForTest(judge: PrivacyJudge | null): void {
  testJudge = judge;
}

/** True when a judge was installed by a test. */
export function hasTestPrivacyJudge(): boolean {
  return testJudge !== null;
}

/** Parse the model's answer; throws on anything but the JSON asked for. */
export function parseVerdict(text: string): PrivacyVerdict {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) throw new Error('the model gave no verdict');
  const parsed = JSON.parse(json) as { private?: unknown; reason?: unknown };
  if (typeof parsed.private !== 'boolean') throw new Error('the model gave no verdict');
  const reason = typeof parsed.reason === 'string' ? parsed.reason.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return { private: parsed.private, reason: reason || (parsed.private ? 'a private matter' : 'team work') };
}

/** Judge one task. Throws when the model has no answer. */
export async function judgeTaskPrivacy(input: PrivacyInput): Promise<PrivacyVerdict> {
  if (testJudge) return testJudge(input);
  const { getConfig } = await import('../config-manager.js');
  const { sendMessage } = await import('../../model/model.js');
  const config = await getConfig();
  const model = fastModelFor(config);
  const budgetMs = fastCallBudgetMs(config, 20_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  timer.unref?.();
  const body = [
    `Project: ${input.project || '(none)'}`,
    input.service ? `Tracker: ${input.service}` : '',
    `Title: ${input.title.slice(0, 500)}`,
    input.description?.trim() ? `Description:\n${input.description.trim().slice(0, 3000)}` : '',
    input.note?.trim() ? `Note:\n${input.note.trim().slice(0, 2000)}` : '',
    input.summary?.trim() ? `Summary:\n${input.summary.trim().slice(0, 1500)}` : '',
  ].filter(Boolean).join('\n');
  try {
    const result = await sendMessage({
      system: SYSTEM,
      messages: [{ role: 'user', content: body }],
      config: { maxTokens: 120, ...(model ? { model } : {}) },
      signal: controller.signal,
      usage: { source: 'privacy-check', agentId: 'privacy-check' },
    });
    const verdict = parseVerdict(fastCallText(result, budgetMs));
    log.task.info('privacy check answered', { private: verdict.private, reason: verdict.reason });
    return verdict;
  } finally {
    clearTimeout(timer);
  }
}
