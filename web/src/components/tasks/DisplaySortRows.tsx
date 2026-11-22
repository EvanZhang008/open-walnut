/**
 * The Display menu's setting rows (spec 3.3, 6.5): segmented pickers with a
 * roving tabindex (Left/Right move AND pick, Home/End jump), the Sort row with
 * its inline "replace every project's own order" confirm (gap G12), the tab bar
 * switch, and the plain choice rows (Group, Session columns). Presentational;
 * DisplaySections.tsx wires them to its props.
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { SegmentedControl, ToggleSwitch } from '@/components/controls';
import type { SortBy } from './ViewDropdown';

export interface SegChoice<K extends string> {
  key: K;
  label: string;
  title?: string;
  /** Extra `data-view-option` on the segment. */
  option?: string;
}

/**
 * A segmented pick: the shared SegmentedControl (Left/Right move AND pick; Up/Down stay the
 * menu's, which moves between its rows). `value` null = mixed: no segment checked, the first
 * one takes Tab. The `tp-seg-btn` / `data-choice` hooks are what the Filter menu's keys and the
 * specs find a segment by.
 */
export function Segmented<K extends string>({ label, choices, value, onPick }: {
  label: string;
  choices: readonly SegChoice<K>[];
  value: K | null;
  onPick(key: K): void;
}) {
  return (
    <SegmentedControl
      className="tp-seg dm-seg"
      aria-label={label}
      horizontalKeys
      value={(value ?? '') as K}
      onChange={onPick}
      options={choices.map((c) => ({
        value: c.key,
        label: c.label,
        title: c.title,
        className: 'tp-seg-btn dm-seg-btn',
        data: { 'data-choice': c.key, 'data-view-option': c.option },
      }))}
    />
  );
}

/** One labelled row: the name on the left, its control on the right. */
export function DisplayRow({ option, label, title, flash, children }: {
  option?: string;
  label: string;
  title?: string;
  /** A `view-dropdown:reveal` landing: the row pulses so the eye finds it. */
  flash?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`dm-row${flash ? ' dm-row-flash' : ''}`} data-view-option={option} title={title}>
      <span className="dm-row-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * A switch row: the shared ToggleSwitch at the end of a labelled row; a click anywhere on the
 * row flips it (the row is its label). The switch carries `dm-switch-row`, the hook the Filter
 * menu's Up/Down move between.
 */
export function SwitchRow({ option, label, title, checked, onChange }: {
  option: string;
  label: string;
  title: string;
  checked: boolean;
  onChange(next: boolean): void;
}) {
  const id = useId();
  return (
    <label className="dm-row dm-switch-line" htmlFor={id} data-view-option={option} title={title}>
      <span className="dm-row-label" id={`${id}-label`}>{label}</span>
      <ToggleSwitch id={id} size="sm" className="dm-switch-row" checked={checked} onChange={onChange} aria-labelledby={`${id}-label`} title={title} />
    </label>
  );
}

/** Sort segments, with the titles the old Arrange section had. */
export const SORT_CHOICES: readonly SegChoice<SortBy>[] = [
  { key: 'manual', label: 'Manual', title: 'Manual order (drag / move buttons)' },
  { key: 'priority', label: 'Priority', title: 'Highest priority first' },
  { key: 'date', label: 'Created', title: 'Newest first' },
  { key: 'updated', label: 'Updated', title: 'Recently updated first' },
];

export function ownOrderNote(n: number): string {
  return n === 1 ? '1 project uses its own order' : `${n} projects use their own order`;
}

export function replaceOrdersQuestion(sort: SortBy, n: number): string {
  const label = SORT_CHOICES.find((c) => c.key === sort)?.label ?? sort;
  return `Use ${label} for every project? This replaces ${n} project ${n === 1 ? 'order' : 'orders'}.`;
}

/**
 * Sort for the lists the view draws. A pick drops every project's own order, so
 * while any project has one (projectSortCount > 0) no segment reads as pressed,
 * a muted line says how many, and a pick asks first: only Replace writes. With
 * none, re-picking the pressed segment writes nothing. `sortBy` null = the
 * lists differ: nothing pressed, and any pick writes.
 */
export function SortRow({ sortBy, choices = SORT_CHOICES, projectSortCount, onSortForAll }: {
  sortBy: SortBy | null;
  choices?: readonly SegChoice<SortBy>[];
  projectSortCount: number;
  onSortForAll(v: SortBy): void;
}) {
  const [pending, setPending] = useState<SortBy | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const mixed = projectSortCount > 0;
  const pick = (k: SortBy) => {
    if (mixed) { setPending(k); return; }
    setPending(null);
    if (k !== sortBy) onSortForAll(k);
  };
  // The confirm row unmounts on either answer; keep focus inside the dialog.
  const settle = (k: SortBy, replace: boolean) => {
    setPending(null);
    if (replace) onSortForAll(k);
    requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>(`[data-choice="${k}"]`)?.focus({ preventScroll: true }));
  };
  return (
    <div className="dm-sort" ref={rowRef}>
      <DisplayRow option="sort" label="Sort">
        <Segmented label="Sort" choices={choices} value={mixed ? null : sortBy} onPick={pick} />
      </DisplayRow>
      {mixed && !pending && <div className="dm-note">{ownOrderNote(projectSortCount)}</div>}
      {mixed && pending && (
        <div className="dm-confirm" role="group" aria-label="Replace project orders">
          <span className="dm-confirm-text">{replaceOrdersQuestion(pending, projectSortCount)}</span>
          <button type="button" className="dm-text-btn" onClick={() => settle(pending, true)}>Replace</button>
          <button type="button" className="dm-text-btn" onClick={() => settle(pending, false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
