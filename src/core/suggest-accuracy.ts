/**
 * Suggestion accuracy ledger — `cache/suggest-accuracy.jsonl` under WALNUT_HOME.
 *
 * WHY THIS EXISTS: the draft column's background parse fills the launch pills
 * (project, folder, pin tier, priority, dates) WHILE the user types. That is the
 * one part of a launch nobody audits — a wrong guess only shows if they happen to
 * look before pressing Start. So "the auto-suggestion feels inaccurate" was
 * unfalsifiable in both directions. This records, per commit, what the parse
 * proposed against what the launch actually carried, which turns the feeling into
 * a per-field number (`summarizeSuggestAccuracy`).
 *
 * What is recorded: field names, the suggested value, the chosen value, and the
 * length of the composer text. Deliberately NOT the composer text itself — the
 * whole briefing a user types into a draft has no business in a telemetry file
 * that outlives the draft, and the length is enough to tell "one line" from "a
 * paragraph" when reading the log.
 *
 * Storage rules (mirrors skill-usage.ts / memory-telemetry.ts):
 *  - under `cache/`, which git-sync ignores: this is machine-local evidence, and
 *    an append per launch would otherwise churn the sync repo forever.
 *  - append-only JSONL behind the shared file lock, BOUNDED (see SUGGEST_TRIM_AT):
 *    a ledger that grows without limit is a disk bug waiting to happen.
 *  - every operation is best-effort. Telemetry must never fail (or slow) a launch,
 *    so a write failure is logged at debug and swallowed.
 *  - a corrupt line is skipped, never fatal: readers must survive a half-written
 *    tail from a killed process.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { withFileLock } from '../utils/file-lock.js';
import { log } from '../logging/index.js';

/** The launch fields the background parse can propose. Mirrors DraftAiField in
 *  web/src/components/sessions/draft-column.ts — the client sends these names. */
export const SUGGEST_FIELDS = [
  'project', 'cwd', 'pinTier', 'priority', 'dueDate', 'startDate', 'endDate',
] as const;
export type SuggestField = (typeof SUGGEST_FIELDS)[number];

/**
 * What became of one suggestion.
 *  · kept    — the launch carried exactly what was proposed.
 *  · changed — the user replaced it with something else.
 *  · dropped — the user cleared it (unpinned, no priority, no date).
 */
export type SuggestVerdict = 'kept' | 'changed' | 'dropped';

/** One field's suggested-vs-chosen pair, as the client sends it. */
export interface SuggestDiffEntry {
  field: SuggestField;
  suggested: string;
  /** Absent = the launch carried nothing for this field. */
  chosen?: string;
}

export interface SuggestEntry extends SuggestDiffEntry {
  verdict: SuggestVerdict;
}

/** One commit (a Start, or a "create task for later") worth of suggestions. */
export interface SuggestRecord {
  at: string;
  /** Which create surface committed. 'draft-session' = Start, 'draft-task' = the
   *  same draft saved as a task instead. Free-form so a new surface can join
   *  without a migration. */
  surface: string;
  /** Composer length in characters. NEVER the text itself. */
  textLen?: number;
  entries: SuggestEntry[];
}

/** Per-field tally. `accuracy` = kept / total, or null with no evidence yet. */
export interface SuggestFieldStats {
  kept: number;
  changed: number;
  dropped: number;
  total: number;
  accuracy: number | null;
}

export interface SuggestAccuracySummary {
  /** Commits that carried at least one suggestion. */
  commits: number;
  /** Every field, always present — a field with no evidence reads as zeroes. */
  fields: Record<SuggestField, SuggestFieldStats>;
  overall: SuggestFieldStats;
  /** Newest first, capped by the caller's `limit`. */
  recent: SuggestRecord[];
  /** First/last record timestamps, for "over what window is this measured". */
  since?: string;
  until?: string;
}

/** How many records a trim keeps. */
export const SUGGEST_MAX_RECORDS = 2000;
/**
 * How large the file may get before a trim runs.
 *
 * The bound is AMORTIZED, and `SUGGEST_TRIM_AT` — not `SUGGEST_MAX_RECORDS` — is
 * the real ceiling: trimming on every append would turn each launch's telemetry
 * into a full read-rewrite of the ledger, so the count is allowed to drift up to
 * here and is then cut back. ~250 bytes/line, so the file stays well under 1MB
 * either way.
 */
export const SUGGEST_TRIM_AT = 2600;

export function suggestAccuracyFile(): string {
  return path.join(WALNUT_HOME, 'cache', 'suggest-accuracy.jsonl');
}

