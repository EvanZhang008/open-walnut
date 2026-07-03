/**
 * Routine drafting — natural language → fully-populated routine draft.
 *
 * One LLM call (configured main model — this needs real reasoning about
 * schedules/timezones, unlike fork-title's haiku labeling). Output is strict
 * JSON, validated through normalizeCronJobCreate before it reaches the UI, so
 * a hallucinated shape can never create a broken job. Failures return an
 * error the UI degrades to a manually-filled form — drafting must never block
 * routine creation.
 */

import { sendMessage } from '../../agent/model.js';
import { normalizeCronJobCreate } from '../cron/normalize.js';
import type { CronJobCreate } from '../cron/types.js';
import { getExecutor, listExecutors } from './registry.js';
import { log } from '../../logging/index.js';

const DRAFT_TIMEOUT_MS = 30_000;

export type DraftResult =
  | { ok: true; draft: CronJobCreate }
  | { ok: false; error: string; raw?: string };

function buildSystemPrompt(context: { hosts: string[]; models: string[] }): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const executorDocs = listExecutors()
    .map((e) => `- "${e.type}" (${e.label}): ${e.description}`)
    .join('\n');

  return `You turn a natural-language automation request into a routine definition for a personal AI butler. Reply with ONLY a JSON object, no markdown fences, no commentary.

Schema:
{
  "name": string,                    // short title, e.g. "Weekday PR summary"
  "description": string,             // one line
  "schedule":
      {"kind":"cron","expr":"<5-field cron>","tz":"${tz}"}   // recurring (preferred for daily/weekly)
    | {"kind":"every","everyMs":<number>}                     // simple intervals
    | {"kind":"at","at":"<ISO datetime>"},                    // one-shot
  "executor": {
    "type": "main-agent" | "walnut-agent" | "claude-code",
    "config": {
      "instructions": string,        // detailed, well-structured instructions for the run
      // claude-code only:
      "cwd": string,                 // required for claude-code — ask-like placeholder "/path/to/repo" if the user gave none
      "host": string,                // optional; one of the configured hosts below, omit for local
      "model": string                // optional model id
    }
  }
}

Executor types:
${executorDocs}

Choosing the executor:
- Coding/repo work, "run in <dir>", "on <host>" → claude-code
- "tell me / remind me / message me" → main-agent
- Standalone research/summary that reports back → walnut-agent

Context:
- Current datetime: ${now.toISOString()} (timezone: ${tz})
- Configured remote hosts: ${context.hosts.length ? context.hosts.join(', ') : '(none — omit host)'}
- Available models: ${context.models.length ? context.models.join(', ') : '(omit model)'}

Rules:
- Interpret times in the user's timezone (${tz}) and emit cron exprs with that tz.
- "weekdays" → "* * 1-5" day-of-week; "every morning" → pick 9:00 unless told otherwise.
- Write instructions as a clear briefing (numbered steps when multi-part), like a task you'd hand a capable assistant.
- Keep name under 6 words.`;
}

/** Strip common LLM wrappers (markdown fences) and parse JSON. */
function parseDraftJson(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  // Fall back to the outermost braces if the model added prose around the JSON
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    text = text.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export async function draftRoutine(
  text: string,
  context: { hosts: string[]; models: string[] },
): Promise<DraftResult> {
  if (!text.trim()) return { ok: false, error: 'empty request' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS);

  let raw: string;
  try {
    const result = await sendMessage({
      system: buildSystemPrompt(context),
      messages: [{ role: 'user', content: text.trim() }],
      signal: controller.signal,
    });
    raw = result.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.cron.warn('routine draft LLM call failed', { error: msg });
    return { ok: false, error: `draft failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseDraftJson(raw);
  if (!parsed) {
    return { ok: false, error: 'model returned unparseable output', raw: raw.slice(0, 2000) };
  }

  // Validate executor config against the registry before normalize —
  // gives a much clearer error than a generic normalize failure.
  const executor = parsed.executor as { type?: string; config?: unknown } | undefined;
  if (executor?.type) {
    const def = getExecutor(executor.type);
    if (!def) {
      return { ok: false, error: `draft used unknown executor type '${executor.type}'`, raw: raw.slice(0, 2000) };
    }
    const validated = def.validate(executor.config ?? {});
    if (!validated.ok) {
      return { ok: false, error: `draft config invalid: ${validated.error}`, raw: raw.slice(0, 2000) };
    }
    parsed.executor = { type: executor.type, config: validated.config };
  }

  const normalized = normalizeCronJobCreate(parsed);
  if (!normalized || !normalized.schedule || !normalized.executor) {
    return { ok: false, error: 'draft did not normalize into a valid routine', raw: raw.slice(0, 2000) };
  }

  return { ok: true, draft: normalized };
}
