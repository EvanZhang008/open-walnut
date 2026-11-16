/**
 * The real component widens in the browser's top layer. A content-free spacer holds its
 * original box in the list: neither its height nor any neighbouring row moves. Keeping the
 * same DOM node also keeps React handlers, focus and drag sensors on the actual controls.
 */
export const OPEN_ATTR = 'data-peek-open';
export const FIT_ATTR = 'data-peek-fit';
export const BLOCK_ATTR = 'data-peek-block';
export const EXPANDED_ATTR = 'data-peek-expanded';
export type RowMarks = Array<[Element, string]> & { restore?: () => void; placeholder?: HTMLElement };

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

/** Opens the entire row sideways, with its exact original height. */
export function expandRow(row: Element, hosts: HTMLElement[], animate = true): RowMarks {
  const marks: RowMarks = [];
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
  const saved: Array<[HTMLElement, string, string, string]> = [];
  const set = (el: HTMLElement, name: string, value: string) => {
    saved.push([el, name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]);
    el.style.setProperty(name, value);
  };
  const mark = (el: Element, attr: string) => {
    if (el.hasAttribute(attr)) return;
    el.setAttribute(attr, '');
    marks.push([el, attr]);
  };
  // The anchor algorithm must not interpret the temporary extra shell as newly inserted
  // content. Hold anchoring while the list's boxes stay identical, without moving its scroll.
  for (let el = row.parentElement; el && el !== document.body; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') { set(el, 'overflow-anchor', 'none'); break; }
  }
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
    for (const [el, name, value, priority] of saved) {
      if (value) el.style.setProperty(name, value, priority);
      else el.style.removeProperty(name);
    }
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
  for (const [el, attr] of marks) el.removeAttribute(attr);
  marks.length = 0;
}
