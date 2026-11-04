/**
 * A pull request a session opens is linked to its task: the Bash call that ran `gh pr create`
 * is remembered at its tool use, and the URL gh printed (a new pull request, or the one that
 * already existed for the branch) becomes the task's `pr:` link tag when its result arrives. Only
 * that one URL: gh prints it alone on a line, last, and whatever else the command printed (a
 * `gh pr list` after it, an issue link in a template) is not this session's pull request.
 * The pull request watcher (pr-watch.ts) follows it from there.
 */

import { log } from '../../logging/index.js'
import { GITHUB_PR_URL_RE } from './model.js'
import type { OnToolResultPayload, OnToolUsePayload, SessionHookDefinition } from '../session-hooks/types.js'

const GH_PR_CREATE_RE = /(?:^|[\s;&|(`])gh\s+pr\s+create\b/
const PENDING_MS = 30 * 60_000
const MAX_PENDING = 200

/** Tool use id to when it started, for Bash calls that ran `gh pr create`. */
const pending = new Map<string, number>()

export function runsGhPrCreate(command: string): boolean {
  return GH_PR_CREATE_RE.test(command)
}

/** The pull request URL gh printed: the last line that is a pull request URL and nothing else. */
export function createdPrUrl(output: string): string | null {
  const lines = output.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (GITHUB_PR_URL_RE.test(line)) return line
  }
  return null
}

function remember(id: string, now: number): void {
  for (const [key, at] of pending) if (now - at > PENDING_MS) pending.delete(key)
  if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!)
  pending.set(id, now)
}

export const prLinkHook: SessionHookDefinition = {
  id: 'pr-link-from-gh',
  name: 'Link a pull request the session opened',
  description: 'Tags the task with the pull request a `gh pr create` in its session opened, so its status is watched.',
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
      if (command && runsGhPrCreate(command)) remember(use.toolUseId, Date.now())
      return
    }
    const res = payload as OnToolResultPayload
    if (!res.toolUseId || !pending.has(res.toolUseId)) return
    pending.delete(res.toolUseId)
    const url = res.taskId && res.result ? createdPrUrl(res.result) : null
    if (!url || !res.taskId) return
    const { tagCreatedPullRequest } = await import('../link-tags-apply.js')
    const added = await tagCreatedPullRequest(res.taskId, url, 'gh-pr-create')
    if (added.length) log.task.info('pull request the session opened linked', { taskId: res.taskId, sessionId: res.sessionId, added })
  },
}

/** For tests. */
export function _resetPrLinkHookForTesting(): void {
  pending.clear()
}
