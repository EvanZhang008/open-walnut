/**
 * The inputs of a session's default instructions that live outside the task (session-context.ts
 * defaultInstructions): the user's profile (USER.md), the Reply language and the other settings
 * read with it, and the experiment switches the prompt reads synchronously: task_threads (every
 * task keeps Threads), threads_kept_by_walnut and brief_off (the wording of the Threads and Brief
 * rules). Each is a cached copy; whoever builds a prompt, compares one against the current
 * instructions or restates them reads them all first, through this one call.
 *
 * The switches are read here because elsewhere only the leader's status sync and a session start
 * set them: in the seconds after a restart a task's Threads rules looked off, and a session was told
 * they were gone (2026-11-24); a host replica runs no status sync at all.
 */
import { refreshUserProfile } from './user-profile-context.js'
import { refreshReplyLanguage } from './reply-language-context.js'
import { setThreadsForEveryTask } from '../org/keeps-threads.js'
import { setThreadsKept } from '../org/threads-kept.js'
import { setBriefOff } from '../org/brief-off.js'

/** The switches, from one read of the config. A fallback config (the file unreadable) is no reading of them. */
async function readSwitches(): Promise<void> {
  try {
    const [{ getConfig, isFallbackConfig }, { experimentalEnabled }] = await Promise.all([import('../config-manager.js'), import('../experimental.js')])
    const config = await getConfig()
    if (isFallbackConfig(config)) return
    const flags = config.experimental
    setThreadsForEveryTask(experimentalEnabled(flags, 'task_threads'))
    setThreadsKept(experimentalEnabled(flags, 'threads_kept_by_walnut'))
    setBriefOff(experimentalEnabled(flags, 'brief_off'))
  } catch { /* unread: its block is not told gone (block-sources.ts) */ }
}

/** Read every input of the default instructions as it is now. Never throws. */
export async function refreshPromptInputs(): Promise<void> {
  await Promise.all([
    refreshUserProfile().catch(() => null),
    refreshReplyLanguage().catch(() => null),
    readSwitches(),
  ])
}
