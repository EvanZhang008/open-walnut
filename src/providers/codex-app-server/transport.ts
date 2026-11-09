/**
 * Which way a Codex session reaches Codex: Walnut's own client for
 * `codex app-server` (the default), or the codex-acp adapter (`acp`), kept as
 * the way back while the direct client is new:
 *
 *   engines:
 *     codex:
 *       transport: acp        # app-server (default) | acp
 *
 * or WALNUT_CODEX_TRANSPORT=acp in the server's environment, which wins. A session
 * given its own adapter command (a test's scripted adapter) runs that adapter. The
 * choice rides the session's adapter env (CODEX_TRANSPORT_ENV), so a start on
 * another host takes it there too; a host whose worker predates the direct client
 * ignores it and runs the adapter, as before. Only Codex reads it: every other ACP
 * engine runs its own adapter unchanged.
 */

import { redactSensitiveText } from '../../logging/redact.js'
import { AppServerRpcError } from './rpc.js'

export const CODEX_TRANSPORT_ENV = 'WALNUT_CODEX_TRANSPORT'
export type CodexTransport = 'app-server' | 'acp'

export function resolveCodexTransport(
  config: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options: { adapterGiven?: boolean } = {},
): CodexTransport {
  const fromEnv = env[CODEX_TRANSPORT_ENV]
  if (fromEnv === 'acp' || fromEnv === 'app-server') return fromEnv
  if (options.adapterGiven) return 'acp'
  const set = (config as { engines?: { codex?: { transport?: unknown } } } | null | undefined)?.engines?.codex?.transport
  return set === 'acp' ? 'acp' : 'app-server'
}

export interface ResumeFailure {
  kind: 'not_found' | 'exited' | 'timeout' | 'other'
  words: string
}

// Only Codex's own words for a thread it has no copy of. A rollout it has but cannot read
// (permissions, a damaged file) or a provider it cannot find is another failure: the
// conversation is still there, so nothing may replace it with a new thread.
const NOT_FOUND = /\bno rollout found for thread\b|\bthread not found\b|\bno such thread\b|\bno thread with id\b/i
const NOT_A_LOST_THREAD = /permission denied|os error|failed to (?:parse|read|deserialize)|invalid|corrupt|provider/i

/** Why `thread/resume` failed, in words the chat can show (redacted, one line). */
export function describeResumeFailure(error: unknown): ResumeFailure {
  if (error instanceof AppServerRpcError && error.exited) {
    return { kind: 'exited', words: 'Codex app-server stopped while resuming the conversation; the next message tries again.' }
  }
  if (error instanceof AppServerRpcError && error.timedOut) {
    return { kind: 'timeout', words: 'Codex did not answer the resume in time; the next message tries again.' }
  }
  const raw = error instanceof Error ? error.message : String(error)
  const said = redactSensitiveText(raw).replace(/\s+/g, ' ').trim().slice(0, 240)
  if (NOT_FOUND.test(raw) && !NOT_A_LOST_THREAD.test(raw)) {
    return { kind: 'not_found', words: `Codex has no saved copy of it on this host (${said}).` }
  }
  return { kind: 'other', words: `Codex could not resume the earlier conversation: ${said}` }
}
