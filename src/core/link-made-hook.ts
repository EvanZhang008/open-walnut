/**
 * The changes a session makes are linked to its task: a pull request `gh pr create` opened, a code
 * review a company's review tool posted, a commit `git push` put straight on the main branch. The
 * Bash call is remembered at its tool use when a link kind reads that command (link-kinds.ts
 * `made.command`), and when its result arrives each such kind names the URLs the run made; they
 * become the task's link tags while it has a free place (link-tags.ts). The pull
 * request watcher (pull-requests/pr-watch.ts) follows a `pr:` link from there.
 */

import { log } from '../logging/index.js'
import { commandMakesLinks, linksMadeBy } from './link-kinds.js'
import type { OnToolResultPayload, OnToolUsePayload, SessionHookDefinition } from './session-hooks/types.js'

const PENDING_MS = 30 * 60_000
const MAX_PENDING = 200

/** Tool use id to its command and when it started, for Bash calls a link kind reads. */
const pending = new Map<string, { at: number; command: string }>()

function remember(id: string, command: string, now: number): void {
  for (const [key, entry] of pending) if (now - entry.at > PENDING_MS) pending.delete(key)
  if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!)
  pending.set(id, { at: now, command })
}

export const linkMadeHook: SessionHookDefinition = {
  // The id it had when it linked GitHub pull requests only: a setting that names it keeps working.
  id: 'pr-link-from-gh',
  name: 'Link the changes the session made',
  description: 'Tags the task with the pull request, code review or main-branch commit a command in its session made, so its status is watched.',
  hooks: ['onToolUse', 'onToolResult'],
  priority: 60,
  source: 'builtin',
  enabled: true,
  timeoutMs: 10_000,
  handler: async (payload) => {
    if ('toolName' in payload) {
      const use = payload as OnToolUsePayload
      if (use.toolName !== 'Bash' || !use.toolUseId) return
      const command = typeof use.input?.command === 'string' ? use.input.command : ''
      if (command && commandMakesLinks(command)) remember(use.toolUseId, command, Date.now())
      return
    }
    const res = payload as OnToolResultPayload
    const run = res.toolUseId ? pending.get(res.toolUseId) : undefined
    if (!run) return
    pending.delete(res.toolUseId!)
    if (!res.taskId || !res.result) return
    const tags = linksMadeBy(run.command, res.result)
    if (tags.length === 0) return
    const { addLinkTags } = await import('./link-tags-apply.js')
    const added = await addLinkTags(res.taskId, tags, 'session-command')
    if (added.length) log.task.info('changes the session made linked', { taskId: res.taskId, sessionId: res.sessionId, added })
  },
}

/** For tests. */
export function _resetLinkMadeHookForTesting(): void {
  pending.clear()
}
