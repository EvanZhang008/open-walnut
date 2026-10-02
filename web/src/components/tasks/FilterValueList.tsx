/**
 * FilterValueList: one property's values as a checklist, shared by the Filter
 * menu's second page and the filter row's chip menus (spec 6.2, 6.4). Custom
 * rows, no native controls: a multi-select row toggles on click and shows
 * `Only` on hover; a single-select row (Date, Blocked, a Time window) replaces.
 * The caller owns the search text (the menu's one search box filters the rows).
 */
import { useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { ICON_CHECK } from '../common/Icons';
import { STATUS_LAST_VALUE_TITLE, sameName, selectedValues } from './filter-bar-model';
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
}

/** The value rows. Selection is read live from `state`. */
export function FilterValueList({ dim, options, state, counts, query = '', onPick, autoFocus, onExitTop }: FilterValueListProps) {
  const multi = MULTI_DIMS.includes(dim);
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!autoFocus) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.fb-opt-body');
    const first = rows && (Array.from(rows).find((r) => r.getAttribute('aria-pressed') === 'true') ?? rows[0]);
    first?.focus({ preventScroll: true });
  }, [autoFocus]);
  const shown = useMemo(() => filterOptions(options, query), [options, query]);
  const statusSel = dim === 'status' ? selectedValues(state, 'status') : [];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp' && onExitTop) {
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('.fb-opt-body') ?? []);
      if (rows.indexOf(document.activeElement as HTMLElement) === 0) { e.preventDefault(); onExitTop(); return; }
    }
    arrowFocus(e, '.fb-opt-body');
  };
  return (
    <div ref={listRef} className="fb-list-rows" role="group" aria-label={`${dim} values`} onKeyDown={onKeyDown}>
      {shown.length === 0 && <div className="fb-empty">{query.trim() ? `No match for "${query.trim()}"` : 'Nothing to pick'}</div>}
      {shown.map((opt) => {
        const sel = isValueSelected(state, dim, opt.value);
        const locked = dim === 'status' && sel && statusSel.length === 1;
        return (
          <div key={opt.value || '(inbox)'} className={`fb-opt${sel ? ' is-selected' : ''}${opt.missing ? ' is-missing' : ''}`}>
            <button
              type="button"
              className="fb-opt-body"
              {...valueAttrs(dim, opt)}
              aria-pressed={sel}
              aria-disabled={locked || undefined}
              title={locked ? STATUS_LAST_VALUE_TITLE : opt.title}
              onClick={() => { if (!locked) onPick(opt.value, clickMode(dim)); }}
            >
              {/* Checklist rows draw a square; single-select rows a plain tick in the same slot. */}
              <span className={`fb-check${multi ? ' fb-check-box' : ''}`} aria-hidden="true">{sel ? ICON_CHECK : null}</span>
              <span className="fb-opt-label">{opt.label}</span>
              {counts && <span className={`tp-count${(counts[opt.value] ?? 0) === 0 ? ' is-zero' : ''}`}>{counts[opt.value] ?? 0}</span>}
            </button>
            {multi && !locked && (
              <button type="button" className="fb-only" tabIndex={-1} aria-label={`Only ${opt.label}`} onClick={() => onPick(opt.value, 'only')}>
                Only
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
