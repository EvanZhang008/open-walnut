/**
 * FilterValueList: one property's values as a checklist, shared by the Filter
 * menu's second page and the filter row's chip menus (spec 6.2, 6.4). Custom
 * rows, no native controls: a multi-select row toggles on click and shows
 * `Only` on hover; a single-select row (Date, Blocked, a Time window) replaces.
 * The caller owns the search text (the menu's one search box filters the rows).
 */
import { useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { ICON_CHECK } from '../common/Icons';
import type { TaskPhase } from '@open-walnut/core';
import {
  DEFAULT_VALUE,
  OPEN_GROUP_TITLE,
  OPEN_GROUP_VALUE,
  OPEN_PHASES,
  STATUS_LAST_VALUE_TITLE,
  anyRowLabel,
  defaultValueOf,
  dimLabel,
  isDimDefault,
  isOpenGroupLocked,
  openGroupState,
  sameName,
  selectedValues,
} from './filter-bar-model';
import type { FilterBarController, FilterDim, FilterOrigin, FilterPickMode, FilterState, FilterValueOption } from './filter-bar-types';

/** Writes that chain on the newest state, even before the controller's props catch up. */
export interface FilterWriter {
  state(): FilterState;
  write(next: (s: FilterState) => FilterState, origin: FilterOrigin): void;
}

/**
 * `controller.apply(next)` takes a whole state, so two quick clicks computed
 * from the same render's `controller.state` would drop the first one. The
 * writer keeps the last state it wrote and computes the next click from it;
 * a new `controller.state` from the parent (any writer, any surface) wins.
 */
export function useFilterWriter(c: FilterBarController): FilterWriter {
  const ref = useRef({ seen: c.state, latest: c.state, pending: [] as FilterState[] });
  const cur = ref.current;
  if (cur.seen !== c.state) {
    // One of our own writes landing keeps the later ones; anything else wins.
    const i = cur.pending.indexOf(c.state);
    if (i >= 0) { cur.seen = c.state; cur.pending = cur.pending.slice(i + 1); }
    else ref.current = { seen: c.state, latest: c.state, pending: [] };
  }
  const apply = useRef(c.apply);
  apply.current = c.apply;
  return useMemo<FilterWriter>(() => ({
    state: () => ref.current.latest,
    write: (f, origin) => {
      const prev = ref.current.latest;
      const next = f(prev);
      if (next === prev) return;
      ref.current.latest = next;
      ref.current.pending = [...ref.current.pending.slice(-7), next];
      apply.current(next, origin);
    },
  }), []);
}

/** Multi-select dimensions: checklist rows, `Only` button. */
export const MULTI_DIMS: readonly FilterDim[] = ['status', 'project', 'source', 'priority', 'tags', 'sprint'];
/** Dimensions whose values carry a facet count (4.1). */
export const COUNT_DIMS: readonly FilterDim[] = ['project', 'source', 'tags', 'sprint'];
/** Dimensions long enough for the search box to filter their rows. */
export const SEARCHABLE_DIMS: readonly FilterDim[] = ['project', 'tags', 'source', 'sprint'];
export const SEARCH_AFTER = 6;

export function isValueSelected(state: FilterState, dim: FilterDim, value: string): boolean {
  const sel = selectedValues(state, dim);
  return dim === 'project' ? sel.some((v) => sameName(v, value)) : sel.includes(value);
}

/** The mode a plain click means: a checklist row toggles, a single-select row replaces. */
export function clickMode(dim: FilterDim): FilterPickMode {
  return MULTI_DIMS.includes(dim) ? 'toggle' : 'replace';
}

/** `data-*` attributes every value control carries (helpers and specs key on them). */
export function valueAttrs(dim: FilterDim, opt: Pick<FilterValueOption, 'value' | 'label'>): Record<string, string> {
  const attrs: Record<string, string> = { 'data-filter-value': opt.label };
  if (dim === 'date') attrs['data-date-value'] = opt.value;
  return attrs;
}

/** Move focus between rows of one list with the arrow keys. */
export function arrowFocus(e: KeyboardEvent<HTMLElement>, selector: string): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector)).filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
  e.preventDefault();
  items[at < 0 ? 0 : next]?.focus();
}

/** The rows `query` leaves: a case-insensitive substring match on the label. */
export function filterOptions(options: readonly FilterValueOption[], query: string): FilterValueOption[] {
  const q = query.trim().toLowerCase();
  return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : [...options];
}

export interface FilterValueListProps {
  dim: FilterDim;
  /** Row order, fixed by the caller (snapshot at open). */
  options: readonly FilterValueOption[];
  state: FilterState;
  counts?: Record<string, number>;
  /** Text of the caller's search box; filters the rows. */
  query?: string;
  onPick(value: string, mode: FilterPickMode): void;
  /** Focus the first (selected) row at mount. */
  autoFocus?: boolean;
  /** Called when the arrow keys run off the top of the list (the caller's search box takes focus). */
  onExitTop?(): void;
  /** Draw the `Any` row (a chip menu has `Remove filter` for it instead). */
  anyRow?: boolean;
}

/** The muted word on the row a property starts at. */
export const DEFAULT_TAG = 'Default';

