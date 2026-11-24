/**
 * One user message on the stdin of `claude -p --input-format stream-json`: the CLI's own input
 * envelope, `{"type":"user","message":{"role":"user","content":...}}` and a newline. `content` is
 * the text, or Anthropic content blocks (image blocks with a base64 source, then text).
 *
 * The one serializer for the server side (session-io.ts, micro-claude-warm.ts, the claude-cli
 * model adapter). The daemon writes the same envelope inline: it stays self-contained
 * (daemon-core.ts).
 */

export type StreamJsonContent = string | ReadonlyArray<Record<string, unknown>>

export function streamJsonUserLine(content: StreamJsonContent, extra: { uuid?: string } = {}): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content }, ...(extra.uuid ? { uuid: extra.uuid } : {}) })}\n`
}
