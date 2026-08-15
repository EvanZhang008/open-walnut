/**
 * One-line human summaries for tool calls — the "detail" line mobile clients
 * show next to a tool name (collapsed Claude-app style: "Bash — ls docs/").
 *
 * Shared by every surface that flattens tool_use blocks into slim rows:
 * api-v1 chat normalization, session transcript projection, and the cloud
 * bridge transcript builder. Purely additive — consumers that ignore the
 * field keep working.
 */

const DETAIL_MAX = 160

function clipDetail(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > DETAIL_MAX ? oneLine.slice(0, DETAIL_MAX) + '…' : oneLine
}

/** Input keys tried per tool name — first present string wins. */
const TOOL_DETAIL_KEYS: Record<string, string[]> = {
  Bash: ['description', 'command'],
  BashOutput: ['bash_id'],
  Read: ['file_path', 'path'],
  Write: ['file_path', 'path'],
  Edit: ['file_path', 'path'],
  MultiEdit: ['file_path', 'path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Task: ['description', 'prompt'],
  Agent: ['description', 'prompt'],
  Skill: ['skill', 'command'],
  TodoWrite: ['subject'],
  ExitPlanMode: ['plan'],
}

// Generic fallback keys when the tool isn't in the map above — covers both
// CLI tools and the Personal AI's walnut-native tools (task_* / session_*).
const GENERIC_DETAIL_KEYS = [
  'description', 'command', 'file_path', 'path', 'url', 'query', 'queries',
  'pattern', 'prompt', 'text', 'title', 'message', 'question', 'id',
]

/**
 * Short summary of a tool call's input ("what is it doing"), or undefined
 * when the input carries nothing human-readable.
 */
export function toolDetail(name: string, input: Record<string, unknown> | undefined | null): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const keys = TOOL_DETAIL_KEYS[name] ?? GENERIC_DETAIL_KEYS
  for (const key of keys) {
    const val = input[key]
    if (typeof val === 'string' && val.trim()) return clipDetail(val)
    // String arrays ("queries": [...]) summarize as a comma list.
    if (Array.isArray(val)) {
      const strings = val.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      if (strings.length > 0) return clipDetail(strings.join(', '))
    }
  }
  return undefined
}

const RESULT_PREVIEW_MAX = 700

/**
 * Clipped tool result text for the expanded card. Strips nothing — mobile
 * renders it as monospace verbatim. Undefined when there is no text.
 */
export function toolResultPreview(result: string | undefined | null): string | undefined {
  if (typeof result !== 'string') return undefined
  const trimmed = result.trim()
  if (!trimmed) return undefined
  return trimmed.length > RESULT_PREVIEW_MAX ? trimmed.slice(0, RESULT_PREVIEW_MAX) + '…' : trimmed
}

/**
 * Extract the plain-text payload of a tool_result content field (string or
 * Anthropic content-block array). Image blocks are skipped (binary).
 */
export function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}
