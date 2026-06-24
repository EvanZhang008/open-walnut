/**
 * Fork title summarizer.
 *
 * When a session is forked, the child task is named `Fork of <parent>` — useless
 * when you have a dozen forks. This turns the fork's new prompt into a 2-4 word
 * English label so the final title reads `<label> - fork of <parent>`.
 *
 * Design notes:
 * - ENGLISH-ONLY by contract. Fork titles flow through updateTask →
 *   runPluginContentValidation, which rejects CJK for externally-synced sources
 *   (and this is a public repo). The prompt forces English; we also strip any
 *   stray non-ASCII as a belt-and-suspenders guard.
 * - Uses a cheap, no-thinking Haiku-tier model — this is a trivial labeling task,
 *   not worth an Opus call. Falls back to the configured main model if the
 *   provider has no Haiku entry.
 * - Best-effort: every failure path returns a heuristic label (or '') so the
 *   caller can always fall back to the plain `Fork of <parent>` title. NEVER
 *   throws — the fork must not depend on the LLM being reachable.
 */

import { sendMessage } from '../agent/model.js';
import { MODEL_CATALOG } from '../agent/providers/model-catalog.js';
import { log } from '../logging/index.js';

const MAX_WORDS = 4;
const MAX_LABEL_LEN = 40; // keep the prefix short; the full title also carries "- fork of <parent>"

const SUMMARIZE_SYSTEM =
  'You label coding tasks. Given a prompt, reply with a 2-4 word English title in ' +
  'Title Case. No quotes, no punctuation, no trailing period, English only. ' +
  'Examples: "Fix Login Redirect", "Add Retry Backoff", "Refactor Stream Parser".';

/**
 * Pick a cheap labeling model for the given provider. Prefers a Haiku-tier entry
 * (fast, no extended thinking); returns undefined to let model.ts use the
 * configured main model when the provider has no obvious cheap option.
 */
function cheapModelFor(providerName: string): string | undefined {
  const entries = MODEL_CATALOG[providerName];
  if (!entries?.length) return undefined;
  const haiku = entries.find((m) => m.id.toLowerCase().includes('haiku'));
  return haiku?.id;
}

/**
 * Normalize an LLM (or fallback) string into a clean 2-4 word English label.
 * Strips non-ASCII, collapses whitespace, drops punctuation, caps word count
 * and length. Returns '' if nothing usable survives.
 */
export function normalizeLabel(raw: string): string {
  if (!raw) return '';
  let s = raw
    .replace(/[^\x00-\x7F]+/g, ' ') // drop any non-ASCII (CJK guard)
    .replace(/["'`]/g, '') // strip quotes the model may wrap around
    .replace(/[^\w\s-]/g, ' ') // drop punctuation except hyphen
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const words = s.split(' ').filter(Boolean).slice(0, MAX_WORDS);
  s = words.join(' ');
  if (s.length > MAX_LABEL_LEN) s = s.slice(0, MAX_LABEL_LEN).trimEnd();
  return s;
}

/**
 * Heuristic fallback: first few meaningful English words of the prompt. Used when
 * the LLM is unreachable or returns garbage. May return '' (then caller keeps the
 * plain `Fork of <parent>` title).
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'please',
  'can', 'you', 'i', 'we', 'this', 'that', 'continue', 'working',
]);
function heuristicLabel(prompt: string): string {
  const asciiWords = prompt
    .replace(/[^\x00-\x7F]+/g, ' ')
    .replace(/[^\w\s-]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
  if (!asciiWords.length) return '';
  const picked = asciiWords.slice(0, MAX_WORDS).map((w) => w[0].toUpperCase() + w.slice(1));
  return normalizeLabel(picked.join(' '));
}

/**
 * Summarize a fork's new prompt into a short English label. Best-effort: returns
 * a label string, or '' if nothing usable could be produced. NEVER throws.
 */
export async function summarizeForkPrompt(prompt: string, timeoutMs = 15_000): Promise<string> {
  const trimmed = (prompt ?? '').trim();
  if (!trimmed) return '';

  try {
    const { getConfig } = await import('./config-manager.js');
    const config = await getConfig();
    const providerName = config.agent?.main_provider ?? 'bedrock';
    const model = cheapModelFor(providerName); // undefined → model.ts uses main_model

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result;
    try {
      result = await sendMessage({
        system: SUMMARIZE_SYSTEM,
        messages: [{ role: 'user', content: `Prompt:\n${trimmed.slice(0, 2000)}\n\nTitle:` }],
        // maxTokens MUST be small: the output is a 2-4 word label, and more
        // importantly the catalog default for Haiku is 64K, which makes the SDK
        // reject the NON-streaming request with "Streaming is required for
        // operations that may take longer than 10 minutes" → every call would
        // fall back to the heuristic. A tiny cap keeps it a fast non-stream call.
        config: { maxTokens: 64, ...(model ? { model } : {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = (result.content ?? [])
      .map((b) => (b.type === 'text' && 'text' in b ? (b as { text: string }).text : ''))
      .join('')
      .trim();

    const label = normalizeLabel(text);
    if (label) return label;
    log.web.debug('summarizeForkPrompt: empty label from model, falling back to heuristic');
    return heuristicLabel(trimmed);
  } catch (err) {
    log.web.warn('summarizeForkPrompt failed, using heuristic', {
      error: err instanceof Error ? err.message : String(err),
    });
    return heuristicLabel(trimmed);
  }
}

const GROUP_LABEL_SYSTEM =
  'You name a group of related coding tasks. Given several task titles, reply ' +
  'with a 2-4 word English group name in Title Case that captures their common ' +
  'theme. No quotes, no punctuation, no trailing period, English only. ' +
  'Examples: "Login Flow", "Stream Parser Forks", "Onboarding Polish".';

/**
 * Summarize a set of task titles into a short English group label. Mirrors
 * summarizeForkPrompt: cheap Haiku-tier call, best-effort, NEVER throws (returns
 * a heuristic label or '' so the caller can fall back to the lead task's title).
 */
export async function summarizeGroupLabel(titles: string[], timeoutMs = 15_000): Promise<string> {
  const cleaned = titles.map((t) => (t ?? '').trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  const joined = cleaned.slice(0, 12).map((t) => `- ${t}`).join('\n');

  try {
    const { getConfig } = await import('./config-manager.js');
    const config = await getConfig();
    const providerName = config.agent?.main_provider ?? 'bedrock';
    const model = cheapModelFor(providerName);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result;
    try {
      result = await sendMessage({
        system: GROUP_LABEL_SYSTEM,
        messages: [{ role: 'user', content: `Task titles:\n${joined.slice(0, 2000)}\n\nGroup name:` }],
        config: { maxTokens: 64, ...(model ? { model } : {}) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = (result.content ?? [])
      .map((b) => (b.type === 'text' && 'text' in b ? (b as { text: string }).text : ''))
      .join('')
      .trim();

    const label = normalizeLabel(text);
    if (label) return label;
    return heuristicLabel(cleaned.join(' '));
  } catch (err) {
    log.web.warn('summarizeGroupLabel failed, using heuristic', {
      error: err instanceof Error ? err.message : String(err),
    });
    return heuristicLabel(cleaned.join(' '));
  }
}
