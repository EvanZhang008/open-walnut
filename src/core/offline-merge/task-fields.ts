/**
 * Per-field merge of one queued task write (docs/plan/walnut-replica-servers-impl.md
 * section 7). Pure and deterministic: the drain resolves every field of a record first,
 * then applies ONE patch (fields one at a time pass invalid states validation refuses).
 *
 *   Mac value == value         nothing (idempotent); a later write only moves field_at to its time
 *   Mac value == base          take the replica's value
 *   base 'unknown'             the replica's value only when field_at(Mac) < shifted at;
 *                              listed only when the Mac's value is kept
 *   text (description, note, summary): merge3(base, mac, value); clean applies; a
 *                              conflict takes the newer side, the other goes to the log
 *   else, scalar               newer by time wins (shifted at vs field_at(Mac))
 *
 * `(project, group_id)` is ONE compound field; a resolved pair the Mac would refuse
 * (a folder of another project) keeps the Mac's pair and is listed.
 */

import { fieldTimeOf, sameFieldValue } from '../task-field-times.js';
import { mergeText, mergeTextOffLoop, type TextMergeResult } from './text-merge.js';
import { QUEUEABLE_TASK_FIELDS } from '../../providers/offline-host-core.js';

export const TEXT_TASK_FIELDS = new Set(['description', 'note', 'summary']);
export const UNKNOWN_BASE = 'unknown';
const PAIR = 'project+group_id';

/**
 * One field of a queued write. `at` (host clock, ms) is the field's own write time when a
 * coalesced record folded several writes: each field is judged by when IT was written,
 * never by the record's latest write (offline-journal-core.ts coalesceInto).
 */
export interface FieldWrite { base: unknown; value: unknown; at?: number }

/** The Mac's task as the merge reads it. */
export interface MacTask {
  [field: string]: unknown;
  field_at?: Record<string, string>;
  updated_at?: string;
  created_at?: string;
}

export type ConflictWhy = 'both-changed' | 'text-conflict' | 'base-unknown' | 'invalid-pair';

/** A field both sides changed to different values: what each side had and what was kept. */
export interface FieldConflict {
  field: string;
  base: unknown;
  mac: unknown;
  replica: unknown;
  kept: 'mac' | 'replica';
  why: ConflictWhy;
  macAt: number;
  replicaAt: number;
  overBudget?: boolean;
}

/** Text merges made before the lock (premergeTexts), by field, with the texts they merged. */
export type TextMerges = Record<string, { base: string; mac: string; replica: string; result: TextMergeResult }>;

export interface Resolution {
  /** Text fields whose merge was not made beforehand (the Mac's text moved since): resolve again. */
  staleText?: string[];
  /** The one patch to apply (empty: nothing to do). */
  patch: Record<string, unknown>;
  /** field_at for every field the patch changes: the write's shifted time (a clean text merge: the later of it and the Mac's). */
  fieldTimes: Record<string, number>;
  conflicts: FieldConflict[];
}

export interface ResolveInput {
  mac: MacTask;
  fields: Record<string, FieldWrite>;
  /** The record's time on this server's clock. */
  at: number;
  /** Host clock offset (ms to add to a host time): shifts a field's own `at`. */
  offset?: number;
  /** Would the Mac accept this pair (folder exists and belongs to the project)? */
  pairValid?: (project: string, groupId: string) => boolean;
  /**
   * The text merges made off the loop before the lock. Given, a merge never runs here: a
   * text field it lacks (the Mac's text moved since) is named in `staleText` and left
   * out of the patch. Absent, a merge runs inline (tests, short texts).
   */
  textMerges?: TextMerges;
}

/** Fields a host may queue (the task-outbox whitelist plus phase, parent_task_id, pinned, focus_tier). */
const QUEUEABLE = new Set<string>(QUEUEABLE_TASK_FIELDS);

