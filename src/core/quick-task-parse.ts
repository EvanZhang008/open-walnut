import { sendMessage } from '../agent/model.js';
import { log } from '../logging/index.js';
import { fastModelFor } from './cheap-model.js';
import { PIN_TIER_NONE_GUIDANCE, PIN_TIER_POLICY } from './types.js';
import type { CustomTierRecord, QuickTaskParse } from './types.js';

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
  /** Flat project digest (buildProjectDigest().digest) injected as context. */
  projectDigest?: string;
  /** Canonical project names the model may pick from. */
  knownProjects?: string[];
  modelOverride?: string;
  /** Registered custom tiers — accepted as pinTier values (by id, or label normalized to id). */
  customTiers?: CustomTierRecord[];
}

/** The pinTier rule, rendered from PIN_TIER_POLICY (plus the user's custom tiers)
 *  so the prompt can't drift from the tooltips the user reads in the picker. */
function buildPinTierRule(customTiers: CustomTierRecord[]): string {
  return [
    '- pinTier: which pinned tier the task belongs in. Judge it from the work itself — do NOT require the words "pin"/"focus".',
    ...PIN_TIER_POLICY.map((p) => `  · ${p.tier} — ${p.guidance}`),
    ...customTiers.map((t) => `  · ${t.id} — user-defined tier "${t.label}". Pick it when the note explicitly names this tier (e.g. "icebox" → the tier labeled Icebox).`),
    `  · OMIT the field entirely — ${PIN_TIER_NONE_GUIDANCE}`,
    '  Urgency signals (urgent/critical/asap/today/紧急/right now) point at focus; a CONCRETE due date inside the next ~7 days points at satellite even with no urgency word; "waiting on"/"blocked by"/等 points at wait; explicit someday/backlog/later wording (someday, backlog, 以后, 有空再) points at backlog. An explicit "pin to X" always wins.',
    '  Unpinned is still the DEFAULT for things not worth tracking in the pinned working set at all — backlog is for someday work the user DOES want to keep visible.',
  ].join('\n');
}

function buildSystemPrompt(customTiers: CustomTierRecord[]): string {
  return `You convert a user's quick task note into strict JSON. Reply with ONLY a JSON object — no markdown fence, no commentary.
Fields:
- title: cleaned task title. Remove date/time/priority/pin phrases; keep the action. Fix obvious typos. Preserve the user's language (Chinese stays Chinese). Never empty.
- due_date: only if the note states a DEADLINE (by/before/due/截止). Date-only -> YYYY-MM-DD. With a time of day -> LOCAL ISO 8601 datetime WITHOUT timezone suffix (e.g. 2026-07-15T10:00:00) — copy the wall-clock time the user said; never convert timezones. Resolve relative dates (tomorrow, next friday, 明天, 下周三) against the current datetime given below.
- start_date: only if the note states when to START or defer the work (start/begin/from/after/开始/之后再/等到). Same format rules as due_date. A bare date with no deadline wording ("call mom friday", "下周三处理") is a start_date, not a due_date — it says when to do it, not when it's due.
- end_date: only if the note states a time RANGE for the work ("3-5pm", "from 2 to 4", "下午3点到5点") — the range's end, same format rules. Requires start_date (the range's start). Never use it for deadlines; those are due_date.
${buildPinTierRule(customTiers)}
- priority: immediate|important|backlog — only when urgency is stated (urgent/asap -> immediate, important/重要 -> important, later/someday -> backlog).
- starred: true only when the note explicitly says star it.
- project: the ONE best-matching project NAME from the "Your projects" list, judged by similarity between the note and that project's summary and example task titles. Copy the name EXACTLY as written. A task without a project lands in Inbox, which is fine and normal — OMIT the field for one-off items (an errand, a call, a single reminder) that don't belong to an ongoing stream of work.
- project_is_new: set to true ONLY when you supply a project name that is NOT in the list. Do that sparingly — only when the note clearly starts a NEW ongoing stream of work that deserves its own project (a new repo, a new trip, a new recurring commitment). Then \`project\` is your proposed new name (short, in the note's language) and the user confirms it in the UI. For anything else, either match an existing project or omit.
Omit every field that is not clearly present.`;
}

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

/** Max chars for a model-proposed NEW project name (a name, not a sentence). */
const MAX_NEW_PROJECT_CHARS = 40;

/**
 * Sanity-check a model-proposed NEW project name. Names are registry keys and
 * (for ms-todo) remote list names, so reject path separators and anything long
 * enough to be a restated task title.
 */
function newProjectName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (!name) return undefined;
  if (Array.from(name).length > MAX_NEW_PROJECT_CHARS) return undefined;
  if (/[/\\\n\r]/.test(name)) return undefined;
  if (name.toLowerCase() === 'inbox') return undefined; // Inbox is the absence of a project
  return name;
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
    const digest = opts.projectDigest?.trim();
    const content = [
      `Current local datetime: ${localDateTime(now, timeZone)}`,
      `IANA timezone: ${timeZone}`,
      ...(digest
        ? ['', 'Your projects (name, open task count, summary, recent task titles):', digest]
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
        system: buildSystemPrompt(opts.customTiers ?? []),
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
    const startDate = validLocalDueDate(parsed.start_date);
    if (startDate) output.start_date = startDate;
    const endDate = validLocalDueDate(parsed.end_date);
    // An end without a start is meaningless — drop it rather than invent a block.
    if (endDate && startDate) output.end_date = endDate;
    if (parsed.pinTier === 'focus' || parsed.pinTier === 'satellite' || parsed.pinTier === 'backlog' || parsed.pinTier === 'wait') {
      output.pinTier = parsed.pinTier;
    } else if (typeof parsed.pinTier === 'string' && opts.customTiers?.length) {
      // Custom tier: accept the registered id, or a label match normalized to
      // the id (the model sometimes echoes the label the user typed). Unknown
      // values are dropped (same behavior as before).
      const raw = parsed.pinTier.trim().toLowerCase();
      const match = opts.customTiers.find(
        (t) => t.id.toLowerCase() === raw || t.label.trim().toLowerCase() === raw,
      );
      if (match) output.pinTier = match.id;
    }
    if (parsed.priority === 'immediate' || parsed.priority === 'important' || parsed.priority === 'backlog') {
      output.priority = parsed.priority;
    }
    if (parsed.starred === true) output.starred = true;

    // Project: an existing name always wins over the model's new-name claim (it
    // can set project_is_new on a name that IS in the list). A name outside the
    // list is only accepted through the explicit new-project escape hatch —
    // otherwise a hallucinated name would silently create a project.
    const existing = canonicalMatch(parsed.project, opts.knownProjects);
    if (existing) {
      output.project = existing;
    } else {
      const proposed = newProjectName(parsed.project);
      if (proposed && parsed.project_is_new === true) {
        output.project = proposed;
        output.project_is_new = true;
      }
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
