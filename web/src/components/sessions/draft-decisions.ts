/**
 * The draft column's decision chips as DATA: which task-field decisions the row
 * shows, in which order, with which words. Pure (no React); DraftDecisionRow only
 * renders what this returns.
 *
 * One chip per decided field, fixed order tier, priority, start, due, unread, so
 * the n-th chip matches the n-th block of the menu it opens. A chip marks ✦ only
 * when the AI owns the field (isAiOwned). Words come from the same tables the
 * menu renders (TIER_OPTIONS, PRIORITY_OPTIONS, the app's custom tier labels):
 * never a second copy here, or the chip and the menu stop agreeing.
 *
 * Dates use formatDateTimeDisplay, the "confirm what the AI understood" format
 * (Today, Tomorrow, a weekday within the week, M/D beyond), with ONE exception
 * kept local (formatDraftDate): exactly 7 days ahead reads M/D, since on a
 * Thursday "Due Thu" cannot say whether it means today or next week.
 */

import { formatDateTimeDisplay, parseDateLocal } from '@/components/common/DatePicker';
import { PRIORITY_OPTIONS, TIER_OPTIONS, tierColor } from './task-meta-constants';
import type { DraftColumn, DraftOwnedField, DraftTaskField } from './draft-column';
import { isAiOwned } from './draft-ownership';

export type DraftDecisionPriority = 'immediate' | 'important' | 'backlog';

/** What sits in front of the label. `tier: null` = the "not pinned" state. */
export type DraftDecisionGlyph =
  | { kind: 'tier'; tier: string | null; color: string }
  | { kind: 'priority'; value: DraftDecisionPriority; icon: string; color: string }
  | { kind: 'unread' }
  | null;

export type DraftDecisionSource = 'ai' | 'user' | 'seed';

export interface DraftDecisionChip {
  field: DraftOwnedField;
  /** The chip's words, without the glyph and without the ✦. */
  label: string;
  glyph: DraftDecisionGlyph;
  /** The AI owns this value: render the ✦ and the accent outline. */
  ai: boolean;
  source: DraftDecisionSource;
  title: string;
  ariaLabel: string;
  /** A due date already in the past. */
  overdue?: boolean;
  /** A custom tier id that no longer resolves (custom tiers loaded). */
  removedTier?: boolean;
  /** A resolved custom tier: its user-named label gets the 18ch cap. */
  customTier?: boolean;
}

export interface DraftDecisionCtx {
  /** Label of a custom tier id, undefined when it does not resolve. */
  tierLabel: (id: string) => string | undefined;
  /** False until the custom tiers are fetched: an unresolved ct_* is then
   *  "Custom tier", never "Removed tier". */
  customTiersLoaded: boolean;
  /** `ui.show_priority`; 'unknown' before the config is read = hidden. */
  priorityVisible: boolean | 'unknown';
  now: Date;
}

const BUILTIN_TIER_LABEL: ReadonlyMap<string, string> = new Map(TIER_OPTIONS.map((t) => [t.value, t.label]));

/** Build `DraftDecisionCtx.tierLabel` from the app's custom tier list. */
export function customTierLabelLookup(
  customTiers: readonly { id: string; label: string }[],
): (id: string) => string | undefined {
  const byId = new Map(customTiers.map((t) => [t.id, t.label]));
  return (id) => byId.get(id);
}

