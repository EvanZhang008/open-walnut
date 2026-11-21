/**
 * `session.tag_requests` (config.yaml, default off): every model request of a session
 * Walnut starts carries `x-walnut-session: <task id>`, and `x-walnut-project: <the task's
 * project>` when it has one, so a proxy the user runs in front of their provider can tell
 * Walnut's sessions from their other ones and route by project, wherever the session works
 * (docs/reference/codex-engine.md). Claude Code sends them through ANTHROPIC_CUSTOM_HEADERS,
 * Codex through the http_headers of the provider it uses.
 *
 * The send path that builds a Claude Code spawn is synchronous, so the switch is kept
 * here from every config read (getConfig), which runs long before any session starts.
 */
export const REQUEST_TAG_HEADER = 'x-walnut-session'
export const REQUEST_PROJECT_HEADER = 'x-walnut-project'

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
 * The project header's value: the project's name percent-encoded as UTF-8
 * (encodeURIComponent), so a space, a colon or a non-ASCII letter rides a header line
 * as it is meant; a proxy decodes it with decodeURIComponent (urllib.parse.unquote).
 * '' for a task in the Inbox ('' or `Inbox`), which sends no project header.
 */
export function requestProjectValue(project: string | undefined): string {
  // Inline, not isInboxProject: this file has no dependencies (the host daemon's worker bundles it).
  const name = (project ?? '').trim()
  return name && name.toLowerCase() !== 'inbox' ? encodeURIComponent(name) : ''
}

/** The tag's own header lines: the session's, then its project's when it has one. */
function tagLines(value: string, project: string | undefined): string[] {
  const encoded = requestProjectValue(project)
  return [`${REQUEST_TAG_HEADER}: ${value}`, ...(encoded ? [`${REQUEST_PROJECT_HEADER}: ${encoded}`] : [])]
}

/**
 * ANTHROPIC_CUSTOM_HEADERS with the tag in it: one `Name: value` per line, as Claude
 * Code reads it, every line the user set kept (an older tag or project line is replaced).
 * `project` is the task's project, or undefined for a call that belongs to no task.
 */
export function withRequestTagHeaders(existing: string | undefined, value: string, project: string | undefined): string {
  const ours = [REQUEST_TAG_HEADER, REQUEST_PROJECT_HEADER].map((h) => `${h}:`)
  const own = (existing ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !ours.some((h) => l.toLowerCase().startsWith(h)))
  return [...own, ...tagLines(value, project)].join('\n')
}

/**
 * Headers for Walnut's own model calls from the server (the model adapters, a connection test):
 * `x-walnut-session: walnut` while the tag is on, none otherwise.
 */
export function walnutRequestTagHeaders(config?: unknown): Record<string, string> {
  return requestTagOn(config) ? { [REQUEST_TAG_HEADER]: 'walnut' } : {}
}

/**
 * A Codex config with the tag on the provider its threads go to (`model_provider`),
 * when the config defines that provider; codex's built-in providers take no header here.
 */
export function withCodexRequestTag(
  config: Record<string, unknown> | undefined, value: string, project: string | undefined,
): Record<string, unknown> | undefined {
  if (!config) return config
  const id = config.model_provider
  const providers = config.model_providers
  if (typeof id !== 'string' || !providers || typeof providers !== 'object' || Array.isArray(providers)) return config
  const def = (providers as Record<string, unknown>)[id]
  if (!def || typeof def !== 'object' || Array.isArray(def)) return config
  const headers = (def as { http_headers?: unknown }).http_headers
  const own = Object.fromEntries(Object.entries(headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {})
    .filter(([name]) => ![REQUEST_TAG_HEADER, REQUEST_PROJECT_HEADER].includes(name.toLowerCase())))
  const encoded = requestProjectValue(project)
  if (encoded) own[REQUEST_PROJECT_HEADER] = encoded
  return {
    ...config,
    model_providers: {
      ...(providers as Record<string, unknown>),
      [id]: { ...def, http_headers: { ...own, [REQUEST_TAG_HEADER]: value } },
    },
  }
}

/**
 * A Walnut one-shot `claude -p` (titles, summaries, placement, micro-Claude, inline
 * subagents) with the tag on (`walnut`, no project: it belongs to no one task): in its env, and in its `--settings` env too, because a
 * settings.json env that names ANTHROPIC_CUSTOM_HEADERS is applied over the process env.
 * `userHeaders` is that settings value, kept beside the tag. A `--settings` that is not
 * inline JSON is left as it is.
 */
export function withOneShotRequestTag<T extends { args: string[]; env: Record<string, string | undefined> }>(
  spec: T, userHeaders: string | undefined,
): T {
  const headers = withRequestTagHeaders(userHeaders ?? spec.env.ANTHROPIC_CUSTOM_HEADERS, 'walnut', undefined)
  const args = [...spec.args]
  const at = args.indexOf('--settings')
  if (at < 0) {
    args.push('--settings', JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: headers } }))
  } else {
    try {
      const parsed = JSON.parse(args[at + 1] ?? '') as Record<string, unknown>
      const env = parsed.env && typeof parsed.env === 'object' ? parsed.env as Record<string, unknown> : {}
      args[at + 1] = JSON.stringify({ ...parsed, env: { ...env, ANTHROPIC_CUSTOM_HEADERS: headers } })
    } catch { /* a settings file path: the env below still carries it */ }
  }
  return { ...spec, args, env: { ...spec.env, ANTHROPIC_CUSTOM_HEADERS: headers } }
}
