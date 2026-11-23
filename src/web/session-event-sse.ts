/**
 * One session event as the phone's conversation stream says it (GET /api/v1/sessions/:id/stream):
 * the one mapping from a session's bus event name and data to its SSE frames, used by the stream
 * route's bus subscriber (session-stream-v1.ts) and by the cloud companion's listener of a host
 * that judges its own sessions (core/session-channel/companion-listener.ts), which hands it the
 * host's facts and flow instead of a bus event.
 *
 * Main lane only: deltas and tools carrying parentToolUseId belong to inline subagents; the phone
 * conversation page renders the primary lane, as the web UI does by default.
 */
import { emitSse } from './sse-channels.js'

export function sessionChannelKey(sessionId: string): string {
  return `session:${sessionId}`
}

/** Emit the frames of one event of `sid` on its stream channel (nothing for an event the phone does not draw). */
export async function emitSessionEventSse(sid: string, name: string, d: Record<string, unknown>, source: string | undefined): Promise<void> {
  const key = sessionChannelKey(sid)
  switch (name) {
    case 'session:text-delta': {
      if (d.parentToolUseId) return
      emitSse(key, 'text-delta', { delta: d.delta ?? '' })
      return
    }
    case 'session:thinking-delta': {
      if (d.parentToolUseId) return
      emitSse(key, 'thinking', { delta: d.delta ?? '' })
      return
    }
    case 'session:tool-use': {
      if (d.parentToolUseId) return
      const { toolDetail, toolInputPreview } = await import('../core/tool-summary.js')
      const input = d.input as Record<string, unknown> | undefined
      const detail = toolDetail(String(d.toolName ?? ''), input)
      // Additive: `detail` is the collapsed one-liner (Bash prefers `description`,
      // so the command itself never reached the phone), `inputPreview` is the same
      // bounded, masked `key: value` render the history row carries.
      const inputPreview = toolInputPreview(input)
      emitSse(key, 'tool', {
        name: d.toolName ?? '', toolUseId: d.toolUseId ?? '',
        ...(detail ? { detail } : {}),
        ...(inputPreview ? { inputPreview } : {}),
      })
      return
    }
    case 'session:tool-result': {
      if (d.parentToolUseId) return
      // Additive: the same bounded, masked <=700-character excerpt the history row
      // carries, so a finished live row can show its output before the transcript
      // lands (the phone's drawer used to say "No output" for a tool that had
      // output). The emitter already caps the bus event at 2000 characters; the
      // FULL text still only travels via the row's `detailRef` read.
      const { toolResultPreview } = await import('../core/tool-summary.js')
      const resultPreview = toolResultPreview(typeof d.result === 'string' ? d.result : undefined)
      emitSse(key, 'tool-result', {
        toolUseId: d.toolUseId ?? '',
        ...(resultPreview ? { resultPreview } : {}),
      })
      return
    }
    case 'session:status-changed': {
      const ps = typeof d.process_status === 'string' ? d.process_status : ''
      if (!ps) return
      // 'running' from session-runner = a real turn is starting → reset the
      // replay window. daemon-reconnect's 'running' is a reconciliation
      // artifact (SSH flap), NOT a turn — treating it as one gave phones
      // phantom turn boundaries (same guard as server.ts markStreaming).
      if (ps === 'running' && source !== 'daemon-reconnect' && source !== 'session-tracker') {
        emitSse(key, 'turn-start', {}, { reset: true })
      }
      emitSse(key, 'status', { processStatus: ps })
      return
    }
    case 'session:result': {
      emitSse(key, 'turn-end', {})
      return
    }
    case 'session:error': {
      emitSse(key, 'error', { message: typeof d.error === 'string' ? d.error : 'session error' })
      return
    }
    case 'session:system-event': {
      // Claude Code's own error reply ("Claude Code: Prompt is too long"), the one system line
      // the phone draws live: its error line, as the transcript row (`cliError`) reads after the
      // turn. A new event name, so an older app ignores it (additive). Other notices stay off.
      if (d.cliError !== true || typeof d.message !== 'string' || !d.message) return
      emitSse(key, 'cli-error', { message: d.message })
      return
    }
  }
}
