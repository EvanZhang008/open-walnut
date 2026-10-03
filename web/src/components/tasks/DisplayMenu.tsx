/**
 * DisplayMenu: the task panel toolbar's ONE button (sliders, "Display", the
 * active-filter count as a badge) and, while open, the panel menu (spec 3.3,
 * 6.5). The menu shell, the search box and the paging live in FilterMenu.tsx
 * (PanelMenu); the display rows live in DisplaySections.tsx.
 *
 * Open state is the filter controller's (`menuOpen`): the F shortcut, the
 * board's "Filter to this project", the row's "View: Pinned" item and the
 * strip's "Adjust panels" hint all open the same menu.
 */
import { useEffect, useRef, useState } from 'react';
import { ICON_SLIDERS } from '../common/Icons';
import '@/styles/filter-toolbar-base.css';
import '@/styles/display-menu.css';
import type { DisplayMenuProps, FilterBarController } from './filter-bar-types';
import { VIEW_DROPDOWN_REVEAL_EVENT, VIEW_OPTION_FLASH_MS, whenSettled, type ViewDropdownRevealDetail } from './view-dropdown-reveal';
import { PanelMenu } from './FilterMenu';
import { badgeText } from './filter-home-model';

export { TAB_BAR_SWITCH_TITLE, VIEW_ROW_TITLE } from './DisplaySections';

export function displayButtonTitle(viewTitleHint: string | null, activeFilters: number): string {
  const filters = activeFilters > 0 ? `${activeFilters} active filter${activeFilters === 1 ? '' : 's'}, ` : '';
  const view = viewTitleHint ? `view ${viewTitleHint}, ` : '';
  return `Display: ${filters}${view}sort, group, layout`;
}

export interface DisplayButtonProps extends DisplayMenuProps {
  filters: FilterBarController;
}

/** The sliders button (6.5) plus, while open, the menu. */
export function DisplayButton(props: DisplayButtonProps) {
  const { open, onOpenChange, buttonRef, viewTitleHint, filters } = props;
  // "Show me that control" (view-dropdown-reveal.ts): the strip's lock-grant hint
  // opens this menu on its Session columns row and pulses it. The open waits for
  // the button to hold still: the task panel may be sliding open at that moment.
  const [flashOption, setFlashOption] = useState<string | null>(null);
  const openRef = useRef(onOpenChange);
  openRef.current = onOpenChange;
  useEffect(() => {
    let cancel: (() => void) | null = null;
    const handler = (e: Event) => {
      const option = (e as CustomEvent<ViewDropdownRevealDetail>).detail?.option;
      const el = buttonRef.current;
      if (!option || !el) return;
      cancel?.();
      cancel = whenSettled(el, () => {
        cancel = null;
        setFlashOption(option);
        openRef.current(true);
      });
    };
    window.addEventListener(VIEW_DROPDOWN_REVEAL_EVENT, handler);
    return () => { cancel?.(); window.removeEventListener(VIEW_DROPDOWN_REVEAL_EVENT, handler); };
  }, [buttonRef]);
  useEffect(() => {
    if (!open) { setFlashOption(null); return; }
    if (!flashOption) return;
    const t = setTimeout(() => setFlashOption(null), VIEW_OPTION_FLASH_MS);
    return () => clearTimeout(t);
  }, [open, flashOption]);
  const n = filters.chips.length;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`tp-btn dm-display-btn${n > 0 ? ' is-active' : ''}`}
        // Explicit tab stop: WebKit skips plain buttons on Tab (F09).
        tabIndex={0}
        aria-label="Display"
        title={displayButtonTitle(viewTitleHint, n)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        {ICON_SLIDERS}
        <span className="tp-btn-label">Display</span>
        {n > 0 && <span className="tp-badge" data-testid="filter-badge">{badgeText(n)}</span>}
      </button>
      {open && <PanelMenu filters={filters} display={props} flashOption={flashOption} />}
    </>
  );
}

