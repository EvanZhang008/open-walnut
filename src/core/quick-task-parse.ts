import { sendMessage } from '../agent/model.js';
import { log } from '../logging/index.js';
import { fastModelFor } from './cheap-model.js';
import type { QuickTaskParse } from './types.js';

export type { QuickTaskParse } from './types.js';

export interface QuickTaskParseEnvelope {
  parse: QuickTaskParse;
  parseMs: number;
  model?: string;
}

export interface QuickTaskParseOptions {
  now?: Date;
  timeoutMs?: number;
  timeZone?: string;
  categoryDigest?: string;
  knownCategories?: string[];
  knownProjects?: Record<string, string[]>;
  modelOverride?: string;
}

const SYSTEM_PROMPT = `You convert a user's quick task note into strict JSON. Reply with ONLY a JSON object — no markdown fence, no commentary.
Fields:
- title: cleaned task title. Remove date/time/priority/pin phrases; keep the action. Fix obvious typos. Preserve the user's language (Chinese stays Chinese). Never empty.
- due_date: only if the note contains a date or time. Date-only -> YYYY-MM-DD. With a time of day -> LOCAL ISO 8601 datetime WITHOUT timezone suffix (e.g. 2026-07-15T10:00:00) — copy the wall-clock time the user said; never convert timezones. Resolve relative dates (tomorrow, next friday, 明天, 下周三) against the current datetime given below.
- pinTier: focus|satellite|wait — only when the note asks to pin/focus it.
- priority: immediate|important|backlog — only when urgency is stated (urgent/asap -> immediate, important/重要 -> important, later/someday -> backlog).
- starred: true only when the note explicitly says star it.
- category: the ONE best-matching category NAME from the "Your categories and projects" list, judged by similarity between the note and that category's example task titles. Copy the name EXACTLY as written. Always give your best guess — the user confirms it in a UI, so a plausible guess beats omitting. For everyday personal errands (shopping, calls, appointments) prefer the category whose examples look most like personal life. Omit ONLY if the list is empty or truly nothing fits. NEVER invent a name not in the list.
- project: only if you set category — the best-matching project name listed UNDER that category, judged by its example titles. Copy EXACTLY. If none clearly matches, OMIT (the task goes to the category default). NEVER invent a name.
Omit every field that is not clearly present.`;

function localDateTime(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second} (${weekday})`;
}

function stripJsonFence(value: string): string {
  const match = value.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] ?? value).trim();
}

function canonicalMatch(value: unknown, choices: string[] | undefined): string | undefined {
  if (typeof value !== 'string' || !choices?.length) return undefined;
  const normalized = value.trim().toLowerCase();
  return choices.find((choice) => choice.trim().toLowerCase() === normalized);
}

function validLocalDueDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const dueDate = value.trim();
  const match = dueDate.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText ?? 0);
  const minute = Number(minuteText ?? 0);
  const second = Number(secondText ?? 0);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) return undefined;
  return dueDate;
}

/** Best-effort parsing for quick task notes. Never throws. */
export async function parseQuickTask(
  text: string,
  opts: QuickTaskParseOptions = {},
): Promise<QuickTaskParseEnvelope> {
  const trimmed = text.trim();
  if (!trimmed) return { parse: { title: text }, parseMs: 0 };

  let parseMs = 0;
  let model = opts.modelOverride;
  try {
    if (!model) {
      const { getConfig } = await import('./config-manager.js');
      model = fastModelFor(await getConfig());
    }
    const now = opts.now ?? new Date();
    const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const digest = opts.categoryDigest?.trim();
    const content = [
      `Current local datetime: ${localDateTime(now, timeZone)}`,
      `IANA timezone: ${timeZone}`,
      ...(digest
        ? ['', 'Your categories and projects (name, open task count, recent task titles):', digest]
        : []),
      '',
      `Note:\n${trimmed.slice(0, 500)}`,
    ].join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
    let result;
    const parseStarted = Date.now();
    try {
      result = await sendMessage({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
        config: { maxTokens: 320, ...(model ? { model } : {}) },
        signal: controller.signal,
      });
    } finally {
      parseMs = Date.now() - parseStarted;
      clearTimeout(timer);
    }

    const responseText = (result.content ?? [])
      .map((block) => (block.type === 'text' && 'text' in block ? (block as { text: string }).text : ''))
      .join('')
      .trim();
    const parsedValue: unknown = JSON.parse(stripJsonFence(responseText));
    const parsed = parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, unknown>
      : {};

    const parsedTitle = typeof parsed.title === 'string' ? parsed.title.trim() : '';
    const output: QuickTaskParse = { title: parsedTitle || trimmed.slice(0, 200) };

    const dueDate = validLocalDueDate(parsed.due_date);
    if (dueDate) output.due_date = dueDate;
    if (parsed.pinTier === 'focus' || parsed.pinTier === 'satellite' || parsed.pinTier === 'wait') {
      output.pinTier = parsed.pinTier;
    }
    if (parsed.priority === 'immediate' || parsed.priority === 'important' || parsed.priority === 'backlog') {
      output.priority = parsed.priority;
    }
    if (parsed.starred === true) output.starred = true;

    const category = canonicalMatch(parsed.category, opts.knownCategories);
    if (category) {
      output.category = category;
      const project = canonicalMatch(parsed.project, opts.knownProjects?.[category]);
      if (project) output.project = project;
    }

    return { parse: output, parseMs, ...(model ? { model } : {}) };
  } catch (err) {
    // Log only the error kind — JSON.parse messages embed a prefix of the model
    // output, which can echo the user's note into persistent logs.
    log.web.debug('parseQuickTask failed, using original text', {
      errorKind: err instanceof Error ? err.name : typeof err,
    });
    return { parse: { title: trimmed }, parseMs, ...(model ? { model } : {}) };
  }
}
