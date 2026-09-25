/**
 * The rule helpers behind applyDraftParse (task fields: tier, priority, start/end,
 * due; the 'clear' revert of project/cwd), the ownership types, and the ledger's
 * suggestDiff. Kept apart so draft-column.ts stays readable; draft-column.ts
 * re-exports everything public, so import from there. Pure: imports only types
 * and the meta constants, so there is no runtime cycle with draft-column.ts.
 *
 * The rules (spec: every decision Walnut made is visible):
 *  · A proposed value is written and badged (✦) unless a user or a seed owns the
 *    field. A value equal to the current one is badged too, so "Walnut decided
 *    Focus" is visible.
 *  · A field the AI owns and a newer parse no longer proposes goes back to its
 *    default, but only when the leg that owns the field answered 'ok' AND the
 *    parse is trailing (or a 'clear'). A failed leg answers 200 with fewer
 *    fields; that is not "Walnut changed its mind".
 *  · Bound, fork, fix-walnut and walnut drafts get no task-field writes at all.
 */

import type { QuickStartTaskMeta } from './SessionPathSelector';
import { DEFAULT_META, TIER_OPTIONS } from './task-meta-constants';
import type { QuickTaskParse } from '@/api/tasks';
import type { DraftAiField, DraftColumn } from './draft-column';

// ── Shared types (re-exported by draft-column.ts, import them from there) ──

/** A task field the draft shows as a decision chip and the parse may decide.
 *  `endDate` is not one: it only rides along with an AI start (see applyDraftParse). */
export type DraftTaskField = 'pinTier' | 'priority' | 'startDate' | 'dueDate';

/** Who owns a task field: 'user' = an edit through More or the picker footer,
 *  'seed' = a tier "+" header click. An owned field is never written by the AI. */
export type DraftFieldOwner = 'user' | 'seed';

/** Fields with an owner slot. `unread` is never proposed by the parse, but More
 *  and the footer can own it, and the footer rebase compares it like the rest. */
export type DraftOwnedField = DraftTaskField | 'unread';

/** How a parse reached the draft. 'eager' = mid-typing (may add or change a chip,
 *  never remove one); 'trailing' = the settled text (may also revert); 'clear' =
 *  the composer was emptied (reverts every AI field, legs ignored). */
export type DraftParseKind = 'eager' | 'trailing' | 'clear';

/** A More / footer edit of task fields. A key PRESENT means edited; an undefined
 *  value means cleared (date) or unpinned (tier). */
export type DraftTaskFieldPatch = Partial<Pick<QuickStartTaskMeta, 'pinTier' | 'priority' | 'startDate' | 'dueDate' | 'unread'>>;

/** What applyDraftParse accepts: a quick-parse response with the title optional
 *  (the draft never uses it) and every field optional (`{}` = nothing proposed). */
export type DraftParseInput = Partial<Omit<QuickTaskParse, 'title'>> & { title?: string };

export interface ApplyDraftParseOpts {
  /** Can the draft show this tier? true = yes, false = no such tier (dropped),
   *  'unknown' = custom tiers not loaded yet (undecided: not written, recorded or
   *  reverted). Default: the four built-ins only. */
  tierKnown?: (id: string) => boolean | 'unknown';
  /** `ui.show_priority`. false = hidden, so the AI does not decide it; 'unknown' =
   *  config not read yet (undecided). Default true. */
  priorityVisible?: boolean | 'unknown';
  /** Default 'trailing' (keeps unit tests short; MainPage passes the real kind). */
  kind?: DraftParseKind;
}

/** The 'clear' half for project/cwd: the text that justified them is gone. An AI
 *  project goes back to Inbox; an AI folder goes back to the one the draft opened
 *  with, written directly (no launch memory, so model/engine stay put). */
export function clearAiPlacement(next: DraftColumn, ai: Set<DraftAiField>): boolean {
  let changed = false;
  if (ai.has('project') && next.projectSource === 'ai') {
    delete next.project;
    delete next.projectSource;
    ai.delete('project');
    changed = true;
  }
  if (ai.has('cwd') && !next.cwdPinned) {
    next.cwd = next.openedCwd ?? '';
    next.host = next.openedHost ?? null;
    next.hostLabel = undefined;
    ai.delete('cwd');
    changed = true;
  }
  return changed;
}

export const DRAFT_TASK_FIELDS: readonly DraftTaskField[] = ['pinTier', 'priority', 'startDate', 'dueDate'];

const BUILTIN_TIERS: ReadonlySet<string> = new Set(TIER_OPTIONS.map((t) => t.value));

/** Default `tierKnown`: the four built-in tiers only. */
export function builtinTierKnown(id: string): boolean {
  return BUILTIN_TIERS.has(id);
}

/** Drafts whose task fields the AI never decides: a bound draft's task already
 *  exists (its own kebab is the truth), a fork resumes another task, a repair's
 *  task is made by the server, and walnut mode runs no parse. */
export function skipsTaskFields(
  draft: Pick<DraftColumn, 'taskId' | 'forkOf' | 'intent' | 'walnut'>,
): boolean {
  return !!(draft.taskId || draft.forkOf || draft.intent === 'fix-walnut' || draft.walnut);
}

