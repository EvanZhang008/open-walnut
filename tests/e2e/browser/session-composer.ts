/**
 * A session's own composer, found by its place in the panel, never by its placeholder.
 *
 * The placeholder says the session's state, so it changes under a spec: "New reply above, not
 * read yet" while the session holds an unread reply (3437e252c4, 2026-11-22), "Message" on a
 * phone, a thread's own words while the composer targets a thread, empty otherwise since
 * 6f4a477964 (2026-11-23). A spec that found the box by
 * "Send a message to this session" lost it the moment the agent's reply arrived unread (nightly
 * 45035328727: agent-text-paths.spec.ts pressed a composer that no longer matched).
 * tests/scripts/session-composer-locator-guard.test.ts keeps every spec on this helper.
 */
import type { Locator, Page } from '@playwright/test'

/** The panel's main composer box: never Tree Mode's left half (`.tree-split-input`) or the plan popup's. */
const BOX = '.session-panel-input:not(.tree-split-input) textarea.chat-input-textarea'

/**
 * The composer of the session panel `scope`, or, given a page, of every session panel on it
 * except a plain chat's (the browser side panel's Ask, whose box is no session composer).
 */
export function sessionComposer(scope: Page | Locator): Locator {
  return 'goto' in scope ? scope.locator(`.session-panel:not(.is-plain-chat) ${BOX}`) : scope.locator(BOX)
}
