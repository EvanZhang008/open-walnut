/**
 * `1 update` / `N updates` at the top of the home list (spec 4.5, C61): the
 * reorders useStableOrder held back while the thumb was on the list or a layer
 * was open. A tap applies them and goes to the top; so does coming to rest at
 * the top of the list. 44 px tall, floating just under the search row.
 */
import { useQueuedUpdates, updatesLabel } from './useStableOrder';
import { homeListScroller } from './phone-row-behavior';

export function PhoneQueuedUpdatesPill() {
  const { pending, apply } = useQueuedUpdates();
  if (pending <= 0) return null;
  return (
    <button
      type="button"
      className="phone-updates-pill"
      data-testid="phone-updates-pill"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        apply();
        homeListScroller()?.scrollTo({ top: 0, behavior: 'smooth' });
      }}
    >
      {updatesLabel(pending)}
    </button>
  );
}
