/**
 * `session.tag_requests` (config.yaml, default off): every model request of a session
 * Walnut starts carries `x-walnut-session: <task id>`, so a proxy the user runs in front
 * of their provider can tell Walnut's sessions from their other ones, wherever the
 * session works (docs/reference/codex-engine.md). Claude Code sends it through
 * ANTHROPIC_CUSTOM_HEADERS, Codex through the http_headers of the provider it uses.
 *
 * The send path that builds a Claude Code spawn is synchronous, so the switch is kept
 * here from every config read (getConfig), which runs long before any session starts.
 */
export const REQUEST_TAG_HEADER = 'x-walnut-session'

let tagging = false

function readTagging(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false
  const session = (config as { session?: unknown }).session
  return !!session && typeof session === 'object' && (session as { tag_requests?: unknown }).tag_requests === true
}

/** Called by getConfig with every config it reads. */
export function noteRequestTagConfig(config: unknown): void {
  tagging = readTagging(config)
}

/** Whether sessions tag their requests: from `config` when given, else from the last config read. */
export function requestTagOn(config?: unknown): boolean {
  return config === undefined ? tagging : readTagging(config)
}

/** The header's value for a task: its id, kept to characters a header takes as they are. */
export function requestTagValue(taskId: string | undefined): string {
  return (taskId ?? '').replace(/[^A-Za-z0-9._-]/g, '') || 'walnut'
}

/**
 * ANTHROPIC_CUSTOM_HEADERS with the tag in it: one `Name: value` per line, as Claude
 * Code reads it, every line the user set kept (an older tag line is replaced).
 */
export function withRequestTagHeaders(existing: string | undefined, value: string): string {
  const own = (existing ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !l.toLowerCase().startsWith(`${REQUEST_TAG_HEADER}:`))
  return [...own, `${REQUEST_TAG_HEADER}: ${value}`].join('\n')
}

/**
 * A Codex config with the tag on the provider its threads go to (`model_provider`),
 * when the config defines that provider; codex's built-in providers take no header here.
 */
export function withCodexRequestTag(config: Record<string, unknown> | undefined, value: string): Record<string, unknown> | undefined {
  if (!config) return config
  const id = config.model_provider
  const providers = config.model_providers
  if (typeof id !== 'string' || !providers || typeof providers !== 'object' || Array.isArray(providers)) return config
  const def = (providers as Record<string, unknown>)[id]
  if (!def || typeof def !== 'object' || Array.isArray(def)) return config
  const headers = (def as { http_headers?: unknown }).http_headers
  const own = headers && typeof headers === 'object' && !Array.isArray(headers) ? headers as Record<string, unknown> : {}
  return {
    ...config,
    model_providers: {
      ...(providers as Record<string, unknown>),
      [id]: { ...def, http_headers: { ...own, [REQUEST_TAG_HEADER]: value } },
    },
  }
}
