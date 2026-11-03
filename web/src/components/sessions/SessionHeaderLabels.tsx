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
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import '@/styles/session-header-labels.css';

/** A body child that only announces (a toast region), never a card or menu over the list. */
export const LIVE_REGION = '[role="status"], [role="alert"], [role="log"], [aria-live]';

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

const textOf = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

const TAG_ICON = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.75 2.75v4.6l6.9 6.9 5.6-5.6-6.9-6.9h-4.6a1 1 0 0 0-1 1z" />
    <circle cx="5" cy="5" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export function SessionHeaderLabels({ children }: { children: ReactNode }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
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

  useEffect(() => {
    if (!open) return;
    // A tag's own card (its hover card, a picker) is portalled to <body> after this
    // opened: a click there belongs to it, not outside.
    // A live region (a toast's status line) mounting there meanwhile is no layer of this
    // list: counted as one, it swallowed every Escape for as long as it stayed.
    const before = new Set(Array.from(document.body.children));
    const isChildPortal = (el: Element) => el.parentElement === document.body && !before.has(el)
      && !el.matches(LIVE_REGION);
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || buttonRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      let top: Element | null = t;
      while (top && top.parentElement && top.parentElement !== document.body) top = top.parentElement;
      if (top && isChildPortal(top)) return;
      setOpen(false);
    };
    // Escape closes one layer at a time: a tag's own card first (it listens too), then
    // the list, and nothing else (a full-screen panel stays full screen).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const childOpen = Array.from(document.body.children).some((el) => isChildPortal(el) && el.getClientRects().length > 0);
      if (childOpen) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    // Capture phase: the state pills beside it stop their own pointerdown, so a press on
    // one would never reach a bubbling listener and both flyouts would stay open.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const { count, text } = labels;
  return (
    <>
      {count > 0 && (
        <button
          ref={buttonRef}
          type="button"
          className={`session-header-labels-btn${open ? ' is-open' : ''}`}
          data-testid="session-header-labels"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`Tags (${count}): ${text}`}
          title={text}
          // No pointerdown stop here: another flyout still open must hear this press to close.
          onClick={(e) => {
            e.stopPropagation();
            // From the keyboard (no pointer, detail 0) the focus moves into the list.
            keyboardOpen.current = e.detail === 0;
            setOpen((o) => !o);
          }}
        >
          {TAG_ICON}
          <span className="session-header-labels-count">{count}</span>
        </button>
      )}
      {createPortal(
        <div
          ref={menuRef}
          className="session-header-labels-flyout"
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
