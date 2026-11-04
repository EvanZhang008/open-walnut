/**
 * How Home's session columns move (auto-animate on `.main-page-sessions-area`, MainPage).
 *
 * A column that opens is whole in its first frame, and one that closes is gone in the next:
 * only a column that stays where it was sized before slides (a lock or unlock reorder), and
 * it slides by transform alone. auto-animate's own defaults did the opposite (2026-11-04, the
 * user: "I click new task the quick action etc show really slow ... it should instantly show,
 * no delay"): a new column was held at opacity 0 for the first half of 480 ms and faded in over
 * the second, so the New task draft's cards and composer were in the DOM in a frame and on screen
 * half a second later; and every other column animated its WIDTH, which lays the whole page out
 * again on every frame of the slide (90 ms a frame in WebKit with four chat columns open).
 *
 * Ratchet: tests/web/session-columns-motion.test.ts.
 */
import type { AutoAnimationPlugin } from '@formkit/auto-animate';

/** The reorder slide: long enough to read as a move, iOS "standard" easing. */
export const COLUMN_SLIDE_MS = 320;
export const COLUMN_SLIDE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

interface Box { top: number; left: number; width: number; height: number }

/** An effect that does nothing and ends at once: auto-animate still gets its `finish`. */
function none(el: Element): KeyframeEffect {
  return new KeyframeEffect(el, [], { duration: 0 });
}

/**
 * The keyframes for one column, or null for "no motion". Pure, so the rule is tested without a
 * browser. A column whose size changed (a column opened or closed beside it) snaps: a slide of a
 * column at its new width would also cover the one that just opened while it moves.
 */
export function columnKeyframes(action: 'add' | 'remove' | 'remain', isColumn: boolean, before?: Box, after?: Box): Keyframe[] | null {
  // Only a column slides: a resize handle between two columns sits where its index puts it.
  if (action !== 'remain' || !isColumn || !before || !after) return null;
  if (Math.round(before.width) !== Math.round(after.width) || Math.round(before.height) !== Math.round(after.height)) return null;
  const dx = Math.round(before.left - after.left);
  const dy = Math.round(before.top - after.top);
  if (!dx && !dy) return null;
  return [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }];
}

export const columnMotion: AutoAnimationPlugin = (el, action, first, second) => {
  // auto-animate calls a plugin's "remain" with the OLD box first and the new one second
  // (index.mjs remain(): pluginOrOptions(el, "remain", oldCoords, newCoords)), whatever its
  // declared parameter names say.
  const frames = columnKeyframes(action, el.classList.contains('main-page-session-column'), first, second);
  // No motion: an effect that ends at once. A removal keeps auto-animate's own handling around it
  // (the node lifted out of the flow, absolutely placed, until the effect's finish removes it), so
  // the columns around it lay out as if it were already gone; and it is hidden meanwhile, so no
  // paint (a forced one included) ever shows it over the columns that took its room. auto-animate
  // only calls "remove" for a node that left the document, which React never puts back.
  if (!frames) {
    if (action === 'remove' && el instanceof HTMLElement) el.style.visibility = 'hidden';
    return none(el);
  }
  return new KeyframeEffect(el, frames, { duration: COLUMN_SLIDE_MS, easing: COLUMN_SLIDE_EASING });
};
