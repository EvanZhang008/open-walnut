/**
 * One option row of the session pickers (the model picker's Provider, Model and Effort columns,
 * the permission-mode menu): a Picked row (standard.md, "Choice controls"). The current value is
 * `aria-selected` on a `wn-pick-row`, which the shared stylesheet (pick-and-nav.css) shows as the
 * name in --accent-text; no check mark, no fill, and no colour or weight of the picker's own.
 *
 * A browse list (the Provider column, whose rows choose which models the next column lists) keeps
 * the listbox meaning of `aria-selected`: the row being browsed, drawn with the quiet highlight
 * fill. The row that holds the current value says so with `aria-current="true"`, the picked colour.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import '@/styles/pick-and-nav.css';

type BaseProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role' | 'type' | 'aria-selected' | 'aria-current'> & {
  children: ReactNode;
};

type RowProps = BaseProps & (
  /** This row holds the current value: aria-selected, the shared picked colour. */
  | { picked: boolean; browsed?: never; current?: never }
  /** A browse list's row: `browsed` is aria-selected (the highlight fill), `current` is
   *  aria-current (the picked colour). */
  | { picked?: never; browsed: boolean; current: boolean }
);

export function PickerRow({ picked, browsed, current, className, children, ...rest }: RowProps) {
  const browse = browsed !== undefined;
  return (
    <button
      type="button"
      role="option"
      aria-selected={browse ? browsed : picked}
      aria-current={browse && current ? 'true' : undefined}
      data-pick={browse ? 'browse' : 'true'}
      data-active={browse && browsed ? 'true' : undefined}
      className={`model-picker-row wn-pick-row${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  );
}
