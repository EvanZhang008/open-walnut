/**
 * FilterDimRows: the dimension rows of the Filter popover (spec 3.2, 6.2).
 * Presentational: every write goes through `controller.apply`. What the
 * popover shows (Recent entries, which rows, each row's value order) is frozen
 * at open (G5) by `takeFilterSnapshot`; only selection and counts are live.
 */
import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ICON_CHECK, ICON_CHEVRON_RIGHT } from '../common/Icons';
import {
  DATE_FILTER_OPTIONS,
  dimLabel,
  dimValues,
  isDimVisible,
  moreSetCount,
  pickValue,
  STATUS_LAST_VALUE_TITLE,
} from './filter-bar-model';
import { applyRecentEntry, isRecentActive, recentEntryLabel } from './filter-recent';
import { TIME_BASIS_OPTIONS } from './view-filter-model';
import {
  FILTER_DIMS,
  MORE_DIMS,
  type DateFilterValue,
  type FilterBarController,
  type FilterDim,
  type FilterPickMode,
  type FilterValueOption,
  type RecentEntry,
} from './filter-bar-types';
import { PAIR_DIMS, clickMode, isValueSelected, useFilterWriter, valueAttrs, type FilterWriter } from './FilterValuesFlyout';

/** First-layer caps before `N more` (5.4). */
/** Dimensions whose values carry a facet count (4.1). */
const COUNT_DIMS: readonly FilterDim[] = ['project', 'source', 'tags', 'sprint'];

export const VALUE_CAPS: Partial<Record<FilterDim, number>> = { project: 8, tags: 12, sprint: 8, source: 8, priority: 8 };

export interface FilterSnapshot {
  recent: RecentEntry[];
  dims: FilterDim[];
  values: Partial<Record<FilterDim, FilterValueOption[]>>;
  /** A long-tail Date value selected at open, drawn in the first layer. */
  dateExtra: DateFilterValue | null;
}

export function takeFilterSnapshot(c: Pick<FilterBarController, 'state' | 'lists' | 'recent'>): FilterSnapshot {
  const dims = FILTER_DIMS.filter((d) => isDimVisible(d, c.state, c.lists));
  const values: FilterSnapshot['values'] = {};
  for (const d of dims) values[d] = dimValues(d, c.state, c.lists);
  const first = DATE_FILTER_OPTIONS.find((o) => o.value === c.state.date)?.firstLayer ?? true;
  return { recent: [...c.recent], dims, values, dateExtra: first ? null : c.state.date };
}

/** Which flyout the popover has open: the dimension and the button it hangs from. */
export interface FlyoutRequest {
  dim: FilterDim;
  anchor: HTMLElement;
}

interface RowsCtx {
  controller: FilterBarController;
  writer: FilterWriter;
  snap: FilterSnapshot;
  flyout: FlyoutRequest | null;
  onOpenFlyout(req: FlyoutRequest | null): void;
}

function pick(w: FilterWriter, dim: FilterDim, value: string, mode: FilterPickMode): void {
  w.write((s) => pickValue(s, dim, value, mode), 'menu');
}

function DimRow({ dim, label, children }: { dim: string; label: string; children: ReactNode }) {
  return (
    <div className="fb-dim" data-filter-dim={dim}>
      <div className="fb-dim-label">{label}</div>
      <div className="fb-dim-values">{children}</div>
    </div>
  );
}

function Count({ n }: { n: number | undefined }) {
  return <span className={`tp-count${(n ?? 0) === 0 ? ' is-zero' : ''}`}>{n ?? 0}</span>;
}

