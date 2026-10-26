/**
 * `walnut.ai` for a plugin's App in the browser: the same call as the server's, relayed to
 * `POST /api/plugin-runtime/<id>/ai/run`, which streams NDJSON (text deltas, then one result or
 * error line). The run is cancelled when the caller's signal or the plugin's own signal aborts.
 */
import { getDeviceToken } from '@/api/device-token'

export interface WebAiRequest {
  prompt: string
  context?: unknown
  system?: string
  format?: { schema: Record<string, unknown> }
  needs?: { ops?: string[]; files?: 'read' | 'edit'; commands?: string[]; cwd?: string }
  conversation?: string
  effort?: 'quick' | 'normal' | 'deep'
  timeoutMs?: number
  interactive?: boolean
  onText?(delta: string): void
  signal?: AbortSignal
}

export interface WebAiResult {
  text: string
  json?: unknown
  route: 'direct' | 'agent'
  engine: string
  model?: string
  costUsd?: number
  conversation?: string
  durationMs: number
}

export interface WebAiService {
  run(request: WebAiRequest): Promise<WebAiResult>
  end(conversation: string): Promise<{ ended: boolean }>
}

function aiError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function authHeaders(): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const token = getDeviceToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return headers
}

export function createWebAi(pluginId: string, pluginSignal: AbortSignal): WebAiService {
  const base = `/api/plugin-runtime/${encodeURIComponent(pluginId)}/ai`
  return {
    async run(request) {
      const { onText, signal: callerSignal, ...body } = request
      const signal = callerSignal ? AbortSignal.any([pluginSignal, callerSignal]) : pluginSignal
      let response: Response
      try {
        response = await fetch(`${base}/run`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body), signal })
      } catch (error) {
        if (signal.aborted) throw aiError('ai_aborted', 'The call was cancelled')
        throw aiError('ai_failed', `Walnut could not be reached: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok || !response.body) {
        const answer = await response.json().catch(() => ({})) as { code?: string; error?: string }
        throw aiError(answer.code ?? 'ai_failed', answer.error ?? `HTTP ${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (value) buffer += decoder.decode(value, { stream: true })
          let newline: number
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const raw = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (!raw) continue
            const line = JSON.parse(raw) as { type: string; delta?: string; code?: string; message?: string } & WebAiResult
            if (line.type === 'text' && typeof line.delta === 'string') {
              try { onText?.(line.delta) } catch { /* a listener never breaks the stream */ }
            } else if (line.type === 'error') {
              throw aiError(line.code ?? 'ai_failed', line.message ?? 'The AI call failed')
            } else if (line.type === 'result') {
              const { type: _type, ...result } = line
              return result as WebAiResult
            }
          }
          if (done) break
        }
      } catch (error) {
        if (signal.aborted) throw aiError('ai_aborted', 'The call was cancelled')
        throw error
      }
      throw aiError('ai_failed', 'The answer stream ended without a result')
    },
    async end(conversation) {
      const response = await fetch(`${base}/end`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ conversation }), signal: pluginSignal })
      const answer = await response.json().catch(() => ({})) as { ended?: boolean; code?: string; error?: string }
      if (!response.ok) throw aiError(answer.code ?? 'ai_failed', answer.error ?? `HTTP ${response.status}`)
      return { ended: answer.ended === true }
    },
  }
}
