/**
 * What a throwaway server calls itself in words a person reads. A developer's test server
 * (`bun run dev:ephemeral`) is "this test server"; the Walnut Demo runs on the same
 * isolation (an ephemeral child), but a new user trying the Demo has never heard of a test
 * server (2026-11-10 review: "inherited_session: this test server did not start session …").
 * A normal install never reaches these sentences at all.
 *
 * Every user-facing sentence that would say "test server" goes through here, or is listed
 * with why only a developer reads it: tests/core/server-self-name-guard.test.ts.
 */
import { IS_DEMO } from '../constants.js'

/** "this Demo" in the Demo, "this test server" on a developer's test server. */
export function thisServer(demo: boolean = IS_DEMO): string {
  return demo ? 'this Demo' : 'this test server'
}

/** Sentence-initial form of thisServer. */
export function ThisServer(demo: boolean = IS_DEMO): string {
  const s = thisServer(demo)
  return s[0].toUpperCase() + s.slice(1)
}