/** Whole calendar days from `now`'s day to `d`'s day. */
function dayDiff(d: Date, now: Date): number {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * formatDateTimeDisplay, except exactly 7 days ahead reads M/D (C64). `now` only
 * drives that check; the shared formatter reads the clock itself and is not
 * changed, so every other caller keeps its output.
 */
export function formatDraftDate(iso: string, now: Date = new Date()): string {
  const full = formatDateTimeDisplay(iso);
  const d = parseDateLocal(iso);
  if (isNaN(d.getTime()) || dayDiff(d, now) !== 7) return full;
  const space = full.indexOf(' ');
  return `${d.getMonth() + 1}/${d.getDate()}${space >= 0 ? full.slice(space) : ''}`;
}

/** Same-calendar-day check for a start/end range. */
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** A date is past: a datetime before now, a plain date before today. */
function isPast(iso: string, now: Date): boolean {
  const d = parseDateLocal(iso);
  if (isNaN(d.getTime())) return false;
  if (iso.includes('T')) return d.getTime() < now.getTime();
  return dayDiff(d, now) < 0;
}

/** The time half of a formatted datetime ("Fri 15:00" gives "15:00"). */
function timeOf(formatted: string): string {
  const space = formatted.indexOf(' ');
  return space >= 0 ? formatted.slice(space + 1) : '';
}

/** Tier words: built-in from TIER_OPTIONS, custom from the app's labels. */
export function draftTierLabel(tier: string, ctx: Pick<DraftDecisionCtx, 'tierLabel'>): string | undefined {
  return BUILTIN_TIER_LABEL.get(tier) ?? ctx.tierLabel(tier);
}

/** Priority words from PRIORITY_OPTIONS, with the icon ("!! Immediate"): the
 *  same text the draft menu's priority button shows. */
export function draftPriorityText(value: string): string {
  const p = PRIORITY_OPTIONS.find((o) => o.value === value);
  return p ? `${p.icon} ${p.label}` : value;
}

function sourceOf(draft: DraftColumn, field: DraftOwnedField): DraftDecisionSource {
  const owner = draft.fieldOwner?.[field];
  if (owner === 'seed') return 'seed';
  if (owner === 'user') return 'user';
  if (field !== 'unread' && isAiOwned(draft, field)) return 'ai';
  return 'user';
}

function sourceSentence(source: DraftDecisionSource, seedTier: string | undefined): string {
  if (source === 'ai') return 'Set by Walnut from your text.';
  if (source === 'seed') return `From the + on the ${seedTier ?? 'tier'} section.`;
  return 'Set by you.';
}

function chipOf(
  draft: DraftColumn, field: DraftOwnedField, label: string, glyph: DraftDecisionGlyph,
  titleField: string, titleValue: string, seedTier?: string,
  extra: Partial<DraftDecisionChip> = {},
): DraftDecisionChip {
  const source = sourceOf(draft, field);
  const title = `${titleField}: ${titleValue}. ${sourceSentence(source, seedTier)} Click to change.`;
  return { field, label, glyph, ai: source === 'ai', source, title, ariaLabel: title, ...extra };
}

function tierChip(draft: DraftColumn, ctx: DraftDecisionCtx): DraftDecisionChip | null {
  const owned = !!draft.fieldOwner?.pinTier;
  if (!owned && !isAiOwned(draft, 'pinTier')) return null;
  const tier = draft.meta.pinTier;
  if (!tier) {
    return chipOf(draft, 'pinTier', 'Not pinned', { kind: 'tier', tier: null, color: 'var(--fg-muted)' },
      'Pinned tier', 'Not pinned');
  }
  const builtin = BUILTIN_TIER_LABEL.get(tier);
  if (builtin) {
    return chipOf(draft, 'pinTier', builtin, { kind: 'tier', tier, color: tierColor(tier) },
      'Pinned tier', builtin, builtin);
  }
  if (!ctx.customTiersLoaded) {
    return chipOf(draft, 'pinTier', 'Custom tier', { kind: 'tier', tier, color: 'var(--fg-muted)' },
      'Pinned tier', 'Custom tier', 'Custom tier');
  }
  const custom = ctx.tierLabel(tier);
  if (custom === undefined) {
    const title = 'This tier no longer exists, so the task will land in Focus. Click to change.';
    return {
      ...chipOf(draft, 'pinTier', 'Removed tier', { kind: 'tier', tier, color: 'var(--danger, var(--error))' }, 'Pinned tier', ''),
      title, ariaLabel: title, removedTier: true,
    };
  }
  return chipOf(draft, 'pinTier', custom, { kind: 'tier', tier, color: 'var(--tier-custom)' },
    'Pinned tier', custom, custom, { customTier: true });
}

function priorityChip(draft: DraftColumn, ctx: DraftDecisionCtx): DraftDecisionChip | null {
  if (ctx.priorityVisible !== true) return null;
  const value = draft.meta.priority;
  if (value !== 'immediate' && value !== 'important' && value !== 'backlog') return null;
  if (!draft.fieldOwner?.priority && !isAiOwned(draft, 'priority')) return null;
  const opt = PRIORITY_OPTIONS.find((o) => o.value === value)!;
  return chipOf(draft, 'priority', opt.label,
    { kind: 'priority', value, icon: opt.icon, color: `var(--priority-${value})` },
    'Priority', opt.label);
}

function startChip(draft: DraftColumn, now: Date): DraftDecisionChip | null {
  const start = draft.meta.startDate;
  if (!start) return null;
  const startText = formatDraftDate(start, now);
  const end = draft.meta.endDate;
  let range = startText;
  let titleValue = startText;
  if (end) {
    const s = parseDateLocal(start);
    const e = parseDateLocal(end);
    const endText = formatDraftDate(end, now);
    const endShort = !isNaN(s.getTime()) && !isNaN(e.getTime()) && sameDay(s, e) ? timeOf(endText) : endText;
    if (endShort) {
      range = `${startText} to ${endShort}`;
      titleValue = `${startText}, ends ${endShort}`;
    }
  }
  return chipOf(draft, 'startDate', `Start ${range}`, null, 'Start', titleValue);
}

function dueChip(draft: DraftColumn, now: Date): DraftDecisionChip | null {
  const due = draft.meta.dueDate;
  if (!due) return null;
  const text = formatDraftDate(due, now);
  return chipOf(draft, 'dueDate', `Due ${text}`, null, 'Due', text, undefined,
    isPast(due, now) ? { overdue: true } : {});
}

function unreadChip(draft: DraftColumn): DraftDecisionChip | null {
  if (draft.meta.unread !== true) return null;
  const title = 'Start state: unread. Click to change.';
  return {
    field: 'unread', label: 'Starts unread', glyph: { kind: 'unread' }, ai: false,
    source: draft.fieldOwner?.unread === 'seed' ? 'seed' : 'user', title, ariaLabel: title,
  };
}

/** The decision chips for one draft, in the fixed field order (spec 5.1). */
export function draftDecisionChips(draft: DraftColumn, ctx: DraftDecisionCtx): DraftDecisionChip[] {
  return [
    tierChip(draft, ctx), priorityChip(draft, ctx), startChip(draft, ctx.now), dueChip(draft, ctx.now),
    unreadChip(draft),
  ].filter((c): c is DraftDecisionChip => c !== null);
}

/** The "✦ = decided by Walnut" legend: only over non-empty text, and only while
 *  something on the bar carries a ✦ (a decision chip, the AI folder or project).
 *  Pass `chips = []` where the bar draws no decision chips. */
export function draftDecisionsKeyVisible(
  draft: DraftColumn, composerText: string, chips: readonly DraftDecisionChip[],
): boolean {
  if (!composerText.trim()) return false;
  return chips.some((c) => c.ai) || isAiOwned(draft, 'project') || isAiOwned(draft, 'cwd');
}

/** Words for "Use Walnut's pick: <label>" (C61): the chip's rule for the value. */
export function draftSuggestionLabel(
  field: DraftTaskField, value: string, ctx: Pick<DraftDecisionCtx, 'tierLabel' | 'now'>,
): string {
  if (field === 'pinTier') return draftTierLabel(value, ctx) ?? 'Custom tier';
  if (field === 'priority') return draftPriorityText(value);
  return formatDraftDate(value, ctx.now);
}

/**
 * Fields whose menu block offers "Use Walnut's pick": owned by the user or a
 * seed, and the parse proposed a DIFFERENT value. Priority only while visible.
 */
export function draftWalnutPicks(
  draft: DraftColumn, ctx: Pick<DraftDecisionCtx, 'priorityVisible'>,
): Partial<Record<DraftTaskField, string>> {
  const out: Partial<Record<DraftTaskField, string>> = {};
  const fields: DraftTaskField[] = ['pinTier', 'priority', 'startDate', 'dueDate'];
  for (const f of fields) {
    if (!draft.fieldOwner?.[f]) continue;
    if (f === 'priority' && ctx.priorityVisible !== true) continue;
    const suggested = draft.aiSuggested?.[f];
    if (suggested === undefined) continue;
    const raw = draft.meta[f];
    const current = f === 'priority' && raw === 'none' ? undefined : raw;
    if (suggested !== current) out[f] = suggested;
  }
  return out;
}
