/**
 * Whether this server can tell that a versioned block of the default instructions is gone.
 *
 * A block is built from a source the server reads: the user's profile from USER.md, the Reply
 * language from the config, a task's Threads rules from the task_threads switch. Before the server
 * read that source, or where it holds no copy of it (a host replica has no USER.md and no Reply
 * language), the block is missing from its default instructions without the user having removed
 * anything. Read as gone, that told 39 sessions in one night that the user's whole profile (never
 * make sound, reply in Chinese, ...) "is gone; none of its lines apply any more", and 42 that their
 * Threads rules were, while neither had changed (2026-11-24: the host replica on the dev box told
 * them, and the Mac in the seconds after a restart).
 *
 * So a block is told gone only where its source was read and is this server's to read. Every kind
 * of versioned block names its source here (tests/core/sessions/block-sources.test.ts).
 */
import { isFollower } from '../server-role.js'
import { threadsForEveryTaskRead } from '../org/keeps-threads.js'
import { userProfileRead } from './user-profile-context.js'
import { replyLanguageRead } from './reply-language-context.js'

/** By block kind (instruction-diff.ts BLOCK_KIND_IDS): true when its absence here means it is gone. */
export const BLOCK_SOURCE_READ: Record<string, () => boolean> = {
  // USER.md lives on the leader; a follower's copy (a companion's) may lag or be missing.
  'user-profile': () => !isFollower() && userProfileRead(),
  // A replica's config has no Reply language (config-allowlist.ts).
  'reply-language': () => !isFollower() && replyLanguageRead(),
  // The task_threads switch is read by the leader's status sync; a follower's copy of it may lag.
  'task-threads': () => !isFollower() && threadsForEveryTaskRead(),
  // A role's own instructions ride the task itself (Task.org_instructions), which every server holds.
  'core-instructions': () => true,
}

/** Whether a block missing from this server's default instructions is gone (a kind not named here: yes). */
export function goneKnownHere(id: string): boolean {
  const read = BLOCK_SOURCE_READ[id]
  return read ? read() : true
}
