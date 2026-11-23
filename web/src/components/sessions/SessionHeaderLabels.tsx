/**
 * The session header's link tags (threads, docs, CRs and the other tags of its task)
 * folded behind ONE small control beside the title: a tag icon and how many there are.
 * A click opens them all in a flyout, each pill as it is everywhere else, so every one
 * still opens what it opens.
 *
 * 2026-11-02, the user: "the tag still noisy, all collapse, user can click, and because
 * it is collapsed so have more room to have good name". 2026-11-03, the user: "only tag
 * go there, other should still outside, like trigger ... leader ... worker": the state
 * pills (the wait, Cron, Trigger, Worker, Leader) stay on the row (SessionPanel
 * headerPills). The run status (Running, Idle) is in the task detail, not the header.
 *
 * The tags stay mounted while the flyout is closed (a hidden portal), so the count reads
 * the tags that actually render and opening it fetches nothing; with no tag there is no
 * control. Guard: tests/web/session-header-labels-guard.test.ts.
 *
 * `inMenu`: a host that keeps its header line quiet (the Org node, 2026-11-23, the user: "just
 * move all these to the drop done") draws no control here; its menu's Tags row opens the same
 * list under the menu's key (`handle`), and `onCount` tells that row how many tags there are.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import '@/styles/session-header-labels.css';

/** How many tags the list shows: each pill of the tag group (anything else counts as one). */
export function countLabels(list: Element): { count: number; text: string } {
  const names: string[] = [];
  for (const child of Array.from(list.children)) {
    if (child.classList.contains('task-tag-pills')) {
      for (const tag of Array.from(child.children)) names.push(textOf(tag));
    } else if (child.childElementCount > 0 || textOf(child)) {
      names.push(textOf(child));
    }
  }
  return { count: names.length, text: names.filter(Boolean).join(' · ') };
}

/** "1 tag", "3 tags": what the header's bare count counts (2026-11-21 words audit). */
const tagsWord = (n: number) => `${n} ${n === 1 ? 'tag' : 'tags'}`;

const textOf = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

export const TAG_ICON = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.75 2.75v4.6l6.9 6.9 5.6-5.6-6.9-6.9h-4.6a1 1 0 0 0-1 1z" />
    <circle cx="5" cy="5" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

/** Opens the folded list from somewhere else (a menu row); `fromKeyboard` moves the focus into it. */
export interface LabelsOpener { open: (fromKeyboard: boolean) => void }

export interface LabelsInMenu {
  /** The key the list opens under (the menu's own). */
  anchor: () => HTMLElement | null;
  handle: MutableRefObject<LabelsOpener | null>;
  onCount: (count: number) => void;
}

export function SessionHeaderLabels({ children, inMenu }: { children: ReactNode; inMenu?: LabelsInMenu }) {
  // What the list opens under: this control's own button, or the menu's key (inMenu).
  const buttonRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState({ count: 0, text: '' });
  const placement = useMenuPlacement(open, buttonRef, menuRef, {
    align: 'right', preferSide: 'down', minHeight: 80, onAnchorLost: () => setOpen(false),
  });

  // The count follows the pills: a trigger armed, a tag added, a wait ended.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const read = () => setLabels((prev) => {
      const next = countLabels(list);
      return prev.count === next.count && prev.text === next.text ? prev : next;
    });
    read();
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(read);
    mo.observe(list, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);

  useEffect(() => { if (labels.count === 0) setOpen(false); }, [labels.count]);

  // Opened from the keyboard, the first label takes the focus: the list is a portal at the
  // end of <body>, which Tab from the button would never reach.
  const keyboardOpen = useRef(false);
  useEffect(() => {
    if (!open || !keyboardOpen.current) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Folded into a menu: its row hears the count, and opens the list under the menu's key.
  const onCount = inMenu?.onCount;
  useEffect(() => { onCount?.(labels.count); }, [onCount, labels.count]);
  const handle = inMenu?.handle;
  const anchor = inMenu?.anchor;
  useEffect(() => {
    if (!handle || !anchor) return;
    handle.current = {
      open: (fromKeyboard) => {
        buttonRef.current = anchor();
        keyboardOpen.current = fromKeyboard;
        setOpen(true);
      },
    };
    return () => { handle.current = null; };
  }, [handle, anchor]);

  // A tag that takes the user somewhere (a link opens its page or file) closes the list.
  const closeAfterLeave = useCallback((e: MouseEvent) => {
    if ((e.target as Element).closest('.tag-chip-linked')) {
      // A keyboard user (no pointer, detail 0) keeps their place: the focus goes back to the
      // control, not to <body>. A mouse click leaves the focus to what the tag opened.
      const fromKeyboard = e.detail === 0;
      setTimeout(() => {
        const focusInside = !!menuRef.current?.contains(document.activeElement);
        setOpen(false);
        if (fromKeyboard && focusInside) buttonRef.current?.focus();
      }, 0);
    }
  }, []);

  const folded = !!inMenu;
  // Escape and an outside press close the list through the overlay stack. A tag's own card
  // (its hover card, a change card) is a layer opened after this one, so it is on top: the
  // first Escape closes the card, the next one the list, and a press inside the card stays
  // the card's. A toast's status line on <body> is no layer, so it never takes the key.
  // The stack listens in the capture phase, so a press on a state pill beside the control
  // (each stops its own pointerdown) still closes the list.
  useOverlayLayer({
    open,
    refs: folded ? [menuRef] : [menuRef, buttonRef],
    passOutsideClick: true,
    onClose: (reason) => {
      setOpen(false);
      if (reason === 'escape' && !folded) buttonRef.current?.focus();
    },
  });

  const { count, text } = labels;
  return (
    <>
      {count > 0 && !folded && (
        <button
          ref={(el) => { buttonRef.current = el; }}
          type="button"
          className="btn btn-sm btn-ghost session-header-labels-btn"
          data-testid="session-header-labels"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Show ${tagsWord(count)}: ${text}`}
          title={`${tagsWord(count)}: ${text}`}
          // No pointerdown stop here: another flyout still open must hear this press to close.
          onClick={(e) => {
            e.stopPropagation();
            // From the keyboard (no pointer, detail 0) the focus moves into the list.
            keyboardOpen.current = e.detail === 0;
            setOpen((o) => !o);
          }}
        >
          {TAG_ICON}
          {/* The count says what it counts on screen too, not only on hover (2026-11-22 words audit). */}
          <span className="session-header-labels-count">{count}</span>{count === 1 ? ' tag' : ' tags'}
        </button>
      )}
      {createPortal(
        <div
          ref={menuRef}
          className="session-header-labels-flyout wn-overlay"
          role="dialog"
          aria-label="Tags"
          hidden={!open}
          style={open ? menuPlacementStyle(placement) : undefined}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          data-testid="session-header-labels-flyout"
        >
          <div className="session-header-labels-list" ref={listRef} onClickCapture={closeAfterLeave}>{children}</div>
        </div>,
        document.body,
      )}
    </>
  );
}