/** The fields of a write that cannot be queued; a write naming any of them is refused whole. */
export function unqueueableFields(fields: Record<string, unknown>): string[] {
  return Object.keys(fields).filter((f) => !QUEUEABLE.has(f));
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const isUnknown = (v: unknown): boolean => v === UNKNOWN_BASE;

/** One field (or the compound pair) by the section 7 table. */
function resolveOne(
  field: string, mac: unknown, w: FieldWrite, macAt: number, at: number, out: Resolution, texts?: TextMerges,
): { take?: unknown; at?: number; bump?: true } | null {
  // Already the value: nothing to write. A write made later than the Mac's still moves the
  // field's time to it, or a third write between the two would win in one drain order only.
  if (sameFieldValue(mac, w.value)) return at > macAt ? { bump: true, at } : null;
  const conflict = (kept: 'mac' | 'replica', why: ConflictWhy, extra: Partial<FieldConflict> = {}): void => {
    out.conflicts.push({ field, base: w.base, mac, replica: w.value, kept, why, macAt, replicaAt: at, ...extra });
  };
  if (isUnknown(w.base)) {
    // Never a merge3 without a base: the newer write wins. Only a Mac value kept over the
    // away write is listed: an away write that wins over an older Mac value is the
    // ordinary case (a copy that lacked the field), and listing it lettered every park.
    if (macAt < at) return { take: w.value };
    conflict('mac', 'base-unknown');
    return null;
  }
  // The Mac's value is the one the writer saw: it did not change it, so the write is the
  // only change, stamped at its own time (never the Mac's, or drain order would matter).
  if (sameFieldValue(mac, w.base)) return { take: w.value, at };
  if (TEXT_TASK_FIELDS.has(field)) {
    const made = texts?.[field];
    const fresh = made && made.base === str(w.base) && made.mac === str(mac) && made.replica === str(w.value);
    if (texts && !fresh) { (out.staleText ??= []).push(field); return null; }
    const merged = fresh ? made.result : mergeText(str(w.base), str(mac), str(w.value));
    if (merged.clean) return sameFieldValue(merged.text, mac) ? null : { take: merged.text };
    // Over budget (the diff gave up, or the worker hit its deadline) is one conflict over the
    // whole text: the newer side, by the times alone (section 6), whatever the machine's speed.
    if (macAt < at) { conflict('replica', 'text-conflict', { overBudget: merged.overBudget }); return { take: w.value }; }
    conflict('mac', 'text-conflict', { overBudget: merged.overBudget });
    return null;
  }
  // Ties go to the Mac: deterministic, and the Mac's value is the one already shown.
  if (macAt < at) { conflict('replica', 'both-changed'); return { take: w.value }; }
  conflict('mac', 'both-changed');
  return null;
}

/** The compound (project, group_id) write, with an absent half standing for "unchanged". */
function pairWrite(mac: MacTask, fields: Record<string, FieldWrite>, pairValid?: ResolveInput['pairValid']): FieldWrite {
  const p = fields.project;
  const g = fields.group_id;
  const macP = str(mac.project);
  const macG = str(mac.group_id);
  const baseP = p ? p.base : macP;
  const baseG = g ? g.base : macG;
  const valueP = p ? str(p.value) : macP;
  // A move to another project keeps the folder only when it belongs there.
  const valueG = g ? str(g.value) : (pairValid && valueP !== macP && !pairValid(valueP, macG) ? '' : macG);
  const base = isUnknown(baseP) || isUnknown(baseG) ? UNKNOWN_BASE : { project: str(baseP), group_id: str(baseG) };
  return { base, value: { project: valueP, group_id: valueG } };
}

/**
 * The text merges a record needs against `mac`, made off the event loop (text-merge.ts
 * mergeTextOffLoop): only a field whose base is known and that both sides changed.
 */
export async function premergeTexts(mac: MacTask, fields: Record<string, FieldWrite>): Promise<TextMerges> {
  const out: TextMerges = {};
  for (const field of Object.keys(fields)) {
    const w = fields[field];
    if (!TEXT_TASK_FIELDS.has(field) || !w || isUnknown(w.base)) continue;
    const base = str(w.base);
    const m = str(mac[field]);
    const replica = str(w.value);
    out[field] = { base, mac: m, replica, result: await mergeTextOffLoop(base, m, replica) };
  }
  return out;
}

/** Resolve every field of one record into one patch plus the conflicts it lists. */
export function resolveTaskFields(input: ResolveInput): Resolution {
  const out: Resolution = { patch: {}, fieldTimes: {}, conflicts: [] };
  const { mac, fields } = input;
  // A field's own time (a folded record), else the record's.
  const timeOf = (w: FieldWrite | undefined): number => (
    w && typeof w.at === 'number' && Number.isFinite(w.at) ? w.at + (input.offset ?? 0) : input.at
  );
  for (const field of Object.keys(fields).sort()) {
    if (field === 'project' || field === 'group_id') continue;
    const at = timeOf(fields[field]);
    const stamp = (f: string, macAt: number): void => { out.fieldTimes[f] = Math.max(at, macAt); };
    const macAt = fieldTimeOf(mac as never, field);
    const r = resolveOne(field, mac[field], fields[field], macAt, at, out, input.textMerges);
    if (r?.bump) out.fieldTimes[field] = r.at!;
    else if (r) { out.patch[field] = r.take; if (r.at !== undefined) out.fieldTimes[field] = r.at; else stamp(field, macAt); }
  }
  if (fields.project || fields.group_id) {
    const at = Math.max(fields.project ? timeOf(fields.project) : -Infinity, fields.group_id ? timeOf(fields.group_id) : -Infinity);
    const macPair = { project: str(mac.project), group_id: str(mac.group_id) };
    const macAt = Math.max(fieldTimeOf(mac as never, 'project'), fieldTimeOf(mac as never, 'group_id'));
    const r = resolveOne(PAIR, macPair, pairWrite(mac, fields, input.pairValid), macAt, at, out);
    if (r?.bump) {
      out.fieldTimes.project = r.at!;
      out.fieldTimes.group_id = r.at!;
    } else if (r) {
      const pair = r.take as { project: string; group_id: string };
      if (input.pairValid && !input.pairValid(pair.project, pair.group_id)) {
        // The Mac would refuse it: keep its pair, list the other.
        const prior = out.conflicts.findIndex((c) => c.field === PAIR);
        if (prior !== -1) out.conflicts.splice(prior, 1);
        out.conflicts.push({ field: PAIR, base: pairWrite(mac, fields).base, mac: macPair, replica: pair, kept: 'mac', why: 'invalid-pair', macAt, replicaAt: at });
      } else {
        const pairAt = r.at ?? Math.max(at, macAt);
        if (pair.project !== macPair.project) out.patch.project = pair.project;
        if (pair.group_id !== macPair.group_id) out.patch.group_id = pair.group_id;
        out.fieldTimes.project = pairAt;
        out.fieldTimes.group_id = pairAt;
      }
    }
  }
  return out;
}