interface RowProps {
  value: string;
  label: string;
  title: string;
  /** `mixed` = part of the Open block is on (a dash in the box). */
  sel: boolean | 'mixed';
  locked: boolean;
  multi: boolean;
  /** One of the Open block's own statuses, drawn under the Open row. */
  child?: boolean;
  isDefault: boolean;
  missing?: boolean;
  count?: number;
  attrs: Record<string, string>;
  /** `Only` beside the row (checklist rows that can be picked alone). */
  only: boolean;
  onPick(value: string, mode: FilterPickMode): void;
  pickMode: FilterPickMode;
}

function ValueRow({ value, label, title, sel, locked, multi, child, isDefault, missing, count, attrs, only, onPick, pickMode }: RowProps) {
  const on = sel === true;
  return (
    <div className={`fb-opt${on ? ' is-selected' : ''}${sel === 'mixed' ? ' is-mixed' : ''}${missing ? ' is-missing' : ''}${child ? ' is-child' : ''}`}>
      <button
        type="button"
        className="fb-opt-body"
        {...attrs}
        aria-pressed={sel}
        aria-disabled={locked || undefined}
        title={locked ? STATUS_LAST_VALUE_TITLE : title}
        onClick={() => { if (!locked) onPick(value, pickMode); }}
      >
        {/* Checklist rows draw a square; single-select rows a plain tick in the same slot. */}
        <span className={`fb-check${multi ? ' fb-check-box' : ''}`} aria-hidden="true">
          {on ? ICON_CHECK : sel === 'mixed' ? <span className="fb-check-dash" /> : null}
        </span>
        <span className="fb-opt-label">{label}</span>
        {isDefault && <span className="fb-opt-default">{DEFAULT_TAG}</span>}
        {count !== undefined && <span className={`tp-count${count === 0 ? ' is-zero' : ''}`}>{count}</span>}
      </button>
      {only && (
        <button type="button" className="fb-only" tabIndex={-1} aria-label={`Only ${label}`} onClick={() => onPick(value, 'only')}>
          Only
        </button>
      )}
    </div>
  );
}

/**
 * The value rows. Selection is read live from `state`. Every list names its
 * default: Status opens with the Open row (To Do, In Progress and Need Action
 * under it), Date tags Available now, and the rest start with an `Any` row that
 * clears the property.
 */
export function FilterValueList({ dim, options, state, counts, query = '', onPick, autoFocus, onExitTop, anyRow = true }: FilterValueListProps) {
  const multi = MULTI_DIMS.includes(dim);
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!autoFocus) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.fb-opt-body');
    const first = rows && (Array.from(rows).find((r) => r.getAttribute('aria-pressed') === 'true') ?? rows[0]);
    first?.focus({ preventScroll: true });
  }, [autoFocus]);
  const shown = useMemo(() => filterOptions(options, query), [options, query]);
  const q = query.trim().toLowerCase();
  const matches = (label: string) => !q || label.toLowerCase().includes(q);
  const statusSel = (dim === 'status' ? selectedValues(state, 'status') : []) as TaskPhase[];
  const defaultValue = defaultValueOf(dim);
  const anyLabel = anyRowLabel(dim);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp' && onExitTop) {
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('.fb-opt-body') ?? []);
      if (rows.indexOf(document.activeElement as HTMLElement) === 0) { e.preventDefault(); onExitTop(); return; }
    }
    arrowFocus(e, '.fb-opt-body');
  };
  const lead: RowProps[] = [];
  if (anyRow && anyLabel && matches(anyLabel)) {
    lead.push({
      value: DEFAULT_VALUE, label: anyLabel, title: `${dimLabel(dim)}: every task, the default`,
      sel: isDimDefault(state, dim), locked: false, multi, isDefault: true,
      attrs: { 'data-filter-value': anyLabel, 'data-default-row': '' }, only: false, onPick, pickMode: clickMode(dim),
    });
  }
  if (dim === 'status' && matches('Open')) {
    const group = openGroupState(statusSel);
    const locked = isOpenGroupLocked(statusSel);
    lead.push({
      value: OPEN_GROUP_VALUE, label: 'Open', title: OPEN_GROUP_TITLE,
      sel: group === 'all' ? true : group === 'some' ? 'mixed' : false, locked, multi, isDefault: true,
      attrs: { 'data-filter-value': 'Open', 'data-status-group': 'open' }, only: !locked, onPick, pickMode: 'toggle',
    });
  }
  return (
    <div ref={listRef} className="fb-list-rows" role="group" aria-label={`${dim} values`} onKeyDown={onKeyDown}>
      {shown.length === 0 && lead.length === 0 && <div className="fb-empty">{query.trim() ? `No match for "${query.trim()}"` : 'Nothing to pick'}</div>}
      {lead.map((r) => <ValueRow key={r.value} {...r} />)}
      {shown.map((opt) => {
        const sel = isValueSelected(state, dim, opt.value);
        const locked = dim === 'status' && sel && statusSel.length === 1;
        return (
          <ValueRow
            key={opt.value || '(inbox)'}
            value={opt.value}
            label={opt.label}
            title={opt.title}
            sel={sel}
            locked={locked}
            multi={multi}
            child={dim === 'status' && OPEN_PHASES.includes(opt.value as TaskPhase)}
            isDefault={opt.value === defaultValue}
            missing={opt.missing}
            count={counts ? counts[opt.value] ?? 0 : undefined}
            attrs={valueAttrs(dim, opt)}
            only={multi && !locked}
            onPick={onPick}
            pickMode={clickMode(dim)}
          />
        );
      })}
    </div>
  );
}
