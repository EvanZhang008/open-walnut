/**
 * The one rail item that peeks: a pill laid exactly over its row (same icon, same spot)
 * that grows out over the page with the item's name. It is a copy of the row's own
 * content, so every kind of entry (an app, a Home toggle, a status ring, the bell with its
 * count) shows as itself.
 *
 * Events: the part over the row lets every event through to the row, so the row keeps
 * everything it does natively (a quick press the pill appeared under, Cmd-click, a middle
 * click, a drag, its tooltip, the wheel). Only the part past the row (the name) takes
 * events, and hands a click (with its modifier keys) or a right-click to the row.
 *
 * Portalled to <body> (the rail scrolls and clips), but rendered inside the rail's React
 * tree, so moving from a row onto the name is not a leave of the rail. It follows its row:
 * a scroll, a resize or a change inside the rail (a badge count, a ticking ring) measures
 * and copies again; a row that went away takes the pill with it.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '@/styles/sidebar-peek.css';

// Marks that only decorate the row; the icon is the row's first other child.
const NON_ICON = '.sidebar-label, .notification-badge-dot, .notification-badge-count, .sidebar-host-dot, .quiet-moon';

interface Placement {
  left: number; top: number; width: number; height: number; inset: number;
  iconW: number; iconH: number; fontSize: string; tone: string;
}

function measure(row: HTMLElement): Placement {
  const box = row.getBoundingClientRect();
  const icon = [...row.children].find((child) => !child.matches(NON_ICON));
  const iconBox = icon?.getBoundingClientRect();
  const style = getComputedStyle(row);
  return {
    left: box.left, top: box.top, width: box.width, height: box.height,
    inset: iconBox ? iconBox.left - box.left : 10,
    iconW: iconBox?.width ?? 18, iconH: iconBox?.height ?? 18,
    // Home's toggles are a size smaller; a status ring takes its colour from its row.
    fontSize: style.fontSize, tone: style.getPropertyValue('--status-tone').trim(),
  };
}

const samePlace = (a: Placement | null, b: Placement) =>
  !!a && (Object.keys(b) as (keyof Placement)[]).every((k) => a[k] === b[k]);

/** The row's content, without anything that names it twice (ids, test ids, tooltips). */
function copyOf(row: HTMLElement, place: Placement): DocumentFragment {
  const out = document.createDocumentFragment();
  let iconDone = false;
  for (const child of [...row.children]) {
    const copy = child.cloneNode(true) as HTMLElement | SVGElement;
    for (const el of [copy, ...copy.querySelectorAll('*')]) {
      el.removeAttribute('id');
      el.removeAttribute('data-testid');
      el.removeAttribute('title');
    }
    // The rail colours by its own selectors (the active row, a warning label); the copy
    // lives outside the rail, so it takes the colour the row shows.
    copy.style.color = getComputedStyle(child).color;
    if (!iconDone && !child.matches(NON_ICON)) {
      iconDone = true;
      // Same for size: 16px under Home, 22px rings.
      copy.style.width = `${place.iconW}px`;
      copy.style.height = `${place.iconH}px`;
      copy.style.flexShrink = '0';
      copy.classList.add('rail-item-pill-icon');
    }
    out.appendChild(copy);
  }
  return out;
}

function handOn(type: string, e: React.MouseEvent): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true, cancelable: true, view: window, detail: e.detail,
    clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
    button: e.button, buttons: e.buttons,
    ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey,
  });
}

export function RailItemPill({ item, grow, handlers, onGone }: {
  item: HTMLElement;
  grow: boolean;
  handlers: { ref: React.RefObject<HTMLElement | null>; onPointerMove: (e: React.PointerEvent<HTMLElement>) => void };
  /** The row left the rail (it unmounted), or the wheel turned on the name. */
  onGone: (why: 'gone' | 'wheel') => void;
}) {
  const [place, setPlace] = useState<Placement | null>(null);
  // Bumped on every new copy, so what render reads off the row (active, tooltip) is fresh too.
  const [, setCopies] = useState(0);
  // The grow plays once: a copy made later (a ticking ring, a new count) must not replay the name's entrance.
  const [growing, setGrowing] = useState(grow);
  useLayoutEffect(() => { setGrowing(grow); }, [item, grow]);
  const body = useRef<HTMLSpanElement | null>(null);
  const copied = useRef('');
  const goneRef = useRef(onGone);
  goneRef.current = onGone;

  const refresh = useCallback(() => {
    if (!item.isConnected) { goneRef.current('gone'); return; }
    const next = measure(item);
    setPlace((prev) => (samePlace(prev, next) ? prev : next));
    // Copy again only when the row changed (its content, its class, its tooltip).
    const html = `${item.className}\n${item.title}\n${item.innerHTML}`;
    if (body.current && (html !== copied.current || !body.current.firstChild)) {
      copied.current = html;
      body.current.replaceChildren(copyOf(item, next));
      setCopies((n) => n + 1);
    }
  }, [item]);

  useLayoutEffect(() => { copied.current = ''; refresh(); }, [refresh]);
  // The body mounts with the first placement; fill it on that commit.
  useLayoutEffect(() => { if (place && body.current && !body.current.firstChild) refresh(); }, [place, refresh]);

  useLayoutEffect(() => {
    const rail = item.closest('aside');
    let frame = 0;
    const soon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; refresh(); }); };
    const watch = new MutationObserver(soon);
    if (rail) watch.observe(rail, { subtree: true, childList: true, attributes: true, characterData: true });
    rail?.addEventListener('scroll', soon, true);
    window.addEventListener('resize', soon);
    return () => {
      watch.disconnect();
      rail?.removeEventListener('scroll', soon, true);
      window.removeEventListener('resize', soon);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [item, refresh]);

  if (!place) return null;
  const active = item.classList.contains('active');
  return createPortal(
    <div
      ref={handlers.ref as React.RefObject<HTMLDivElement>}
      className={`rail-item-pill${active ? ' is-active' : ''}`}
      data-grow={growing || undefined}
      onAnimationEnd={(e) => { if (e.animationName === 'rail-pill-label-in') setGrowing(false); }}
      aria-hidden="true"
      data-testid="rail-item-pill"
      style={{
        left: place.left, top: place.top, height: place.height, minWidth: place.width,
        paddingLeft: place.inset, fontSize: place.fontSize,
        ['--rail-pill-from' as string]: `${place.width}px`,
        ...(place.tone ? { ['--status-tone' as string]: place.tone } : {}),
      }}
    >
      <span ref={body} className="rail-item-pill-body" />
      {/* The name's half, past the row: the only part that takes events. */}
      <span
        className="rail-item-pill-reach"
        data-testid="rail-item-pill-reach"
        style={{ left: place.width }}
        title={item.title || undefined}
        onPointerMove={handlers.onPointerMove}
        // The grow's clip opens under a pointer that already stopped there: that sends an enter, no move.
        onPointerEnter={handlers.onPointerMove}
        onClick={(e) => { item.dispatchEvent(handOn('click', e)); }}
        onContextMenu={(e) => {
          // The row's own menu (an app's) takes the right-click; a row without one keeps the browser's.
          if (!item.dispatchEvent(handOn('contextmenu', e))) e.preventDefault();
        }}
        onWheel={() => { goneRef.current('wheel'); }}
      />
    </div>,
    document.body,
  );
}
