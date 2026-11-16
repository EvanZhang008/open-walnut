/**
 * How a drawing covers the window and how its dialog closes, without remounting the editor.
 *
 * Full screen is CSS, not the browser's Fullscreen API (the Mac app's web view has none to give):
 * the workspace's own box becomes `position: fixed; inset: 0` (drawing-workspace.css), so the
 * editor inside keeps its zoom, scroll, selection and undo history. A fixed box is placed by the
 * window only while no ancestor makes a containing block for it (transform, filter,
 * backdrop-filter, contain, ...: utils/clip-ancestors.ts names them), and is cut by an ancestor's
 * clip-path (a plugin App's box, styles/plugin-bounds.css) or covered by a sibling of an ancestor
 * that stacks above it. `liftFixedAncestors` turns those off on the ancestors, inline, for as long
 * as the drawing is full screen, and puts back exactly what was there.
 *
 * The composer's dialog closes on a click outside it only when the pointer went down AND came up
 * outside (`OutsidePress`): a stroke drawn from the canvas that ends outside, or a text selection
 * dragged out, never closes it.
 */
import { clipFacts, type ClipStyle } from '@/utils/clip-ancestors';

/** Above the page and its sheets (9000 to 9290), under the composer's dialog (10020) and menus over it. */
export const FULLSCREEN_Z = 9295;

/** Ctrl/Cmd+Shift+F toggles full screen. */
export function isFullscreenShortcut(e: { key: string; code?: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return e.shiftKey && !e.altKey && (e.ctrlKey || e.metaKey) && (e.code === 'KeyF' || e.key.toLowerCase() === 'f');
}

type StyleOf = (el: Element) => ClipStyle & { zIndex?: string; isolation?: string };

interface Saved { el: HTMLElement; prop: string; value: string; priority: string }

/** The properties that make a containing block or a clip, and the value that turns each off. */
const NEUTRAL: Array<[string, string, (cs: ReturnType<StyleOf>) => boolean]> = [
  ['transform', 'none', (cs) => !!cs.transform && cs.transform !== 'none'],
  ['perspective', 'none', (cs) => !!cs.perspective && cs.perspective !== 'none'],
  ['filter', 'none', (cs) => !!cs.filter && cs.filter !== 'none'],
  ['backdrop-filter', 'none', (cs) => !!cs.backdropFilter && cs.backdropFilter !== 'none'],
  ['-webkit-backdrop-filter', 'none', (cs) => !!cs.backdropFilter && cs.backdropFilter !== 'none'],
  ['contain', 'none', (cs) => !!cs.contain && cs.contain !== 'none'],
  ['will-change', 'auto', (cs) => !!cs.willChange && cs.willChange !== 'auto'],
  ['container-type', 'normal', (cs) => !!cs.containerType && cs.containerType !== 'normal'],
  ['content-visibility', 'visible', (cs) => cs.contentVisibility === 'auto' || cs.contentVisibility === 'hidden'],
  ['clip-path', 'none', (cs) => !!cs.clipPath && cs.clipPath !== 'none'],
  ['mask', 'none', (cs) => !!cs.mask && cs.mask !== 'none'],
];

/**
 * Make `el` (position: fixed) cover the window: every ancestor that would hold it in a box of its
 * own, cut it, or stack under a sibling gets the neutral value inline. Returns the undo.
 */
export function liftFixedAncestors(el: HTMLElement, styleOf: StyleOf = (e) => getComputedStyle(e) as unknown as ReturnType<StyleOf>): () => void {
  const saved: Saved[] = [];
  const set = (target: HTMLElement, prop: string, value: string) => {
    saved.push({ el: target, prop, value: target.style.getPropertyValue(prop), priority: target.style.getPropertyPriority?.(prop) ?? '' });
    target.style.setProperty(prop, value, 'important');
  };
  for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const cs = styleOf(a);
    const facts = clipFacts(cs);
    if (facts.block || facts.path) for (const [prop, value, on] of NEUTRAL) if (on(cs)) set(a, prop, value);
    // A stacking ancestor under a sibling (the sidebar, a header) would paint over the drawing.
    if (cs.isolation === 'isolate') set(a, 'isolation', 'auto');
    const z = cs.zIndex && cs.zIndex !== 'auto' ? Number(cs.zIndex) : null;
    if (z !== null && cs.position !== 'static' && z < FULLSCREEN_Z) set(a, 'z-index', String(FULLSCREEN_Z));
  }
  return () => {
    for (const s of saved.reverse()) {
      if (s.value) s.el.style.setProperty(s.prop, s.value, s.priority);
      else s.el.style.removeProperty(s.prop);
    }
  };
}

/**
 * A press outside a dialog: `down` and `up` take whether each end of the press was outside;
 * `closes()` is true only for a press that began and ended there.
 */
export class OutsidePress {
  private downOutside = false;
  down(outside: boolean): void { this.downOutside = outside; }
  /** True when this press closes the dialog; the press is used up either way. */
  up(outside: boolean): boolean {
    const closes = this.downOutside && outside;
    this.downOutside = false;
    return closes;
  }
  cancel(): void { this.downOutside = false; }
}
