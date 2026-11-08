/**
 * The file view's question gutter (`data-file-rail`) changes how its text wraps, so it must
 * never go and come back within a moment: each flip reflows a long file, and at the file's
 * end the scroller clamps and the passage the reader asked about slides away (2026-11-09:
 * the first question of a fresh Walnut moved line 396 down 250px on send, because the
 * draft's rail row went before the tree read the question back and the layer mounted again).
 *
 * A layer holds the mark while it has questions; when it lets go the mark stays for a short
 * grace, so a layer that mounts again or reads its question back in that time keeps it.
 * Another file in the same view drops it at once (its own questions, if any, set it again).
 */
export const RAIL_GUTTER_GRACE_MS = 1500;

interface MarkedView { setAttribute(name: string, value: string): void; removeAttribute(name: string): void }

const pending = new WeakMap<MarkedView, { timer: ReturnType<typeof setTimeout>; path: string }>();

/** Mark the view for this file's questions; a release still pending is called off. */
export function holdRailGutter(view: MarkedView, attr: string): void {
  const p = pending.get(view);
  if (p) { clearTimeout(p.timer); pending.delete(view); }
  view.setAttribute(attr, '');
}

/** Let the mark go after the grace, unless held again before then. */
export function releaseRailGutter(view: MarkedView, attr: string, path: string): void {
  const p = pending.get(view);
  if (p) clearTimeout(p.timer);
  pending.set(view, {
    path,
    timer: setTimeout(() => { pending.delete(view); view.removeAttribute(attr); }, RAIL_GUTTER_GRACE_MS),
  });
}

/** The view shows another file: a release pending for the last one happens now. */
export function railGutterFileShown(view: MarkedView, attr: string, path: string): void {
  const p = pending.get(view);
  if (!p || p.path === path) return;
  clearTimeout(p.timer);
  pending.delete(view);
  view.removeAttribute(attr);
}
