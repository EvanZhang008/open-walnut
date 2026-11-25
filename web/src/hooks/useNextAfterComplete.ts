import { createUiFlag } from './ui-flag';

/**
 * `ui.next_after_complete`: completing a task from its session column (or with mod+shift+D)
 * goes on to the next task that needs the person (pages/useColumnCompleteClose.ts). Default ON.
 * One app-wide value (ui-flag.ts).
 */
const flag = createUiFlag({ key: 'next_after_complete', storageKey: 'walnut:next-after-complete', fallback: true });

/** The value now, for a handler that runs outside render. */
export const nextAfterCompleteNow = flag.now;

export const useNextAfterComplete = flag.use;

export const setNextAfterComplete = flag.set;
