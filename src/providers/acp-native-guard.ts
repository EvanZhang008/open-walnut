/**
 * A session whose record runs on an ACP engine (Codex and the rest) is never run as a Claude
 * Code CLI. 2026-11-10: a server shut down while it re-attached a Codex session; the attach came
 * back empty and the queue's drain went on down the Claude path, which started a Claude CLI under
 * the Codex session's id. That CLI then took a lead's request on its host, said it had touched
 * nothing, and the Codex runner never saw it. Both the drain (claude-code-session.ts
 * processNextNow) and the native spawn itself ask this; the host's own delivery skips such a
 * session too (offline-host-core.ts liveHere).
 */
import { engineCaps, isAcpEngine } from '../core/agents/engine-registry.js'

export class AcpSessionNotNativeError extends Error {
  readonly code = 'ACP_SESSION'
  constructor(readonly sessionId: string, readonly engine: string) {
    super(`Not sent yet: this session runs on ${engineCaps(engine).displayName}, and Walnut never starts Claude Code under its id. `
      + `It goes to ${engineCaps(engine).displayName} once that session attaches again (Retry sends it now).`)
    this.name = 'AcpSessionNotNativeError'
  }
}

/**
 * The ACP engine a session's record names, or null for a native session or none. A record that
 * cannot be read throws: the spawn must not take that for native (the failure is retried).
 */
export async function acpEngineOfRecord(sessionId: string): Promise<string | null> {
  const { getSessionByClaudeId } = await import('../core/session-tracker.js')
  const record = await getSessionByClaudeId(sessionId)
  return record && isAcpEngine(record.engine) ? String(record.engine) : null
}

/** Throws before a Claude CLI would start, resume or fork under an ACP session's id. */
export async function refuseNativeSpawnOnAcpRecord(sessionId: string | undefined | null): Promise<void> {
  if (!sessionId) return
  const engine = await acpEngineOfRecord(sessionId)
  if (engine) throw new AcpSessionNotNativeError(sessionId, engine)
}
