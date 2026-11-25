/**
 * `walnut guide` — print the full Walnut manual (the walnut skill body).
 *
 * One name everywhere (decision 2026-08-23): sessions and humans type the
 * SAME `walnut guide` on every host. On the hub this runs the shared
 * `skill_read` op directly; on a remote host the daemon's `walnut` shim
 * relays the same op over the agent gateway. Same document either way —
 * the manual is one live file on the hub, never a distributed copy.
 */

import type { GlobalOptions } from '../core/types.js'

export async function runGuide(globals: GlobalOptions): Promise<void> {
  const { executeOp } = await import('../ops/index.js')
  const { LOCAL_ORIGIN } = await import('../lib/caller-origin.js')
  const { cliOpCaller } = await import('../lib/cli-sender.js')
  // A session reads the manual through its shell, which keeps about 10 KB: it gets the first page, whose
  // last line names the call that reads on (ops/answer.ts). A person's terminal prints all of it.
  const inSession = !!process.env.WALNUT_SESSION_ID?.trim() && !process.env.WALNUT_CHECK_TOKEN
  const outcome = await executeOp('skill_read', { dirName: 'walnut' }, { origin: LOCAL_ORIGIN, ...(inSession ? { forAgent: 'cli' as const } : {}), ...cliOpCaller() })
  // A session's read no Walnut answered is counted, as `walnut tools call`'s is (providers/session-no-answer.ts).
  const noAnswer = await import('../providers/session-no-answer.js')
  if (outcome.ok) await noAnswer.noteSessionAnswered()
  else {
    const { toolErrorCode } = await import('../core/usage-watch/normalize.js')
    noAnswer.noteSessionFailure('skill_read', toolErrorCode(`walnut: ${outcome.message}`))
  }
  if (!outcome.ok) {
    console.error(`walnut: ${outcome.message}`)
    process.exitCode = 1
    return
  }
  const skill = (outcome.result as { skill?: { content?: string } } | undefined)?.skill
  if (!skill?.content) {
    console.error('walnut: the server returned no manual content')
    process.exitCode = 1
    return
  }
  if (globals.json) {
    const { outputJson } = await import('../utils/json-output.js')
    outputJson({ content: skill.content })
    return
  }
  process.stdout.write(skill.content.endsWith('\n') ? skill.content : skill.content + '\n')
}
