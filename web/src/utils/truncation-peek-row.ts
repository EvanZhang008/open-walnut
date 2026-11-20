/**
 * The real component widens in the browser's top layer. A content-free spacer holds its
 * original box in the list: neither its height nor any neighbouring row moves. Keeping the
 * same DOM node also keeps React handlers, focus and drag sensors on the actual controls.
 *
 * A card a person types into (an ask card with its reply box) never widens: over the chat
 * beside its list it hid the box and its buttons (2026-11-20, the user: "when it expand whole
 * button is gone"). Its cut-off texts open where they are instead (`openDown`): the card keeps
 * its width and grows downward in its own column, at most half its height again (the user:
 * "the max its like 1.5 time long"); what does not fit scrolls inside the text.
 */
import '@/styles/truncation-peek-down.css';

export const OPEN_ATTR = 'data-peek-open';
export const FIT_ATTR = 'data-peek-fit';
export const BLOCK_ATTR = 'data-peek-block';
export const EXPANDED_ATTR = 'data-peek-expanded';
/** A cut-off text opened in place, in a card that grows downward. */
export const DOWN_ATTR = 'data-peek-down';
/** An opened card is at most this much taller than closed (1.5 times its height). */
export const DOWN_MAX_GROWTH = 0.5;
export type RowMarks = Array<[Element, string]> & { restore?: () => void; placeholder?: HTMLElement; down?: boolean };

/** Something a person types into. A checkbox or a button input is a row's control, not a field. */
const TYPED_FIELD = 'textarea, [contenteditable="true"], [contenteditable=""], input:not([type="checkbox"], [type="radio"], [type="hidden"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"], [type="image"])';

/**
 * Whether `row` opens downward in its own column instead of widening across the window: it is
 * marked `data-peek-grow="down"`, or it holds a field of its own (not one of a row nested in it).
 */
export function growsDown(row: Element): boolean {
  if (row.matches('[data-peek-grow="down"]')) return true;
  for (const field of Array.from(row.querySelectorAll(TYPED_FIELD))) {
    const owner = field.parentElement?.closest('[data-peek-row]');
    if (!owner || owner === row || !row.contains(owner)) return true;
  }
  return false;
}

