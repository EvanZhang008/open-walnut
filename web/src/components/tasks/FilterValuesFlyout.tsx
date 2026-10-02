/**
 * FilterValuesFlyout: the searchable value list shared by the Filter
 * popover's `N more` / `More dates` flyouts and the filter row's chip menu
 * (spec 5.4, 6.2, 6.4). `FilterValueList` is the list itself (custom rows, no
 * native controls); `FilterValuesFlyout` is the portalled `.fb-values-flyout`
 * placed by useMenuPlacement and closed through the overlay layer stack.
 */
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ICON_CHECK, ICON_CLOSE, ICON_SEARCH } from '../common/Icons';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
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

/** Dimensions whose plain click replaces (6.2, G13): they carry the add square. */
export const PAIR_DIMS: readonly FilterDim[] = ['project', 'source'];
/** Multi-select dimensions (Only button, toggle rows). */
export const MULTI_DIMS: readonly FilterDim[] = ['status', 'project', 'source', 'priority', 'tags', 'sprint'];

export function isValueSelected(state: FilterState, dim: FilterDim, value: string): boolean {
  const sel = selectedValues(state, dim);
  return dim === 'project' ? sel.some((v) => sameName(v, value)) : sel.includes(value);
}

/** Plain click = replace (toggle on non-pair dims); Cmd/Ctrl-click = toggle. */
export function clickMode(e: { metaKey: boolean; ctrlKey: boolean }): FilterPickMode {
  return e.metaKey || e.ctrlKey ? 'toggle' : 'replace';
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
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
  e.preventDefault();
  items[at < 0 ? 0 : next]?.focus();
}

export interface FilterValueListProps {
  dim: FilterDim;
  /** Row order, fixed by the caller (snapshot at open). */
  options: readonly FilterValueOption[];
  state: FilterState;
  counts?: Record<string, number>;
  /** Placeholder of the search box; null = no search box. */
  searchLabel: string | null;
  onPick(value: string, mode: FilterPickMode): void;
  autoFocus?: boolean;
}

/** The value rows (search box on top when asked). Selection is read live from `state`. */
export function FilterValueList({ dim, options, state, counts, searchLabel, onPick, autoFocus }: FilterValueListProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const pair = PAIR_DIMS.includes(dim);
  const multi = MULTI_DIMS.includes(dim);
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!autoFocus) return;
    if (inputRef.current) { inputRef.current.focus({ preventScroll: true }); return; }
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.fb-opt-body');
    const first = rows && (Array.from(rows).find((r) => r.getAttribute('aria-pressed') === 'true') ?? rows[0]);
    first?.focus({ preventScroll: true });
  }, [autoFocus]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const statusSel = dim === 'status' ? selectedValues(state, 'status') : [];
  return (
    <div ref={listRef} className="fb-list" onKeyDown={(e) => arrowFocus(e, '.fb-opt-body')}>
      {searchLabel !== null && (
        <div className="fb-search fb-list-search">
          <span className="fb-search-icon" aria-hidden="true">{ICON_SEARCH}</span>
          <input
            ref={inputRef}
            type="text"
            className="fb-search-input"
            placeholder={searchLabel}
            aria-label={searchLabel}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button type="button" className="fb-search-clear" aria-label="Clear search" onClick={() => { setQuery(''); inputRef.current?.focus(); }}>
              {ICON_CLOSE}
            </button>
          )}
        </div>
      )}
      <div className="fb-list-rows">
        {shown.length === 0 && <div className="fb-empty">No matches</div>}
        {shown.map((opt) => {
          const sel = isValueSelected(state, dim, opt.value);
          const locked = dim === 'status' && sel && statusSel.length === 1;
          const onBody = (e: MouseEvent) => { if (!locked) onPick(opt.value, clickMode(e)); };
          return (
            <div key={opt.value || '(inbox)'} className={`fb-opt${sel ? ' is-selected' : ''}${opt.missing ? ' is-missing' : ''}`}>
              {pair && (
                <button
                  type="button"
                  className="fb-val-add"
                  role="checkbox"
                  tabIndex={-1}
                  aria-checked={sel}
                  aria-label={`Add ${opt.label}`}
                  onClick={() => onPick(opt.value, 'toggle')}
                >
                  {sel ? ICON_CHECK : null}
                </button>
              )}
              <button
                type="button"
                className="fb-opt-body"
                {...valueAttrs(dim, opt)}
                aria-pressed={sel}
                aria-disabled={locked || undefined}
                title={locked ? STATUS_LAST_VALUE_TITLE : opt.title}
                onClick={onBody}
                onKeyDown={(e) => {
                  // One Tab stop per row (F38): Cmd/Ctrl+Enter or `+` adds on a paired row.
                  if (pair && (e.key === '+' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey)))) {
                    e.preventDefault();
                    onPick(opt.value, 'toggle');
                  }
                }}
              >
                {!pair && <span className="fb-check" aria-hidden="true">{sel ? ICON_CHECK : null}</span>}
                <span className="fb-opt-label">{opt.label}</span>
                {counts && <span className={`tp-count${(counts[opt.value] ?? 0) === 0 ? ' is-zero' : ''}`}>{counts[opt.value] ?? 0}</span>}
              </button>
              {multi && !locked && (
                <button type="button" className="fb-only" aria-label={`Only ${opt.label}`} onClick={() => onPick(opt.value, 'only')}>
                  Only
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface FilterValuesFlyoutProps extends Omit<FilterValueListProps, 'autoFocus'> {
  /** The `N more` / `More dates` button (or a chip body). */
  anchorRef: RefObject<HTMLElement | null>;
  onClose(reason: 'escape' | 'outside' | 'pick'): void;
  /** Accessible name of the flyout. */
  label: string;
  /** Close after one pick (single-select dims such as Date). */
  closeOnPick?: boolean;
}

/** The portalled `.fb-values-flyout` (5.4): own search, scrolls inside, never resizes its parent. */
export function FilterValuesFlyout({ anchorRef, onClose, label, closeOnPick, onPick, ...list }: FilterValuesFlyoutProps) {
  const ref = useRef<HTMLDivElement>(null);
  // F13: to the right of the Filter popover, level with the chip that opened it,
  // so the popover's own rows stay readable (spec 6.2).
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const chip = anchorRef.current;
    const menu = chip?.closest('.fb-menu');
    if (!chip || !menu) return;
    const right = menu.getBoundingClientRect().right + 4;
    // No room beside the popover (a narrow window): keep the default placement under the chip.
    if (right + 200 > window.innerWidth) return;
    setPoint({ x: Math.round(right), y: Math.round(chip.getBoundingClientRect().top) });
  }, [anchorRef]);
  const placement = useMenuPlacement(true, anchorRef, ref, {
    align: 'start', gap: point ? 0 : 2, minHeight: 160, anchorPoint: point, onAnchorLost: () => onClose('outside'),
  });
  useOverlayLayer({
    open: true,
    refs: [ref, anchorRef],
    onClose: (reason) => {
      onClose(reason);
      if (reason === 'escape') anchorRef.current?.focus({ preventScroll: true });
    },
  });
  const pick = (value: string, mode: FilterPickMode) => {
    onPick(value, mode);
    if (closeOnPick) {
      onClose('pick');
      anchorRef.current?.focus({ preventScroll: true });
    }
  };
  return createPortal(
    <div
      ref={ref}
      className="fb-values-flyout tp-pop"
      role="dialog"
      aria-label={label}
      style={menuPlacementStyle(placement)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <FilterValueList {...list} onPick={pick} autoFocus />
    </div>,
    document.body,
  );
}
