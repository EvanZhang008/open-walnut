/**
 * selection-hold — ask a timeline's quote pill to outlive the document selection.
 *
 * Moving focus into the composer collapses the page's selection (both engines,
 * measured 2026-09-10), and the pill offering Copy / Pin / Ask on the selected
 * passage used to vanish with it. The one place that moves focus on purpose while
 * a passage may be selected — dictated text landing in the composer — sends this
 * request FIRST, and the pill answers by keeping the passage it already captured,
 * painting it from the side (CSS highlight), and staying up until the user acts on
 * it or moves on.
 *
 * Why a request, and not an inferred anchor. From 2026-09-10 to 09-16 the landing
 * turned any visible selection into the composer's thread anchor. A reader who had
 * dragged over one word while reading, then dictated a question about something
 * else, got an "asking about" chip nobody asked for — and sent as-is, the turn would
 * have been filed under that reply with the word quoted above it. A selection is
 * not a request; the pill's Ask button is. Holding the pill keeps the passage
 * reachable and leaves the asking to the user.
 *
 * Events rather than a ref threaded through three components: the pill already
 * works off document-level listeners, and the panel knows only its own root. Both
 * events are dispatched on the PANEL root and bubble; the pill listens at the
 * document and answers when the event's target contains its timeline, so no class
 * path has to name the timeline from outside, and a second panel's pill stays out
 * of it.
 */
export const SELECTION_HOLD_EVENT = 'walnut:selection-hold';
export const SELECTION_RELEASE_EVENT = 'walnut:selection-release';

export interface SelectionHoldDetail {
  /** Set by the pill: true when it had a passage to hold and is now holding it. */
  held: boolean;
}

/** Ask the pill inside this panel to hold its passage. Synchronous: the answer is
 *  read back from the event detail once dispatch returns. */
export function requestSelectionHold(panel: HTMLElement | null | undefined): boolean {
  if (!panel || typeof CustomEvent === 'undefined') return false;
  const detail: SelectionHoldDetail = { held: false };
  panel.dispatchEvent(new CustomEvent<SelectionHoldDetail>(SELECTION_HOLD_EVENT, { detail, bubbles: true }));
  return detail.held;
}

/** The user acted (sent a message): a held passage has served its purpose. */
export function releaseSelectionHold(panel: HTMLElement | null | undefined): void {
  if (!panel || typeof CustomEvent === 'undefined') return;
  panel.dispatchEvent(new CustomEvent(SELECTION_RELEASE_EVENT, { bubbles: true }));
}
