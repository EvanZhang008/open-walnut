import { createUiFlag } from './ui-flag';

/**
 * `ui.show_walnut_additions`: whether the session chat always shows what Walnut
 * added to a message (its notes in front of the words, the context it prepended;
 * never its message hints, which no chat draws since 2026-11-01). Default ON (2026-10-31, the user: "the user can see these
 * is better"); turned off, each message's footer has a "Walnut added" control that
 * shows them for that one message. One app-wide value read by every chat row (ui-flag.ts).
 */
const flag = createUiFlag({ key: 'show_walnut_additions', storageKey: 'walnut:show-walnut-additions', fallback: true });

/** Whether the chat always shows what Walnut added. */
export const useShowWalnutAdditions = flag.use;

/** Flip the flag: local echo to every mounted row first, then persist into the `ui` block. */
export const setShowWalnutAdditions = flag.set;