/** One popover value. Project and Source pair it with the add square (G13). */
function ValueChip({ c, w, dim, opt }: { c: FilterBarController; w: FilterWriter; dim: FilterDim; opt: FilterValueOption }) {
  const sel = isValueSelected(c.state, dim, opt.value);
  const locked = dim === 'status' && sel && c.state.status.length === 1;
  const counts = COUNT_DIMS.includes(dim) ? c.facets[dim] : undefined;
  const zero = counts !== undefined && (counts[opt.value] ?? 0) === 0;
  const status = dim === 'status';
  const cls = `fb-val tp-val${status ? ' fb-val-status' : ''}${dim === 'tags' ? ' fb-val-tag' : ''}${opt.missing ? ' is-missing' : ''}${zero ? ' is-zero' : ''}`;
  const onClick = (e: MouseEvent) => { if (!locked) pick(w, dim, opt.value, clickMode(e)); };
  // One Tab stop per value (F38): on a Project / Source value, Cmd/Ctrl+Enter or
  // `+` adds it (the square's job for the pointer).
  const onKeyDown = (e: KeyboardEvent) => {
    if (!PAIR_DIMS.includes(dim)) return;
    if (e.key === '+' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      pick(w, dim, opt.value, 'toggle');
    }
  };
  const body = (
    <button
      type="button"
      className={cls}
      {...valueAttrs(dim, opt)}
      aria-pressed={sel}
      aria-disabled={locked || undefined}
      title={locked ? opt.disabledTitle ?? STATUS_LAST_VALUE_TITLE : opt.title}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {/* One selected signal (G27): the tick sits in the left padding, so a pick never
          widens the chip (C47) and an unselected value has no empty slot (F15). Status
          values carry no phase icon here: Need Action's and Complete's own ticks read as
          a second, false selection mark (F04). */}
      {!PAIR_DIMS.includes(dim) && sel && <span className="fb-check" aria-hidden="true">{ICON_CHECK}</span>}
      <span className="fb-val-text">{dim === 'tags' ? <TagText tag={opt.value} label={opt.label} /> : opt.label}</span>
      {counts !== undefined && <Count n={counts[opt.value]} />}
    </button>
  );
  if (!PAIR_DIMS.includes(dim)) return body;
  return (
    <span className={`fb-val-pair${sel ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="fb-val-add"
        role="checkbox"
        tabIndex={-1}
        aria-checked={sel}
        aria-label={`Add ${opt.label}`}
        onClick={() => pick(w, dim, opt.value, 'toggle')}
      >
        {sel ? ICON_CHECK : null}
      </button>
      {body}
    </span>
  );
}

/** A tag in the TagChip's own words (G26, F21): a bold `key:` prefix unless the board shows the value only. */
export function TagText({ tag, label }: { tag: string; label: string }) {
  const at = tag.indexOf(':');
  if (at <= 0 || at >= tag.length - 1 || label !== tag) return <>{label}</>;
  return (
    <>
      <span className="fb-tag-prefix">{tag.slice(0, at + 1)}</span>
      {tag.slice(at + 1)}
    </>
  );
}

function RecentRow({ c, w, entries }: { c: FilterBarController; w: FilterWriter; entries: RecentEntry[] }) {
  return (
    <DimRow dim="recent" label="Recent">
      {entries.map((entry) => {
        const on = isRecentActive(c.state, entry);
        const label = recentEntryLabel(entry, c.lists);
        return (
          <button
            key={`${entry.dim}:${String(entry.value)}`}
            type="button"
            className="fb-val tp-val fb-recent-val"
            data-filter-value={label}
            data-recent-dim={entry.dim}
            aria-pressed={on}
            title={on ? `${label} is on. Click to remove it` : `Filter by ${label}`}
            onClick={() => w.write((st) => applyRecentEntry(st, entry), 'recent')}
          >
            {on && <span className="fb-check" aria-hidden="true">{ICON_CHECK}</span>}
            <span className="fb-val-text">{label}</span>
          </button>
        );
      })}
    </DimRow>
  );
}

function StatusRow({ c, w, opts }: { c: FilterBarController; w: FilterWriter; opts: FilterValueOption[] }) {
  const open = opts.filter((o) => o.value === 'TODO' || o.value === 'IN_PROGRESS' || o.value === 'NEED_ACTION');
  const rest = opts.filter((o) => !open.includes(o));
  return (
    <DimRow dim="status" label={dimLabel('status')}>
      <span className="fb-status-open">
        <span className="fb-open-label" aria-hidden="true">Open</span>
        <span className="fb-status-open-values">
          {open.map((o) => <ValueChip key={o.value} c={c} w={w} dim="status" opt={o} />)}
        </span>
      </span>
      {rest.map((o) => <ValueChip key={o.value} c={c} w={w} dim="status" opt={o} />)}
    </DimRow>
  );
}

/** The `N more` / `More dates` button that opens the shared values flyout. */
function MoreButton({ ctx, dim, text }: { ctx: RowsCtx; dim: FilterDim; text: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const open = ctx.flyout?.dim === dim;
  return (
    <button
      ref={ref}
      type="button"
      className="fb-val tp-val fb-more-btn"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => ctx.onOpenFlyout(open || !ref.current ? null : { dim, anchor: ref.current })}
    >
      {text}
    </button>
  );
}

/** A list dimension (Project, Source, Tags, Sprint, Priority, Blocked): first N values + `N more`. */
function ListRow({ ctx, dim }: { ctx: RowsCtx; dim: FilterDim }) {
  const c = ctx.controller;
  const opts = ctx.snap.values[dim] ?? [];
  if (dim === 'project' && c.lists.loading) {
    return (
      <DimRow dim={dim} label={dimLabel(dim)}>
        <span className="fb-loading">Loading projects</span>
      </DimRow>
    );
  }
  const cap = VALUE_CAPS[dim] ?? opts.length;
  const shown = opts.slice(0, cap);
  const hidden = opts.length - shown.length;
  return (
    <DimRow dim={dim} label={dimLabel(dim)}>
      {shown.map((o) => <ValueChip key={o.value || '(inbox)'} c={c} w={ctx.writer} dim={dim} opt={o} />)}
      {hidden > 0 && <MoreButton ctx={ctx} dim={dim} text={`${hidden} more`} />}
    </DimRow>
  );
}

function DateRow({ ctx }: { ctx: RowsCtx }) {
  const c = ctx.controller;
  const opts = ctx.snap.values.date ?? [];
  const firstIds = DATE_FILTER_OPTIONS.filter((o) => o.firstLayer).map((o) => o.value as string);
  // A date picked in the More dates flyout shows selected here at once (F22),
  // so it is one click to remove; otherwise the value the popover opened with.
  const live = c.state.date as string;
  const extra = !firstIds.includes(live) ? live : ctx.snap.dateExtra;
  if (extra !== null && !firstIds.includes(extra)) firstIds.push(extra);
  return (
    <DimRow dim="date" label={dimLabel('date')}>
      {firstIds.map((id) => {
        const opt = opts.find((o) => o.value === id);
        return opt ? <ValueChip key={id || '(any)'} c={c} w={ctx.writer} dim="date" opt={opt} /> : null;
      })}
      <MoreButton ctx={ctx} dim="date" text="More dates" />
    </DimRow>
  );
}

function TimeRow({ ctx }: { ctx: RowsCtx }) {
  const c = ctx.controller;
  const opts = ctx.snap.values.time ?? [];
  const basis = c.state.time.basis;
  return (
    <DimRow dim="time" label={dimLabel('time')}>
      {/* No window set: the basis reads as a choice, not as a live filter (F21). */}
      <span className={`tp-seg fb-time-basis${c.state.time.preset === null ? ' is-unset' : ''}`} role="radiogroup" aria-label="Time basis">
        {TIME_BASIS_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            className="tp-seg-btn"
            aria-checked={basis === o.value}
            data-time-basis={o.value}
            title={o.value === 'created_or_updated' ? 'Created or updated in the window' : `${o.label} in the window`}
            onClick={() => ctx.writer.write((st) => ({ ...st, time: { ...st.time, basis: o.value } }), 'menu')}
          >
            {o.label}
          </button>
        ))}
      </span>
      <span className="fb-break" aria-hidden="true" />
      {opts.map((o) => <ValueChip key={o.value} c={c} w={ctx.writer} dim="time" opt={o} />)}
    </DimRow>
  );
}

function DimSwitch({ ctx, dim }: { ctx: RowsCtx; dim: FilterDim }) {
  if (dim === 'status') return <StatusRow c={ctx.controller} w={ctx.writer} opts={ctx.snap.values.status ?? []} />;
  if (dim === 'date') return <DateRow ctx={ctx} />;
  if (dim === 'time') return <TimeRow ctx={ctx} />;
  return <ListRow ctx={ctx} dim={dim} />;
}

export interface FilterDimRowsProps extends Omit<RowsCtx, 'writer'> {
  /** The popover's shared writer; the rows make their own when absent. */
  writer?: FilterWriter;
  moreOpen: boolean;
  onMoreOpenChange(open: boolean): void;
}

/** Recent, the first-layer rows, then the `More filters` fold (always in the DOM, `hidden` when shut). */
export function FilterDimRows({ moreOpen, onMoreOpenChange, writer, ...rest }: FilterDimRowsProps) {
  const own = useFilterWriter(rest.controller);
  const ctx: RowsCtx = { ...rest, writer: writer ?? own };
  const c = ctx.controller;
  const first = ctx.snap.dims.filter((d) => !MORE_DIMS.includes(d));
  const more = ctx.snap.dims.filter((d) => MORE_DIMS.includes(d));
  const setCount = moreSetCount(c.state);
  return (
    <div className="fb-dims">
      {ctx.snap.recent.length > 0 && <RecentRow c={c} w={ctx.writer} entries={ctx.snap.recent} />}
      {first.map((d) => <DimSwitch key={d} ctx={ctx} dim={d} />)}
      {more.length > 0 && (
        <>
          <button
            type="button"
            className="fb-more-toggle"
            aria-expanded={moreOpen}
            aria-controls="fb-more-body"
            onClick={() => onMoreOpenChange(!moreOpen)}
          >
            <span className="fb-more-chevron" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>
            <span>{setCount > 0 ? `More filters (${setCount} set)` : 'More filters'}</span>
          </button>
          <div id="fb-more-body" className="fb-more-body" hidden={!moreOpen}>
            {more.map((d) => <DimSwitch key={d} ctx={ctx} dim={d} />)}
          </div>
        </>
      )}
    </div>
  );
}

/** Options and search label for the flyout a row opened. */
export function flyoutOptions(snap: FilterSnapshot, dim: FilterDim): { options: FilterValueOption[]; searchLabel: string | null; label: string } {
  const all = snap.values[dim] ?? [];
  if (dim === 'date') {
    const tail = DATE_FILTER_OPTIONS.filter((o) => !o.firstLayer).map((o) => o.value as string);
    return { options: all.filter((o) => tail.includes(o.value)), searchLabel: null, label: 'More dates' };
  }
  const word = dim === 'tags' ? 'tags' : dim === 'project' ? 'projects' : `${dimLabel(dim).toLowerCase()} values`;
  return { options: all, searchLabel: `Search ${word}`, label: `All ${word}` };
}
