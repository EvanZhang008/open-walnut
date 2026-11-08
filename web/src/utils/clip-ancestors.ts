/**
 * Which ancestors clip an element: the one rule every "visible box of this element" measure in
 * the app goes through (toolbar-bounds, the notes bubble menu, thread live lines, page find,
 * plugin bounds, the truncation peek).
 *
 * An ancestor's overflow clips a descendant only when the descendant's containing block chain
 * passes through it. A `position: fixed` element escapes every overflow above it up to an
 * ancestor that makes a containing block for fixed boxes (transform, filter, contain, ...), and a
 * `position: absolute` one escapes every unpositioned ancestor that makes none. 2026-11-10 review:
 * a full-screen Files sheet (`position: fixed`) sits inside the old one-column panel's
 * `overflow: hidden`, and counting that column clamped the Ask here / Quote toolbar into it.
 * A clip-path or mask clips everything painted inside it, fixed boxes included.
 */

/** The parts of a computed style the rule reads (a CSSStyleDeclaration has them all). */
export interface ClipStyle {
  position: string;
  overflowX: string;
  overflowY: string;
  transform: string;
  perspective: string;
  filter: string;
  backdropFilter?: string;
  contain: string;
  willChange: string;
  containerType?: string;
  contentVisibility?: string;
  clipPath?: string;
  mask?: string;
}

interface Facts {
  position: string;
  /** Makes a containing block for fixed and absolute descendants. */
  block: boolean;
  /** Its overflow (or paint containment) clips each axis of what it contains. */
  x: boolean;
  y: boolean;
  /** A clip-path or mask: clips every descendant, both axes. */
  path: boolean;
}

/** Per-pass cache of style facts (a measure that walks many chains reads each element once). */
export type ClipFactsCache = Map<Element, Facts>;

export interface ClipAncestor { el: Element; x: boolean; y: boolean }

const set = (v: string | undefined) => !!v && v !== 'none';

export function clipFacts(cs: ClipStyle): Facts {
  const paint = /\b(paint|strict|content)\b/.test(cs.contain) || cs.contentVisibility === 'auto';
  const block = set(cs.transform) || set(cs.perspective) || set(cs.filter) || set(cs.backdropFilter)
    || /\b(layout|paint|strict|content)\b/.test(cs.contain)
    || /\b(transform|perspective|filter|backdrop-filter|contain)\b/.test(cs.willChange)
    || (!!cs.containerType && cs.containerType !== 'normal')
    || cs.contentVisibility === 'auto';
  return {
    position: cs.position,
    block,
    x: paint || cs.overflowX !== 'visible',
    y: paint || cs.overflowY !== 'visible',
    path: set(cs.clipPath) || set(cs.mask),
  };
}

export interface ClipAncestorsOptions {
  /** Judge the start element too: its own overflow clips the content inside it. */
  self?: boolean;
  /** Stop before this ancestor (exclusive); the document element always ends the walk. */
  stop?: Node | null;
  cache?: ClipFactsCache;
  /** The style reader (tests pass a stand-in); defaults to the element's own window. */
  styleOf?: (el: Element) => ClipStyle;
}

/** The ancestors that clip `node`, innermost first, with the axes each one clips. */
export function clippingAncestors(node: Node | null, opts: ClipAncestorsOptions = {}): ClipAncestor[] {
  const out: ClipAncestor[] = [];
  if (!node) return out;
  const start = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (!start) return out;
  const root = start.ownerDocument?.documentElement ?? null;
  const read = opts.styleOf ?? ((el: Element) => (el.ownerDocument.defaultView ?? window).getComputedStyle(el));
  const facts = (el: Element): Facts => {
    let f = opts.cache?.get(el);
    if (!f) { f = clipFacts(read(el)); opts.cache?.set(el, f); }
    return f;
  };
  // How the subtree judged so far is positioned: decides which ancestors clip it.
  let mode = 'static';
  // A text node's parent holds it in flow, so the parent is judged like any ancestor.
  let el: Element | null = start;
  if (start === node) {
    const own = facts(start);
    if (opts.self && start !== root && start !== opts.stop && (own.x || own.y || own.path)) {
      out.push({ el: start, x: own.x || own.path, y: own.y || own.path });
    }
    mode = own.position;
    el = start.parentElement;
  }
  for (; el && el !== root && el !== opts.stop; el = el.parentElement) {
    const f = facts(el);
    const holds = mode === 'fixed' ? f.block
      : mode === 'absolute' ? f.block || f.position !== 'static'
        : true;
    const x = (holds && f.x) || f.path;
    const y = (holds && f.y) || f.path;
    if (x || y) out.push({ el, x, y });
    // Once it holds the subtree, the ancestors above judge this one's own box.
    if (holds) mode = f.position === 'fixed' || f.position === 'absolute' ? f.position : 'static';
  }
  return out;
}