/** kept / changed / dropped for one pair. */
export function verdictFor(entry: SuggestDiffEntry): SuggestVerdict {
  if (entry.chosen === undefined || entry.chosen === '') return 'dropped';
  return entry.chosen === entry.suggested ? 'kept' : 'changed';
}

/**
 * Append one commit's suggestions. Entries with no suggestion are the caller's to
 * filter (the client only sends proposed fields); an empty list is a no-op, so a
 * launch the parse never touched writes nothing at all.
 */
export async function recordSuggestDiff(input: {
  surface: string;
  entries: readonly SuggestDiffEntry[];
  textLen?: number;
  now?: Date;
}): Promise<void> {
  const entries = input.entries
    .filter((e) => SUGGEST_FIELDS.includes(e.field) && typeof e.suggested === 'string' && e.suggested !== '')
    .map((e) => ({ ...e, verdict: verdictFor(e) }));
  if (entries.length === 0) return;

  const record: SuggestRecord = {
    at: (input.now ?? new Date()).toISOString(),
    surface: input.surface,
    ...(typeof input.textLen === 'number' ? { textLen: input.textLen } : {}),
    entries,
  };
  const file = suggestAccuracyFile();
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await withFileLock(file, async () => {
      await fsp.appendFile(file, JSON.stringify(record) + '\n', 'utf-8');
      await trimIfNeeded(file);
    });
  } catch (err) {
    log.task.debug('suggest-accuracy: append failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Keep the newest SUGGEST_MAX_RECORDS lines once the file crosses
 *  SUGGEST_TRIM_AT. Caller holds the lock. Best-effort: a failed trim just means
 *  the file stays long. */
async function trimIfNeeded(file: string): Promise<void> {
  try {
    const lines = (await fsp.readFile(file, 'utf-8')).split('\n').filter((l) => l.trim() !== '');
    if (lines.length <= SUGGEST_TRIM_AT) return;
    const kept = lines.slice(-SUGGEST_MAX_RECORDS).join('\n') + '\n';
    // Same-directory tmp + rename: an EXDEV-safe atomic replace, so a reader can
    // never see a half-written ledger.
    const tmp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, kept, 'utf-8');
    await fsp.rename(tmp, file);
  } catch (err) {
    log.task.debug('suggest-accuracy: trim failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function emptyStats(): SuggestFieldStats {
  return { kept: 0, changed: 0, dropped: 0, total: 0, accuracy: null };
}

/** Read the ledger. Missing file / corrupt lines → the records that DID parse.
 *  ASYNC on purpose: this is read from an HTTP route, and every sync read on the
 *  server's one event loop freezes every other route (house rule). */
export async function readSuggestRecords(): Promise<SuggestRecord[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(suggestAccuracyFile(), 'utf-8');
  } catch {
    return [];   // never written yet
  }
  const out: SuggestRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      const rec = parsed as SuggestRecord;
      if (typeof rec.at !== 'string' || !Array.isArray(rec.entries)) continue;
      out.push(rec);
    } catch {
      // A half-written tail from a killed process — skip the line, keep the rest.
    }
  }
  return out;
}

/**
 * Per-field accuracy over the whole retained ledger, plus the newest `limit`
 * records for a human to eyeball ("it said Walnut, I launched Fix Walnut").
 *
 * The verdict stored on disk WINS over recomputing it: the rule that classified a
 * record is the rule that was live when the user made the choice, and silently
 * re-judging old records under a new rule would make the number un-auditable.
 */
export async function summarizeSuggestAccuracy(limit = 20): Promise<SuggestAccuracySummary> {
  const records = await readSuggestRecords();
  const fields = Object.fromEntries(
    SUGGEST_FIELDS.map((f) => [f, emptyStats()]),
  ) as Record<SuggestField, SuggestFieldStats>;
  const overall = emptyStats();

  for (const rec of records) {
    for (const entry of rec.entries) {
      const stats = fields[entry.field];
      if (!stats) continue;   // a field this build doesn't know — ignore, don't crash
      const verdict = entry.verdict ?? verdictFor(entry);
      stats[verdict] += 1;
      stats.total += 1;
      overall[verdict] += 1;
      overall.total += 1;
    }
  }
  for (const stats of [...Object.values(fields), overall]) {
    stats.accuracy = stats.total > 0 ? stats.kept / stats.total : null;
  }

  const bounded = Math.max(1, Math.min(limit, 100));
  return {
    commits: records.length,
    fields,
    overall,
    recent: records.slice(-bounded).reverse(),
    ...(records.length > 0 ? { since: records[0].at, until: records[records.length - 1].at } : {}),
  };
}
