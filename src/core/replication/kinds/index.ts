/**
 * The WP4 copy kinds (docs/plan/walnut-replica-servers-impl.md, section 4):
 * sessions, requests, boards, inbox (index and bodies), and the WP5 ones:
 * routines, conversations, prefs, config. One list for the
 * leader's scheduler (copy-kind.ts) and one registration for the follower
 * route (web/routes/bridge-replica.ts builtinKinds).
 */

import { keepsCopies } from './gate.js'
import { registerFollowerKind, type FollowerKindHandler } from '../kind-follower.js'
import { startCopyKindsSync, type CopyKind, type CopyKindsDeps } from './copy-kind.js'
import { BOARDS_KIND, boardsFollower } from './boards.js'
import { INBOX_BODIES_KIND, INBOX_KIND, inboxBodiesFollower, inboxFollower } from './inbox.js'
import { REQUESTS_KIND, requestsFollower } from './requests.js'
import { SESSIONS_KIND, sessionsFollower } from './sessions.js'
// WP5: routines, conversations, prefs and favorites, the allowlisted config.
import { ROUTINES_KIND } from './routines.js'
import { routinesFollower } from './routines-follower.js'
import { CONVERSATIONS_KIND } from './conversations.js'
import { conversationsFollower } from './conversations-follower.js'
import { PREFS_KIND, prefsFollower } from './prefs.js'
import { CONFIG_KIND, configFollower } from './config.js'
// WP12: the Ask personas, so a new ask starts on the host while the Mac is away.
import { PERSONAS_KIND, personasFollower } from './personas.js'

/** The leader's copy kinds, in the order a round serves them. */
export function copyKinds(): CopyKind<any>[] {
  return [SESSIONS_KIND, REQUESTS_KIND, BOARDS_KIND, INBOX_KIND, INBOX_BODIES_KIND,
    ROUTINES_KIND, CONVERSATIONS_KIND, PREFS_KIND, CONFIG_KIND, PERSONAS_KIND]
}

/**
 * Only a server that keeps the kind's copy takes its steps (gate.ts keepsCopies:
 * the replica program on a host, every kind; the companion, its kinds).
 * Anywhere else (the leader, the plain host server that never opted in, the
 * companion for a kind it does not keep) a step answers exactly what an
 * unregistered kind did before WP4, whatever its op or schema version:
 * `404 unknown_kind`, which rests that kind for this target on the Mac.
 */
export function copyKeepersOnly(h: FollowerKindHandler): FollowerKindHandler {
  return {
    kind: h.kind,
    // followerStep checks the version before the step: never `schema_newer` where the kind is not kept.
    get schemaVersion() { return keepsCopies(h.kind) ? h.schemaVersion : Number.MAX_SAFE_INTEGER },
    step: (op, body) => (keepsCopies(h.kind) ? h.step(op, body) : { ok: false, status: 404, error: 'unknown_kind' }),
  }
}

/** The follower side of every copy kind, for POST /bridge/replica. Returns the unregister. */
export function registerCopyFollowerKinds(): () => void {
  const off = [sessionsFollower(), requestsFollower(), boardsFollower(), inboxFollower(), inboxBodiesFollower(),
    routinesFollower(), conversationsFollower(), prefsFollower(), configFollower(), personasFollower()].map((h) => registerFollowerKind(copyKeepersOnly(h)))
  return () => { for (const u of off) u() }
}

/** Leader only (a follower starts nothing): the copy kinds' rounds to every target that keeps them. */
export function startCopyKinds(deps?: CopyKindsDeps): { stop: () => void } {
  return startCopyKindsSync(copyKinds(), deps)
}
