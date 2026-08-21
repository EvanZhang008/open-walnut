/**
 * Permission-input compaction for the durable notification feed.
 *
 * A permission notification has to carry enough of the tool input for the feed
 * to render (and, for AskUserQuestion, to answer) the request without opening the
 * session. Raw tool input is unbounded though — a Write's `content`, a plan, a
 * long Bash heredoc — and notifications.json is a small always-read file, so the
 * input is compacted per tool on the way in: keep the fields the UI renders,
 * truncate the rest, and hard-cap the serialized result.
 *
 * EVERY string emitted from here is redacted first. notifications.json is durable
 * AND rides the git-synced data repo, and tool input is arbitrary text a model
 * chose (a Bash command can embed `AWS_SECRET_ACCESS_KEY=…` or an
 * `Authorization: Bearer …` header), so a secret must never reach the store —
 * same rule publishErrorNotification applies to hand-published error bodies in
 * server.ts.
 *
 * Pure function, no I/O.
 */

import { redactSensitiveText } from '../../logging/redact.js';

/** Serialized-size ceiling for one compacted input. Beyond this we store a preview only. */
const MAX_SERIALIZED = 8192;
/** Recursion ceiling for truncateDeep — see the guard notes on the function. */
const MAX_DEPTH = 20;

function truncate(value: unknown, max: number): string {
  // Redact BEFORE cutting: a truncation that lands mid-secret would leave a
  // fragment no pattern matches any more.
  const s = redactSensitiveText(typeof value === 'string' ? value : String(value));
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  // Don't stack markers when the cut already ends in one (a value that came
  // through a previous truncate).
  return cut.endsWith('…') ? cut : `${cut}…`;
}

/**
 * Truncate every string inside a value, structure preserved (arrays/objects walked).
 *
 * Guarded against input that would blow the stack: a ~4000-deep nesting, or a
 * cycle, used to throw a RangeError BEFORE the JSON.stringify ceiling below
 * could catch anything — the throw escaped into server.ts's fire-and-forget IIFE
 * and the notification was DROPPED (a session blocking on a human with nothing
 * in the feed). Depth stops at MAX_DEPTH and a `seen` set breaks cycles.
 *
 * `seen` entries are never removed: a shared (non-cyclic) reference rendering as
 * '[…]' on its second appearance is a cosmetic loss, while removing on the way
 * out would let a diamond-shaped input expand exponentially.
 */
function truncateDeep(value: unknown, max: number, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return truncate(value, max);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH || seen.has(value)) return '[…]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(v => truncateDeep(v, max, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = truncateDeep(v, max, depth + 1, seen);
  }
  return out;
}

/** Add `key: truncate(...)` only when the source actually has a value. */
function putTruncated(
  out: Record<string, unknown>,
  input: Record<string, unknown>,
  key: string,
  max: number,
): void {
  const value = input[key];
  if (value === undefined || value === null) return;
  out[key] = truncate(value, max);
}

/**
 * An AskUserQuestion identity string: redacted (the leak rule wins everywhere)
 * but NEVER truncated — see compactQuestions.
 */
function identityString(value: unknown): unknown {
  if (typeof value !== 'string') return truncateDeep(value, 500);
  return redactSensitiveText(value);
}

/**
 * Compact AskUserQuestion's `questions`, keeping the ANSWER-MAP IDENTITY intact.
 *
 * The question text is the KEY of the answers map the UI submits, and an
 * option's `label` is the VALUE — the server shallow-merges those answers over
 * the CLI's original input, so a truncated question or label makes every inline
 * submit silently mismatch ("the user answered nothing"). Question text and
 * option labels therefore stay verbatim; size is bounded by the 8KB guard
 * instead (which degrades the record to a preview, so the UI shows "Go to
 * Session" — the correct outcome for an unanswerable-in-place request).
 */
function compactQuestions(questions: unknown): unknown {
  if (!Array.isArray(questions)) return truncateDeep(questions, 500);
  return questions.map((question) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      return truncateDeep(question, 500);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(question as Record<string, unknown>)) {
      if (k === 'question') out[k] = identityString(v);
      else if (k === 'options') out[k] = compactOptions(v);
      else out[k] = truncateDeep(v, 500);
    }
    return out;
  });
}