/** The parse leg that answers for a field: tier and priority come from the
 *  classifier, or from the LLM leg when the classifier is not configured. */
function legFor(field: DraftTaskField, parse: DraftParseInput) {
  const legs = parse.legs;
  if (!legs) return undefined;
  if (field === 'startDate' || field === 'dueDate') return legs.dates;
  return legs.classify === 'skipped' ? legs.dates : legs.classify;
}

/** May "not proposed" revert this field? 'clear' always; 'eager' never; a
 *  trailing parse only when the owning leg said 'ok' (no legs = never). */
export function revertAllowed(field: DraftTaskField, parse: DraftParseInput, kind: DraftParseKind): boolean {
  if (kind === 'clear') return true;
  if (kind !== 'trailing') return false;
  return legFor(field, parse) === 'ok';
}

/** Return a task field to its default in place: tier Focus, priority none, a
 *  date removed (removing the start removes the end with it). */
export function resetTaskField(meta: QuickStartTaskMeta, field: DraftTaskField): void {
  if (field === 'pinTier') meta.pinTier = DEFAULT_META.pinTier;
  else if (field === 'priority') meta.priority = 'none';
  else if (field === 'dueDate') delete meta.dueDate;
  else { delete meta.startDate; delete meta.endDate; }
}

/** A task field's current value as a string (the ledger's and the compare's shape). */
export function taskFieldValue(meta: QuickStartTaskMeta, field: DraftTaskField): string | undefined {
  return meta[field] ?? undefined;
}

/** Write a proposed value into a meta copy. */
function setTaskField(meta: QuickStartTaskMeta, field: DraftTaskField, value: string): void {
  if (field === 'pinTier') meta.pinTier = value;
  else if (field === 'priority') meta.priority = value as QuickStartTaskMeta['priority'];
  else meta[field] = value;
}

/**
 * What the parse says about one field once visibility is applied: a string =
 * a proposal the draft can show; undefined = no proposal (a revert candidate);
 * null = UNDECIDED (tier list or priority setting not known yet), so the field is
 * neither written, recorded nor reverted.
 */
function opinionFor(
  field: DraftTaskField, parse: DraftParseInput, opts: ApplyDraftParseOpts,
): string | undefined | null {
  if (field === 'pinTier') {
    const v = parse.pinTier?.trim();
    if (!v) return undefined;
    const known = (opts.tierKnown ?? builtinTierKnown)(v);
    if (known === 'unknown') return null;
    return known === true ? v : undefined;
  }
  if (field === 'priority') {
    const visible = opts.priorityVisible ?? true;
    if (visible === 'unknown') return null;
    // Widened on purpose: the parse type excludes 'none', a wire value may not.
    const v: string | undefined = parse.priority;
    return visible === true && v && v !== 'none' ? v : undefined;
  }
  const v = field === 'dueDate' ? parse.due_date : parse.start_date;
  return v || undefined;
}

/** opinionFor, except a 'clear' proposes nothing. A priority whose visibility is
 *  still unknown stays undecided even then: nothing can have been written to it. */
function opinion(
  field: DraftTaskField, parse: DraftParseInput, opts: ApplyDraftParseOpts, kind: DraftParseKind,
): string | undefined | null {
  if (kind !== 'clear') return opinionFor(field, parse, opts);
  return field === 'priority' && opts.priorityVisible === 'unknown' ? null : undefined;
}

/**
 * The task-field entries of `aiSuggested` after this parse. Filled BEFORE the
 * ownership gates, so an owned field still records what Walnut proposed. An
 * undecided field, and a missing field whose leg did not answer (or an eager
 * parse), keep the previous suggestion: the latest opinion is still that one. A
 * hidden priority records nothing (nobody could have judged it).
 */
export function taskFieldSuggestions(
  draft: DraftColumn, parse: DraftParseInput, opts: ApplyDraftParseOpts, kind: DraftParseKind,
): Partial<Record<DraftTaskField, string>> {
  const prev = draft.aiSuggested;
  const out: Partial<Record<DraftTaskField, string>> = {};
  for (const f of DRAFT_TASK_FIELDS) {
    const keep = () => { if (prev?.[f] !== undefined) out[f] = prev[f]; };
    if (skipsTaskFields(draft)) { keep(); continue; }
    const op = opinion(f, parse, opts, kind);
    if (op === null) keep();
    else if (op !== undefined) out[f] = op;
    else if (f === 'priority' && (opts.priorityVisible ?? true) === false) continue;
    else if (!revertAllowed(f, parse, kind)) keep();
  }
  return out;
}

/**
 * Fold the parse's task fields into `baseMeta` (a copy is made on change) and
 * `ai` (mutated). Returns `changed: false` with `baseMeta` itself on a no-op.
 * Never touches an owner, `metaTouched`, `userTouched` or `cwdPinned`.
 */
