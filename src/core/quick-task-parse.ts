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
    '  When a signal is AMBIGUOUS, answer with the weaker option: satellite rather than focus, and omission rather than backlog or wait. focus needs stated urgency and wait needs a stated blocker — claiming either without one is the most common mistake, and it is worse than saying nothing, because the surfaces already default to satellite for work that is being started.',
  ].join('\n');
}

function buildSystemPrompt(customTiers: CustomTierRecord[]): string {
  return `You convert a user's quick task note into strict JSON. Reply with ONLY a JSON object — no markdown fence, no commentary.
Fields:
- title: cleaned task title. Remove date/time/priority/pin phrases; keep the action. Fix obvious typos. Preserve the user's language (Chinese stays Chinese). Never empty.
- due_date: only if the note states a DEADLINE (by/before/due/截止). Date-only -> YYYY-MM-DD. With a time of day -> LOCAL ISO 8601 datetime WITHOUT timezone suffix (e.g. 2026-07-15T10:00:00) — copy the wall-clock time the user said; never convert timezones. Resolve relative dates (tomorrow, next friday, 明天, 下周三) against the current datetime given below; for weekday names (monday, 周三, …) COPY the date from the "Upcoming days" table — never compute it yourself.
- start_date: only if the note states when to START or defer the work (start/begin/from/after/开始/之后再/等到). Same format rules as due_date. A bare date with no deadline wording ("call mom friday", "下周三处理") is a start_date, not a due_date — it says when to do it, not when it's due.
- end_date: only if the note states a time RANGE for the work ("3-5pm", "from 2 to 4", "下午3点到5点") — the range's end, same format rules. Requires start_date (the range's start). Never use it for deadlines; those are due_date.
${buildPinTierRule(customTiers)}
- priority: immediate|important|backlog — only when urgency is stated (urgent/asap -> immediate, important/重要 -> important, later/someday -> backlog).
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

/**
 * "Monday=2026-08-10, Tuesday=2026-08-11, …" for the next 7 days. Small models
 * reliably COPY dates from a lookup table but routinely botch the weekday
 * arithmetic ("next monday" from a Sunday came back as Tuesday), so we resolve
 * the calendar for them instead of asking them to compute it.
 */
function upcomingWeekdays(now: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' });
  const entries: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    entries.push(`${weekdayFmt.format(d)}=${fmt.format(d)}`);
  }
  return entries.join(', ');
}

/** Weekday tokens (en names incl. common abbreviations + zh) → JS day index
 *  (0=Sunday). Abbreviations matter for COUNTING mentions: "start wed, due
 *  friday" must register as two weekdays (ambiguous → no snap). */
const WEEKDAY_TOKENS: Array<[RegExp, number]> = [
  [/\bsun(?:day)?\b|(?:周|星期|礼拜)[日天]/i, 0],
  [/\bmon(?:day)?\b|(?:周|星期|礼拜)一/i, 1],
  [/\btue(?:s(?:day)?)?\b|(?:周|星期|礼拜)二/i, 2],
  [/\bwed(?:nesday)?\b|(?:周|星期|礼拜)三/i, 3],
  [/\bthu(?:r(?:s(?:day)?)?)?\b|(?:周|星期|礼拜)四/i, 4],
  [/\bfri(?:day)?\b|(?:周|星期|礼拜)五/i, 5],
  [/\bsat(?:urday)?\b|(?:周|星期|礼拜)六/i, 6],
];

/** The single weekday the note names, or undefined (none, or ambiguous). */
function mentionedWeekday(note: string): number | undefined {
  const hits = WEEKDAY_TOKENS.filter(([re]) => re.test(note)).map(([, dow]) => dow);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Deterministic backstop for model weekday slips: when the note names exactly
 * one weekday but the model's date falls on a different weekday, shift the date
 * to the CLOSEST calendar day with the named weekday (±3 days keeps the model's
 * intended week), never landing before today. The lookup table in the prompt
 * makes this rare, but small models still occasionally copy the wrong row.
 */
function snapToMentionedWeekday(dateStr: string, targetDow: number, now: Date, timeZone: string): string {
  const [datePart, timePart] = dateStr.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const asUtc = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd));
  let date = asUtc(y, m, d);
  if (date.getUTCDay() !== targetDow) {
    let delta = (targetDow - date.getUTCDay() + 7) % 7; // 0..6 forward
    if (delta > 3) delta -= 7; // prefer the closest occurrence, allow backward
    date = new Date(date.getTime() + delta * 86_400_000);
    // Never correct into the past — "friday" in a task always means an upcoming one.
    const todayParts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    if (date.toISOString().slice(0, 10) < todayParts) date = new Date(date.getTime() + 7 * 86_400_000);
  }
  const fixed = date.toISOString().slice(0, 10);
  return timePart ? `${fixed}T${timePart}` : fixed;
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
      `Upcoming days (copy dates from here — do NOT compute them): ${upcomingWeekdays(now, timeZone)}`,
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

    // Weekday backstop: if the note names exactly one weekday, model dates on a
    // different weekday get snapped to it (closest occurrence, never past).
    const noteDow = mentionedWeekday(trimmed);
    const snap = (value: string | undefined) =>
      value !== undefined && noteDow !== undefined
        ? snapToMentionedWeekday(value, noteDow, now, timeZone)
        : value;
    const dueDate = snap(validLocalDueDate(parsed.due_date));
    if (dueDate) output.due_date = dueDate;
    const startDate = snap(validLocalDueDate(parsed.start_date));
    if (startDate) output.start_date = startDate;
    const endDate = snap(validLocalDueDate(parsed.end_date));
    // An end without a start is meaningless — drop it rather than invent a block.
    // Same for an end at or before the start: "team dinner friday 6pm" sometimes
    // comes back with end === start, a zero-length calendar block the user then
    // has to clean up by hand (the calendar's duration-preserving drag already
    // guards `durMs > 0`, so it renders, it's just noise). A range needs width.
    if (endDate && startDate && endDate > startDate) output.end_date = endDate;
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
