/**
 * The header-fit check: finds every header row on the page (a title and buttons laid out in one
 * horizontal flex row) and says where one breaks the shared header rule
 * (web/src/hooks/useHeaderFit.ts, styles/header-fit.css):
 * - `overlap`: two of its parts (the title, a button, a group of buttons) cover each other;
 * - `spill`: a part runs past the header's own box (cut off by the column, or under the next pane);
 * - `title`: the title is narrower than it needs to stay readable (its own text, or
 *   HEADER_TITLE_MIN_PX, whichever is less), so it reads as one clipped letter; or it cuts its
 *   text while a subtitle beside it (`[data-fit-sub]`) still shows, which must give way first;
 * - `more`: the More button shows while nothing is put away into it (`data-fit-overflow`).
 *
 * The members are found on the live page, never from a list, so a header added tomorrow is
 * checked by the same sweep (header-fit-sweep.spec.ts). `findHeaderProblems` runs in the page
 * (page.evaluate) and so takes nothing from this module's scope.
 */

export interface HeaderProblem {
  kind: 'overlap' | 'spill' | 'title' | 'more';
  /** The header's own selector-like name: tag plus its first class. */
  header: string;
  detail: string;
}

/** The narrowest a title may get while it still reads (about 6 characters of a 15 px title). */
export const HEADER_TITLE_MIN_PX = 48;

export function findHeaderProblems(minTitlePx: number): HeaderProblem[] {
  const TOL = 1;
  const problems: HeaderProblem[] = [];
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const nameOf = (el: Element): string => {
    const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)[0];
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
  };
  const isControl = (el: Element): boolean => el.matches('button, [role="button"], a.btn, select, input');
  const holdsControl = (el: Element): boolean => isControl(el) || !!el.querySelector('button, [role="button"], a.btn');
  // A heading may hold its own rename button (the Org name); any other title holds no control.
  const isTitle = (el: Element): boolean => (el.textContent ?? '').trim().length > 0 && (
    el.hasAttribute('data-fit-title') || /^H[1-6]$/.test(el.tagName)
    || (!holdsControl(el) && /(^|[-_ ])(title|name|heading|label)([-_ ]|$)/i.test(el.getAttribute('class') ?? '')));
  // The width the title's text takes when laid out on one line (its range, never its box).
  const textWidth = (el: Element): number => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    let px = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { r.selectNodeContents(n); px += r.getBoundingClientRect().width; }
    return px;
  };
  // A title may sit one level down (a heading inside a wrapper, beside the wrapper's own buttons).
  const titleIn = (el: Element): Element | null => {
    if (isTitle(el)) return el;
    if (holdsControl(el) && !el.querySelector('h1, h2, h3, h4, h5, h6, [data-fit-title]')) return null;
    for (const c of el.children) if (isTitle(c) && c.getClientRects().length > 0) return c;
    return null;
  };
  // Parts inside a clipped, scrolled or hidden region are not on screen as laid out.
  const inViewport = (r: DOMRect) => r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
  const candidates = document.querySelectorAll('header, [data-fit-header], [class*="-head"], [class*="-bar"], [class*="toolbar"], [class*="title-row"], [class*="meta-row"], [class*="tool-row"]');
  for (const head of candidates) {
    if (!shown(head)) continue;
    if (head.closest('[data-fit-header-skip]')) continue;
    const cs = getComputedStyle(head);
    if (!cs.display.includes('flex') || cs.flexDirection.startsWith('column')) continue;
    const box = head.getBoundingClientRect();
    if (!inViewport(box)) continue;
    // A title squeezed to 0 px is still a part (that is the bug this finds): laid out, not hidden.
    const laidOut = (c: Element) => c.getClientRects().length > 0 && getComputedStyle(c).visibility !== 'hidden';
    const parts = [...head.children].filter((c) => laidOut(c) && getComputedStyle(c).position !== 'absolute' && getComputedStyle(c).position !== 'fixed');
    if (parts.length < 2) continue;
    let title: Element | null = null;
    let titlePart: Element | null = null;
    for (const p of parts) { title = titleIn(p); if (title) { titlePart = p; break; } }
    const controls = parts.filter((p) => p !== titlePart && holdsControl(p)).length;
    // A row of buttons with no title (a session's tool row) is checked for covering, spilling and
    // cut buttons; a row with a title also for the title's width.
    if (controls === 0 || (!title && controls < 2)) continue;
    // A title faded out on purpose (a collapsed sidebar's label) is not shown, so not squeezed.
    if (title && Number(getComputedStyle(title).opacity) < 0.05) title = null;
    const name = nameOf(head);
    // A group of buttons that clips its own buttons (a chip cut under the next group). A subtitle
    // or any part that ends in an ellipsis gives way by design.
    for (const p of parts) {
      if (p === titlePart || !holdsControl(p) || p.hasAttribute('data-fit-sub')) continue;
      const pcs = getComputedStyle(p);
      if (pcs.textOverflow === 'ellipsis' || pcs.overflowX === 'visible') continue;
      if (p.scrollWidth > p.clientWidth + TOL) problems.push({ kind: 'spill', header: name, detail: `${nameOf(p)} cuts ${p.scrollWidth - p.clientWidth}px of its own buttons` });
    }
    // A header that wraps its parts onto a second line is fine; only covering or spilling is not.
    const rects = parts.map((p) => ({ p, r: p.getBoundingClientRect() }));
    for (const { p, r } of rects) {
      if (r.left < box.left - TOL || r.right > box.right + TOL) {
        problems.push({ kind: 'spill', header: name, detail: `${nameOf(p)} spans ${Math.round(r.left)}..${Math.round(r.right)}, header ${Math.round(box.left)}..${Math.round(box.right)}` });
      }
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > TOL && h > TOL) problems.push({ kind: 'overlap', header: name, detail: `${nameOf(rects[i].p)} and ${nameOf(rects[j].p)} overlap by ${Math.round(w)}px` });
    }
    // The More button only while the buttons are put away into it.
    for (const more of head.querySelectorAll('[data-fit-more]')) {
      if (shown(more) && head.closest('[data-toolbar-fold]')?.getAttribute('data-fit-overflow') !== 'true') {
        problems.push({ kind: 'more', header: name, detail: 'More shows while no button is put away into it' });
      }
    }
    if (!title) continue;
    // A subtitle gives way before the title loses any of its text.
    const sub = head.querySelector(':scope > [data-fit-sub]');
    if (sub && sub.getBoundingClientRect().width >= 1 && title.scrollWidth > title.clientWidth) {
      problems.push({ kind: 'title', header: name, detail: `${nameOf(title)} cuts its text while ${nameOf(sub)} still shows` });
    }
    // The title's text: its own box, and the text it holds (which may run out of an unclipped box).
    const tr = title.getBoundingClientRect();
    const textPx = textWidth(title);
    const needPx = Math.min(minTitlePx, textPx);
    if (tr.width + TOL < needPx) problems.push({ kind: 'title', header: name, detail: `${nameOf(title)} is ${Math.round(tr.width)}px, needs ${Math.round(needPx)}px ("${(title.textContent ?? '').trim().slice(0, 30)}")` });
    const tcs = getComputedStyle(title);
    if (title.scrollWidth > title.clientWidth + TOL && tcs.overflowX === 'visible') {
      problems.push({ kind: 'overlap', header: name, detail: `${nameOf(title)} text runs ${title.scrollWidth - title.clientWidth}px out of its box` });
    }
  }
  return problems;
}
