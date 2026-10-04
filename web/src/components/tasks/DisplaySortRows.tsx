/**
 * The Display menu's setting rows (spec 3.3, 6.5): segmented pickers with a
 * roving tabindex (Left/Right move AND pick, Home/End jump), the Sort row with
 * its inline "replace every project's own order" confirm (gap G12), the tab bar
 * switch, and the plain choice rows (Group, Session columns). Presentational;
 * DisplaySections.tsx wires them to its props.
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SortBy } from './ViewDropdown';

export interface SegChoice<K extends string> {
  key: K;
  label: string;
  title?: string;
  /** Extra `data-view-option` on the segment. */
  option?: string;
}

/** A segmented pick. `value` null = mixed: no segment pressed, the first one takes Tab. */
export function Segmented<K extends string>({ label, choices, value, onPick }: {
  label: string;
  choices: readonly SegChoice<K>[];
  value: K | null;
  onPick(key: K): void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const tabIndexAt = Math.max(0, choices.findIndex((c) => c.key === value));
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = choices.length;
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % n;
    else if (e.key === 'ArrowLeft') next = (i - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onPick(choices[next].key);
  };
  return (
    <span className="tp-seg dm-seg" role="group" aria-label={label}>
      {choices.map((c, i) => (
        <button
          key={c.key}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          className="tp-seg-btn dm-seg-btn"
          data-choice={c.key}
          data-view-option={c.option}
          aria-pressed={c.key === value}
          tabIndex={i === tabIndexAt ? 0 : -1}
          title={c.title}
          onClick={() => onPick(c.key)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >{c.label}</button>
      ))}
    </span>
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

/** The tab bar switch: the whole row is the switch (role="switch"), no native checkbox. */
export function SwitchRow({ option, label, title, checked, onChange }: {
  option: string;
  label: string;
  title: string;
  checked: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="dm-row dm-switch-row"
      data-view-option={option}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span className="dm-row-label">{label}</span>
      <span className="dm-switch-track" aria-hidden="true" />
    </button>
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