/** Whether the point is inside the component's current, possibly widened box. */
export function within(el: Element, p: { x: number; y: number }): boolean {
  const r = el.getBoundingClientRect();
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

function backgroundOf(row: Element): string {
  const layers: string[] = [];
  let base = 'var(--bg)';
  for (let el: Element | null = row; el; el = el.parentElement) {
    const color = getComputedStyle(el).backgroundColor;
    if (color.startsWith('rgb(')) { base = color; break; }
    if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') layers.push(`linear-gradient(${color}, ${color})`);
  }
  // A translucent hover tint still needs its original opaque surface behind it, not the
  // neighbouring pane's text. CSS composites the ancestor paints from nearest to farthest.
  return [...layers, base].join(', ');
}

/** The scroller the row's list scrolls in: its anchoring held while the row opens. */
function holdAnchor(row: Element, set: (el: HTMLElement, name: string, value: string) => void): void {
  // The anchor algorithm must not interpret the temporary extra shell as newly inserted
  // content. Hold anchoring while the list's boxes stay identical, without moving its scroll.
  for (let el = row.parentElement; el && el !== document.body; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') { set(el, 'overflow-anchor', 'none'); break; }
  }
}

function styleSaver() {
  const saved: Array<[HTMLElement, string, string, string]> = [];
  const set = (el: HTMLElement, name: string, value: string) => {
    saved.push([el, name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]);
    el.style.setProperty(name, value);
  };
  const restore = () => {
    for (const [el, name, value, priority] of saved.reverse()) {
      if (value) el.style.setProperty(name, value, priority);
      else el.style.removeProperty(name);
    }
  };
  return { set, restore };
}

/**
 * Opens the cut-off texts of a card that grows downward, in place: no top layer, no placeholder,
 * the card's width unchanged. Each text wraps in full; together they add at most
 * DOWN_MAX_GROWTH of the card's closed height, shared so a short text opens whole and a long
 * one scrolls inside itself.
 */
function openDown(row: HTMLElement, hosts: HTMLElement[], marks: RowMarks): RowMarks {
  const height = row.getBoundingClientRect().height;
  if (!height) return marks;
  const closed = hosts.map((h) => h.getBoundingClientRect().height);
  const style = styleSaver();
  holdAnchor(row, style.set);
  for (const host of hosts) {
    if (getComputedStyle(host).display === '-webkit-box') { host.setAttribute(BLOCK_ATTR, ''); marks.push([host, BLOCK_ATTR]); }
    host.setAttribute(DOWN_ATTR, '');
    marks.push([host, DOWN_ATTR]);
  }
  row.setAttribute(EXPANDED_ATTR, '');
  marks.push([row, EXPANDED_ATTR]);
  marks.down = true;
  marks.restore = style.restore;
  // Water-fill the budget: the texts that need least open whole, the rest share what is left.
  const growth = hosts.map((h, i) => Math.max(0, h.getBoundingClientRect().height - closed[i]));
  let budget = Math.floor(height * DOWN_MAX_GROWTH);
  const order = hosts.map((_, i) => i).sort((a, b) => growth[a] - growth[b]);
  for (const [n, i] of order.entries()) {
    const share = Math.floor(budget / (order.length - n));
    const given = Math.min(growth[i], share);
    budget -= given;
    if (given < growth[i]) style.set(hosts[i], '--peek-down-max', `${Math.floor(closed[i] + given)}px`);
  }
  return marks;
}

/** Opens the entire row sideways, with its exact original height (a card with a field: downward). */
export function expandRow(row: Element, hosts: HTMLElement[], animate = true): RowMarks {
  const marks: RowMarks = [];
  if (row instanceof HTMLElement && !row.hasAttribute('popover') && growsDown(row)) return openDown(row, hosts, marks);
  // Do not replace an application-owned popover or interfere with an active editor.
  if (!(row instanceof HTMLElement) || typeof row.showPopover !== 'function' || row.hasAttribute('popover')) return marks;
  const rect = row.getBoundingClientRect();
  if (!rect.width || !rect.height) return marks;
  // getComputedStyle is live: inserting a spacer changes :first-child/:last-child rules.
  // Snapshot before touching the list, including every text's original height.
  const computed = getComputedStyle(row);
  // Everything that places the row among its neighbours: the placeholder has no class of its own.
  const heldProps = ['display', 'flex', 'align-self', 'justify-self', 'grid-area', 'order', 'float', 'vertical-align',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left'];
  // A row taken out of the flow keeps its placeholder out of it too, at the same place.
  if (computed.position === 'absolute' || computed.position === 'fixed') heldProps.push('position', 'top', 'right', 'bottom', 'left');
  const held = heldProps.map(prop => [prop, computed.getPropertyValue(prop)] as const);
  const cs = { display: computed.display, border: computed.border, padding: computed.padding };
  const hostHeights = hosts.map(host => host.getBoundingClientRect().height);
  const background = backgroundOf(row);
  const { set, restore: restoreStyles } = styleSaver();
  const mark = (el: Element, attr: string) => {
    if (el.hasAttribute(attr)) return;
    el.setAttribute(attr, '');
    marks.push([el, attr]);
  };
  holdAnchor(row, set);
  // A bare element of the row's tag (a list item stays a list item): no class, id, role, text or
  // controls copied, so no selector written for the row (`.mail-row`, `[data-task-id]`, a role)
  // ever finds its placeholder. Its box comes only from the values held above.
  const placeholder = document.createElement(row.localName);
  placeholder.setAttribute('data-peek-placeholder', '');
  placeholder.setAttribute('aria-hidden', 'true');
  placeholder.inert = true;
  for (const [prop, value] of held) placeholder.style.setProperty(prop, value, 'important');
  placeholder.style.setProperty('box-sizing', 'border-box', 'important');
  placeholder.style.setProperty('width', `${rect.width}px`, 'important');
  placeholder.style.setProperty('height', `${rect.height}px`, 'important');
  placeholder.style.setProperty('min-height', `${rect.height}px`, 'important');
  placeholder.style.setProperty('max-height', `${rect.height}px`, 'important');
  placeholder.style.setProperty('min-width', `${rect.width}px`, 'important');
  placeholder.style.setProperty('max-width', `${rect.width}px`, 'important');
  row.before(placeholder);
  marks.placeholder = placeholder;

  set(row, '--peek-height', `${rect.height}px`);
  set(row, '--peek-top', `${rect.top}px`);
  set(row, '--peek-left', `${rect.left}px`);
  set(row, '--peek-width', `${rect.width}px`);
  set(row, '--peek-background', background);
  set(row, '--peek-display', cs.display);
  set(row, '--peek-border', cs.border);
  set(row, '--peek-padding', cs.padding);
  for (const [index, host] of hosts.entries()) {
    set(host, '--peek-text-height', `${hostHeights[index]}px`);
    mark(host, OPEN_ATTR);
    if (getComputedStyle(host).display === '-webkit-box') mark(host, BLOCK_ATTR);
    for (let el: HTMLElement | null = host; el && el !== row && row.contains(el); el = el.parentElement) {
      if (getComputedStyle(el).maxWidth !== 'none') mark(el, FIT_ATTR);
    }
  }
  mark(row, EXPANDED_ATTR);
  row.setAttribute('popover', 'manual');
  marks.restore = () => {
    if (row.matches(':popover-open')) row.hidePopover();
    row.removeAttribute('popover');
    placeholder.remove();
    restoreStyles();
  };
  try {
    row.showPopover();
    const available = Math.max(1, window.innerWidth - 16);
    let width = Math.min(rect.width + 48, available);
    // Measure the real uncapped text, including several titles in one metadata line.
    // Stop at the viewport: an exceptionally long line stays ellipsized, never wraps.
    for (let pass = 0; pass < 8; pass++) {
      row.style.setProperty('--peek-width', `${width}px`);
      const missing = hosts.reduce((sum, host) => sum + Math.max(0, host.scrollWidth - host.clientWidth), 0);
      const extra = Math.max(missing, row.scrollWidth - row.clientWidth);
      if (extra <= 1 || width >= available) break;
      width = Math.min(available, width + extra + 16);
    }
    const preferredLeft = rect.left + width <= window.innerWidth - 8 ? rect.left : rect.right - width;
    const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - 8 - width));
    row.style.setProperty('--peek-width', `${width}px`);
    row.style.setProperty('--peek-left', `${left}px`);
    // Reveal only sideways. The final box is already measured, so no frame changes height.
    const startLeft = Math.max(0, rect.left - left);
    const startRight = Math.max(0, width - startLeft - rect.width);
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const reveal = row.animate([
        { clipPath: `inset(0 ${startRight}px 0 ${startLeft}px)` },
        { clipPath: 'inset(0 0 0 0)' },
      ], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
      const restore = marks.restore;
      marks.restore = () => { reveal.cancel(); restore?.(); };
    }
  } catch {
    collapseRow(marks);
  }
  return marks;
}

/** Removing the top-layer box restores the row without scroll compensation or layout shift. */
export function collapseRow(marks: RowMarks): void {
  marks.restore?.();
  marks.restore = undefined;
  marks.placeholder = undefined;
  marks.down = undefined;
  for (const [el, attr] of marks) el.removeAttribute(attr);
  marks.length = 0;
}
