/**
 * Whose words a message hint is (2026-11-01, the user: "it should be clear which is
 * built in which is user defined"):
 *   - a built-in hint's text is Walnut's, the same in every Walnut;
 *   - a custom hint (Settings, Add a hint) is all the user's own.
 * No built-in carries a setting of the user's (the reply-language correction was the one
 * that did, removed 2026-11-20); `tests/core/hints/hint-origin.test.ts` fails when one
 * starts to.
 */

/** Every hint kind the registry defines (hint-registry.ts BUILT_IN), in its order. */
export const BUILT_IN_HINT_KINDS = ['question', 'rich-output', 'voice-reply', 'object-context', 'user-away', 'brief', 'threads', 'threads-tidy', 'hand-on', 'team-guidance'] as const;

/**
 * Walnut text that rides a message outside the registry (no switch in Settings). `reply-language`
 * was a built-in hint (the reply language until 2026-11-06, then its correction after a drift until
 * 2026-11-20, the user: remove this reminder): old rows still carry it, an old config's override of it
 * is ignored, and no custom hint may take its name.
 */
export const WALNUT_ONLY_KINDS = ['session-context', 'engine-switch', 'images', 'status-question-cut', 'reply-language'] as const;
