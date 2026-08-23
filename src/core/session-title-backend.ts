/**
 * Backend-owned title channel — Walnut's own fast model titles a session when
 * the session's CLI channels can't. Every other title channel (side_question,
 * the CLI's generate_session_title, the ACP self-report) rides the session's
 * control pipe, so a wedged daemon or a dead wrapper kills them all at once
 * (2026-08-23 repro: a local daemon that stopped answering hello at launch left
 * a task wearing `Session: walnut` through 49 minutes of real work). This
 * channel needs nothing from the session process — only the user's message
 * text — so it stays available in exactly those failure modes.
 *
 * Same never-throw fast-model recipe as session-organize.ts. Gated by
 * backgroundAiDisabled(): test servers and constrained deployments never make
 * unprompted model calls, and callers fall back to keeping the placeholder
 * (the durable sweep in session-title-reconciler.ts retries later).
 */

import { log } from '../logging/index.js';
import { backgroundAiDisabled, fastModelFor } from './cheap-model.js';

/** The shared "hidden main-model prompt" question. One prompt for every
 *  channel — session-delivered (side_question / ACP) and backend alike. */
export function buildTitleQuestion(message: string, placeholder: string, requirement: string | null): string {
  return [
    'Generate a title for this session (it appears in the user\'s session list).',
    'Concise, 2-6 words, sentence case. Name the SPECIFIC subject — the thing being worked on — not the activity around it.',
    'NEVER use filler verbs that restate that work is happening: "Handle", "Process", "Address", "Work on", "Look into", "Deal with". "Handle Slack thread request" says nothing; "CoreDNS OOM Slack thread" says which one.',
    'Pull the most identifying nouns from the message (component, error, feature, ticket). If the message is only a pointer ("check this thread") with no identifiable subject yet, keep whatever concrete nouns exist and stay SHORT — a vague 3-word title beats a vague 7-word one.',
    ...(requirement ? [
      `MANDATORY RULE from the task system: ${requirement}`,
      'Obey this rule even if it conflicts with the language or style of the message below (translate, don\'t mirror).',
    ] : []),
    `Current placeholder title: ${placeholder}`,
    `User's first message: ${message.slice(0, 2000)}`,
    'Reply with ONLY the title — no quotes, no commentary.',
  ].join('\n');
}

/** Answers that carry no title signal — refusals and meta-prose. A null here
 *  keeps the placeholder, and a later trigger retries; writing "I cannot
 *  determine..." as a task title would be strictly worse than the placeholder. */
const REFUSAL_RE = /^(i can(?:no|')t|i cannot|i'm sorry|i am sorry|sorry[,!]|as an ai|i(?:'| a)m unable|there (?:is|was) no)/i;

/** Models sometimes wrap the answer — take the first non-empty line, strip
 *  quote/markdown/label wrappers, collapse whitespace, cap like every other
 *  title write. Rejects (null) anything that is not usable as a title:
 *  refusal prose, a regenerated placeholder, or sub-2-char noise. */
export function cleanTitleAnswer(answer: string): string | null {
  const firstLine = answer.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const cleaned = firstLine
    .replace(/^(?:title\s*:\s*)/i, '')      // "Title: ..." label echo
    .replace(/^[#>*`_\s]+|[*`_\s]+$/g, '')   // markdown heading/bold/code wrappers
    .replace(/^["'“”]+|["'“”]+$/g, '')       // quote wrappers
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 2) return null;
  if (REFUSAL_RE.test(cleaned)) return null;
  if (/^session:\s/i.test(cleaned)) return null; // regenerated placeholder shape
  return cleaned.slice(0, 200);
}

/** Whether the backend channel may run at all (unprompted-model-call gate). */
export function backendTitleAvailable(): boolean {
  return !backgroundAiDisabled();
}

/**
 * Ask Walnut's fast model for a title. Never throws; null on any failure
 * (gate closed, no credentials, timeout, empty answer) — callers keep the
 * placeholder and a later trigger retries.
 */
/** Pause before the single in-call retry. Mutable so tests don't sleep. */
let backendRetryDelayMs = 2_000;

/** Test-only: shrink the retry pause. */
export function __setBackendRetryDelayForTesting(ms: number): void {
  backendRetryDelayMs = ms;
}

export async function titleViaBackendModel(
  message: string, placeholder: string, requirement: string | null,
): Promise<string | null> {
  if (!backendTitleAvailable()) return null;

  const askOnce = async (): Promise<string | null> => {
    const { sendMessage } = await import('../agent/model.js');
    const { getConfig } = await import('./config-manager.js');
    const model = fastModelFor(await getConfig());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let result;
    try {
      // maxTokens stays small: Haiku catalog default (64K) trips the SDK's
      // "streaming required" guard on the non-streaming path.
      result = await sendMessage({
        system: 'You title coding sessions for a task list. Reply with ONLY the title — no quotes, no markdown, no commentary.',
        messages: [{ role: 'user', content: buildTitleQuestion(message, placeholder, requirement) }],
        config: { maxTokens: 128, ...(model ? { model } : {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = (result.content ?? [])
      .map((block) => (block.type === 'text' && 'text' in block ? (block as { text: string }).text : ''))
      .join('')
      .trim();
    return cleanTitleAnswer(text);
  };

  // Two tries: throttles and transient network drops are the common failure on
  // a fast-model call, and the callers (hook/sweep) pace in minutes — one cheap
  // in-call retry saves a whole outer backoff cycle. Never throws.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await askOnce();
    } catch (err) {
      log.session.warn('session-auto-title: backend model title failed', {
        attempt: attempt + 1,
        errorKind: err instanceof Error ? err.name : typeof err,
        error: err instanceof Error ? err.message : String(err),
      });
      if (attempt === 0) await new Promise((r) => setTimeout(r, backendRetryDelayMs));
    }
  }
  return null;
}