export function foldTaskFields(
  draft: DraftColumn,
  baseMeta: QuickStartTaskMeta,
  ai: Set<DraftAiField>,
  parse: DraftParseInput,
  opts: ApplyDraftParseOpts,
  kind: DraftParseKind,
): { meta: QuickStartTaskMeta; changed: boolean } {
  if (skipsTaskFields(draft)) return { meta: baseMeta, changed: false };
  const meta = { ...baseMeta };
  let changed = false;
  for (const f of DRAFT_TASK_FIELDS) {
    const op = opinion(f, parse, opts, kind);
    if (op === null || draft.fieldOwner?.[f]) continue;
    if (op !== undefined) {
      if (taskFieldValue(meta, f) !== op) { setTaskField(meta, f, op); changed = true; }
      if (!ai.has(f)) { ai.add(f); changed = true; }
    } else if (ai.has(f) && revertAllowed(f, parse, kind)) {
      resetTaskField(meta, f);
      ai.delete(f);
      changed = true;
    }
  }
  // The end only lands with an AI start, and goes when the dates leg says the
  // start no longer has one. An owned start (footer End takeover) owns the end.
  if (!draft.fieldOwner?.startDate && ai.has('startDate')) {
    const end = kind === 'clear' ? undefined : parse.end_date || undefined;
    if (end) {
      if (meta.endDate !== end) { meta.endDate = end; changed = true; }
    } else if (meta.endDate !== undefined && revertAllowed('startDate', parse, kind)) {
      delete meta.endDate;
      changed = true;
    }
  }
  return { meta: changed ? meta : baseMeta, changed };
}

/** The parse as the draft stores it (DraftColumn.lastParse): no title, no
 *  undefined-valued keys, and undefined when nothing is left, so an empty parse
 *  on a fresh draft is still a no-op. */
export function normalizeParse(parse: DraftParseInput | undefined): DraftParseInput | undefined {
  if (!parse) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parse)) {
    if (k !== 'title' && v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? (out as DraftParseInput) : undefined;
}

/** Value compare of two parses as stored (normalizeParse), `legs` included. */
export function sameParse(a: DraftParseInput | undefined, b: DraftParseInput | undefined): boolean {
  const x = normalizeParse(a);
  const y = normalizeParse(b);
  if (!x || !y) return x === y;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) {
    if (k === 'legs') {
      if (x.legs?.classify !== y.legs?.classify || x.legs?.dates !== y.legs?.dates) return false;
    } else if (x[k as keyof DraftParseInput] !== y[k as keyof DraftParseInput]) return false;
  }
  return true;
}

/** Shallow value compare of two proposal maps (both may be undefined). */
export function proposalsDiffer(
  a: Readonly<Partial<Record<DraftAiField, string>>>,
  b: Readonly<Partial<Record<DraftAiField, string>>> | undefined,
): boolean {
  const keysA = Object.keys(a);
  const keysB = b ? Object.keys(b) : [];
  if (keysA.length !== keysB.length) return true;
  return keysA.some((k) => a[k as DraftAiField] !== b?.[k as DraftAiField]);
}

/** One field's suggested-vs-chosen pair. */
export interface SuggestDiffEntry {
  field: DraftAiField;
  /** What the background parse proposed. Always present (see suggestDiff). */
  suggested: string;
  /** What the launch actually carried, or undefined (left unset / unpinned / none). */
  chosen?: string;
}

const LEDGER_FIELDS: readonly DraftAiField[] = ['project', 'cwd', 'pinTier', 'priority', 'startDate', 'dueDate'];

/**
 * The suggested-vs-chosen ledger for a draft that is about to commit (Start, or
 * "Create task for later").
 *
 * The auto-suggestion is the part of the draft the user did not write, so every
 * proposal is recorded against what the launch actually carried: "the AI feels
 * inaccurate" becomes a per-field number. Only fields the AI actually PROPOSED are
 * recorded (silence is no evidence), and only fields the draft shows as chips and
 * the user can change before committing: project, folder, tier, priority (when
 * shown; applyDraftParse records none while hidden), start and due. Never the
 * end: it cannot be changed on its own, so "kept" would say nothing.
 *
 * Chosen values match what the launch sends: a tier the draft cannot resolve goes
 * out as Focus, an unpinned tier and priority 'none' count as dropped.
 */
export function suggestDiff(
  draft: DraftColumn,
  opts: { tierKnown?: (id: string) => boolean | 'unknown' } = {},
): SuggestDiffEntry[] {
  const known = opts.tierKnown ?? builtinTierKnown;
  const { meta } = draft;
  const tier = meta.pinTier;
  const chosen: Partial<Record<DraftAiField, string | undefined>> = {
    project: draft.project || undefined,
    cwd: draft.cwd || undefined,
    pinTier: tier === undefined ? undefined : known(tier) === false ? DEFAULT_META.pinTier : tier,
    priority: meta.priority === 'none' ? undefined : meta.priority,
    startDate: meta.startDate || undefined,
    dueDate: meta.dueDate || undefined,
  };
  const out: SuggestDiffEntry[] = [];
  for (const field of LEDGER_FIELDS) {
    const suggested = draft.aiSuggested?.[field];
    if (suggested === undefined) continue;
    const picked = chosen[field];
    out.push({ field, suggested, ...(picked !== undefined ? { chosen: picked } : {}) });
  }
  return out;
}
