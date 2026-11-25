/**
 * A session's Walnut call over HTTP that no Walnut answered, for the real-use monitor
 * (lib/no-answer-report.ts). The Mac's `walnut tools call` (src/commands/tools.ts), `walnut guide`
 * and the `open-walnut mcp` mount of Main, an ask and a console agent (src/mcp/tools.ts) reach their
 * server over HTTP. While a deploy restarts the server and the daemon that runs inside it, a call
 * fails ("Walnut server not running") and nothing hears of it (2026-11-25 audit: 5 of 5 such CLI
 * failures were never counted). So it is kept in the session's spool beside its daemon socket, as
 * the daemon's own CLI and MCP server keep theirs, and the session's next call a server answers tells
 * it over that socket (wn-cli.ts tellKeptNoAnswers).
 *
 * The code kept is the one the agent read, as the session hook reads it (usage-watch/normalize.ts
 * toolErrorCode), so the hook's row of the same failure matches it and it counts once (record.ts).
 * Outside a session, and in a trigger check, nothing is kept. Never throws, never fails the call.
 */
import { NO_ANSWER_CODES, noAnswerSpoolFile, spoolHoldsNoAnswers, spoolNoAnswer } from '../lib/no-answer-report.js'

/** The session this process runs in: its daemon socket and id. Null outside one, or in a trigger check. */
function sessionOf(env: NodeJS.ProcessEnv): { socket: string; sid: string } | null {
  const socket = (env.WALNUT_AGENT_SOCKET ?? '').trim()
  const sid = (env.WALNUT_SESSION_ID ?? '').trim()
  if (!socket || !sid || (env.WALNUT_CHECK_TOKEN ?? '').trim()) return null
  return { socket, sid }
}

/**
 * A call that failed, with the code its agent read: kept when no Walnut answered it (NO_ANSWER_CODES).
 * A refusal, an op's own error or bad arguments are answers: nothing is kept.
 */
export function noteSessionFailure(op: string, code: string, client: 'mcp' | 'cli' = 'cli', env: NodeJS.ProcessEnv = process.env): void {
  try {
    const s = sessionOf(env)
    if (!s || !NO_ANSWER_CODES.has(code)) return
    spoolNoAnswer(noAnswerSpoolFile(s.socket, s.sid), op, code, client)
  } catch { /* counting never fails a call */ }
}

/** A call a server answered tells what the session keeps; one stat when it keeps nothing. */
export async function noteSessionAnswered(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const s = sessionOf(env)
    if (!s || !spoolHoldsNoAnswers(noAnswerSpoolFile(s.socket, s.sid))) return
    const { probeSocket, tellKeptNoAnswers } = await import('./wn-cli.js')
    if (probeSocket(s.socket)?.isSocket) await tellKeptNoAnswers(s.socket, s.sid)
  } catch { /* counting never fails a call */ }
}
