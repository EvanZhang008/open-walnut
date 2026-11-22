/**
 * The header rule: a header row that holds a title and buttons never lets the buttons press on
 * the title (2026-11-21, the user on the Org list, its title squeezed to one clipped letter by
 * "New router", "Org chart" and the gear: "ui is shit now what the fuck?").
 *
 * As the header narrows, in this order:
 *   1. its buttons fold to their icons (each `[data-fit-button]`, its words in `[data-fit-label]`);
 *   2. they go into one "More" menu (`HeaderFitMore`), each a row of it by its own name;
 *   3. only then does the title cut its text, with the full text on hover.
 * A subtitle beside the title (`[data-fit-sub]`) gives way before any of them.
 * The title stays whole (up to HEADER_TITLE_WHOLE_PX of it) through 1 and 2.
 *
 * One loop decides it for every header and every toolbar (attachFold in hooks/useToolbarFit.ts),
 * driven by the header's own width, never the window's: panes are resized on their own.
 * A header opts in with `data-fit-header` on its row, `data-fit-title` on its title (and
 * `data-fit-sub` on a subtitle), and, when it has buttons that can fold, `useHeaderFit` on the
 * row with the shared buttons (`FitButton`) and a `HeaderFitMore`. A row whose only controls
 * are fixed icons needs the attributes alone (header-fit.css).
 * tests/web/header-fit-ratchet.test.ts fails on a new header row that does not;
 * tests/e2e/browser/header-fit-sweep.spec.ts sweeps the widths on the page.
 */
import { useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { attachFold } from '@/hooks/useToolbarFit';
import { ContextMenu } from './ContextMenu';
import { ICON_MORE } from './Icons';
import '@/styles/toolbar-fit.css';
import '@/styles/header-fit.css';

/** A title up to this wide stays whole while any button can still make room; a longer one
 *  keeps at least this much before the buttons have all folded away (about 20 characters). */
export const HEADER_TITLE_WHOLE_PX = 160;
/** The narrowest a title may ever read (about 6 characters): the page sweep's floor. */
export const HEADER_TITLE_MIN_PX = 48;

/** The width a title's text takes on one line: its text runs, never its (flexed) box or padding. */
function textWidth(el: HTMLElement): number {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let px = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    range.selectNodeContents(n);
    px += range.getBoundingClientRect().width;
  }
  return px;
}

/**
 * How wide the title could be now: its box, the row's free room, and what a `[data-fit-sub]`
 * (a subtitle, which gives way first) holds. Margins are left out: an auto margin (a right-hand
 * group pushed to the end) is free room, and the few fixed ones sit inside the hysteresis.
 */
function titleRoom(row: HTMLElement, title: HTMLElement): number {
  const cs = getComputedStyle(row);
  let used = 0;
  let parts = 0;
  let sub = 0;
  for (const child of row.children) {
    const el = child as HTMLElement;
    if (!el.getClientRects().length) continue;
    const pos = getComputedStyle(el).position;
    if (pos === 'absolute' || pos === 'fixed') continue;
    const w = el.getBoundingClientRect().width;
    used += w;
    if (el.hasAttribute('data-fit-sub')) sub += w;
    parts++;
  }
  const inner = row.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const free = inner - used - (parseFloat(cs.columnGap) || 0) * Math.max(0, parts - 1);
  return title.getBoundingClientRect().width + free + sub;
}

/**
 * Keeps a header's title whole: returns a callback ref for the row. `minPx` is how much of a
 * long title stays before the buttons have all folded (all of a shorter one).
 */
export function useHeaderFit({ minPx = HEADER_TITLE_WHOLE_PX, enabled = true }: { minPx?: number; enabled?: boolean } = {}) {
  const [row, setRow] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!row || !enabled) return;
    const stop = attachFold(row, {
      keepSelector: '[data-fit-title]',
      // Folds while the title's own box is short of its text; unfolds on the row's room.
      measure: (title) => ({
        roomPx: titleRoom(row, title),
        fieldPx: title.getBoundingClientRect().width,
        // Any loss at all already shows the ellipsis, so a short title folds the buttons before it loses a pixel.
        minPx: Math.min(minPx, textWidth(title) - 0.02),
        reservePx: 0,
      }),
    });
    return stop;
  }, [row, minPx, enabled]);
  return setRow;
}

type FitButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: ReactNode;
  /** Its words, shown while there is room; its name in the More menu and on hover after. */
  label: string;
  /** The fold step it loses its words at (1 first). */
  step?: 1 | 2 | 3;
  /** Never goes into the More menu (a button whose own popover is anchored to it). */
  keep?: boolean;
  /** Always just its icon; its name shows on hover (`title`) and to a screen reader. */
  iconOnly?: boolean;
};

/** A header's button, the family's quiet tool (`.btn.btn-sm.btn-ghost`, styles/buttons.css): icon, then its
 *  words; `iconOnly`, the family's icon key (`.btn.btn-icon`). */
export function FitButton({ icon, label, step = 1, keep, iconOnly, className = '', title, ...rest }: FitButtonProps) {
  return (
    <button
      type="button"
      className={`btn ${iconOnly ? 'btn-icon' : 'btn-sm btn-ghost'} ${className}`.trim()}
      data-fit-button={step}
      data-fit-keep={keep ? '' : undefined}
      aria-label={label}
      title={title ?? label}
      {...rest}
    >
      <span className="header-fit-icon" aria-hidden="true">{icon}</span>
      {!iconOnly && <span data-fit-label>{label}</span>}
    </button>
  );
}

interface MoreItem { el: HTMLButtonElement; name: string; disabled: boolean }

/** The buttons the header put away, in row order, each by the name it carries. */
function hiddenItems(row: HTMLElement | null): MoreItem[] {
  if (!row) return [];
  return [...row.querySelectorAll<HTMLButtonElement>('[data-fit-button]:not([data-fit-keep])')].map((el) => ({
    el,
    name: el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent ?? '').trim(),
    disabled: el.disabled,
  }));
}

/**
 * The header's "More" menu: shown only while the header has put its buttons away
 * (`data-fit-overflow`, header-fit.css). Each row clicks the real button, which stays mounted,
 * so there is no second copy of a handler or a name to drift. The menu is the shared ContextMenu
 * opened from a button (`anchorRef`): its placement, keys and Escape, focus back on More.
 */
export function HeaderFitMore({ testId }: { testId?: string }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [opened, setOpened] = useState<{ items: MoreItem[]; keyboard: boolean } | null>(null);
  const swallow = useRef(false);
  const close = useLeanCallback((why?: 'anchor') => { if (why === 'anchor') swallow.current = true; setOpened(null); }, []);
  const open = (keyboard: boolean) => {
    const row = buttonRef.current?.closest<HTMLElement>('[data-toolbar-fold]') ?? null;
    setOpened({ items: hiddenItems(row), keyboard });
  };
  const rect = buttonRef.current?.getBoundingClientRect();
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-icon"
        data-fit-more=""
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={opened !== null}
        aria-label="More"
        title="More"
        onClick={(e) => {
          e.stopPropagation();
          if (swallow.current) { swallow.current = false; return; }
          if (opened) setOpened(null); else open(e.detail === 0);
        }}
      >
        <span className="header-fit-icon" aria-hidden="true">{ICON_MORE}</span>
      </button>
      {opened && rect && (
        <ContextMenu
          point={{ x: rect.right, y: rect.bottom }}
          anchorRef={buttonRef}
          align="right"
          returnFocus={buttonRef.current}
          highlightFirst={opened.keyboard}
          ariaLabel="More"
          className="header-fit-more-menu"
          items={opened.items.map((it, i) => ({
            key: `${i}-${it.name}`,
            label: it.name,
            disabled: it.disabled,
            // Focus goes back to More first, so a dialog the action opens returns focus there.
            onSelect: () => { buttonRef.current?.focus(); it.el.click(); },
          }))}
          onClose={close}
        />
      )}
    </>
  );
}
