/**
 * Where Home shows the welcome card (FirstUseSetup) while first-use setup is needed: the ONE rule,
 * so the card is on screen whatever the user opens or closes (2026-11-11 review, F4: the rail's
 * "Ask Walnut" toggle closed the Ask slot the card lived in and left an empty white page; pressing
 * it again brought the card back).
 *
 *   slot   the Ask slot is open: the card leads it, as before.
 *   tasks  the slot is closed and the task panel shows: the card sits at the top of the panel.
 *   null   no setup needed, or neither place is on screen (a draft column owns the page then, and
 *          its own launch says what is missing).
 *
 * Pure. Unit-tested in tests/web/home-first-use-card.test.ts.
 */
export type FirstUseCardPlace = 'slot' | 'tasks' | null;

export function firstUseCardPlace(needsSetup: boolean, chatVisible: boolean, taskPanelShown: boolean): FirstUseCardPlace {
  if (!needsSetup) return null;
  if (chatVisible) return 'slot';
  return taskPanelShown ? 'tasks' : null;
}