/** Option `label` is an answer VALUE — verbatim. `description` and the rest cut at 500. */
function compactOptions(options: unknown): unknown {
  if (!Array.isArray(options)) return truncateDeep(options, 500);
  return options.map((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
      return truncateDeep(option, 500);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(option as Record<string, unknown>)) {
      out[k] = k === 'label' ? identityString(v) : truncateDeep(v, 500);
    }
    return out;
  });
}

/**
 * Compact a permission request's tool input for durable storage.
 * Returns undefined for an absent/empty input.
 *
 * Never throws: losing DETAIL degrades a card, losing the NOTIFICATION leaves a
 * session parked on an approval nobody can see, so any unexpected throw in here
 * becomes a preview stub instead of propagating.
 */
export function compactPermissionInput(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  try {
    return compactPermissionInputUnguarded(toolName, input);
  } catch {
    return { preview: '[unserializable input]' };
  }
}

function compactPermissionInputUnguarded(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Object.keys(input).length === 0) return undefined;

  let out: Record<string, unknown>;

  switch (toolName) {
    case 'AskUserQuestion':
      // Structure is load-bearing: the feed renders an answer form from
      // question/header/options/multiSelect, so only the strings get cut — and
      // the identity strings not even that (compactQuestions).
      out = { ...input };
      if (input.questions !== undefined) out.questions = compactQuestions(input.questions);
      for (const [k, v] of Object.entries(out)) {
        if (k !== 'questions') out[k] = truncateDeep(v, 500);
      }
      break;

    case 'ExitPlanMode':
      out = {};
      putTruncated(out, input, 'plan', 4000);
      break;

    case 'Bash':
      out = {};
      putTruncated(out, input, 'command', 2000);
      putTruncated(out, input, 'description', 200);
      break;

    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      out = {};
      // Kept whole (a path is short) but still redacted — a path can carry a
      // token (…/download?token=…).
      if (input.file_path !== undefined) out.file_path = identityString(input.file_path);
      for (const key of ['content', 'new_string', 'old_string']) {
        putTruncated(out, input, key, 400);
      }
      break;

    default:
      out = truncateDeep(input, 1000) as Record<string, unknown>;
      break;
  }

  if (Object.keys(out).length === 0) return undefined;

  // Last-resort ceiling: a pathological input (thousands of keys, a huge
  // AskUserQuestion) must not be able to bloat notifications.json.
  let serialized: string;
  try {
    serialized = JSON.stringify(out) ?? '';
  } catch {
    return { preview: safePreview(input) };
  }
  if (serialized.length > MAX_SERIALIZED) return { preview: safePreview(input) };
  return out;
}

/**
 * One-line human summary of what a permission request is asking for — the feed's
 * body. "Session needs permission approval" told the user nothing; the command /
 * question / file path is the whole decision. Redacted like everything else here
 * (truncate() does it).
 */
export function summarizePermissionRequest(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): string {
  const fallback = 'Needs permission approval';
  if (!input || typeof input !== 'object') return fallback;

  switch (toolName) {
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      return command ? truncate(command, 120) : fallback;
    }
    case 'AskUserQuestion': {
      const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
      const q = first && typeof first === 'object'
        ? (first as Record<string, unknown>).question
        : undefined;
      return typeof q === 'string' && q.trim() ? truncate(q.trim(), 120) : fallback;
    }
    case 'ExitPlanMode':
      return 'Plan ready for review';
    case 'Write':
    case 'Edit':
    // NotebookEdit carries a file_path too — the compaction switch above already
    // treats the three as one case; these two must not disagree with it.
    case 'NotebookEdit': {
      const filePath = typeof input.file_path === 'string' ? input.file_path : '';
      return filePath ? truncate(filePath, 120) : fallback;
    }
    default:
      return fallback;
  }
}

function safePreview(input: Record<string, unknown>): string {
  try {
    return redactSensitiveText(JSON.stringify(input) ?? '').slice(0, 2000);
  } catch {
    return '[unserializable tool input]';
  }
}
