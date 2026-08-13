/**
 * Session profile presets — the named launch bundles a session can carry.
 *
 * A `SessionProfile` (core/types.ts) is expanded into `claude` CLI args at every
 * spawn INCLUDING cold `--resume`, so a preset here defines an identity that
 * survives the CLI process being reaped. Keep presets pure (no I/O): they are
 * built on the spawn path, and the resume path rebuilds them from the record.
 */

import { buildRoleSection } from '../../agent/context.js'
import type { SessionProfile } from '../types.js'

/**
 * Mount the Walnut MCP server (`open-walnut mcp`) into a session, giving the
 * CLI structured access to tasks / projects / sessions / search instead of
 * prose instructions. The `open-walnut` bin is on PATH wherever Walnut is
 * installed; the server talks to the local API (see src/mcp/server.ts).
 */
export function walnutMcpProfile(): SessionProfile {
  return {
    mcpServers: {
      walnut: { command: 'open-walnut', args: ['mcp'] },
    },
  }
}

/**
 * Addendum that turns the in-process butler persona into a CLI-session persona.
 *
 * `buildRoleSection` was written for the in-process agent loop, where task
 * management is a set of native tools (task_query, session_start, …). Running as
 * a `claude` session those tools do not exist — the same capabilities arrive over
 * the mounted Walnut MCP server instead — so the addendum re-points the model at
 * the MCP surface and restates the two rules the MCP result text depends on
 * (paste `ref` tags verbatim; stay a coordinator).
 */
const BUTLER_SESSION_ADDENDUM = `## How you are running

You are running as a Claude Code session (a \`claude\` CLI process) that Walnut owns and keeps alive across turns. This is a change of ENGINE only — your role above is unchanged.

**Walnut's data lives behind the mounted \`walnut\` MCP server, not in native tools.** Use its tools for everything about the user's tasks: \`task_list\` / \`task_get\` / \`search\` to read, \`task_create\` / \`task_update\` / \`task_complete\` / \`task_delete\` to write, \`project_list\` and \`session_list\` for context. Read before you write (\`task_list\` or \`search\`) so you never create a duplicate. Any instruction above that names a native tool (task_query, task_search, session_start, …) means "the matching \`walnut\` MCP tool".

**Paste \`ref\` tags verbatim.** MCP results carry a \`ref\` tag (e.g. \`<task-ref id="…"/>\`). Copy it into your reply exactly as returned — that is what renders as a clickable pill for the user. Never rewrite, summarize, or invent one.

**You are still a coordinator, not an executor.** Having a CLI's file and shell tools does NOT authorize you to do the work yourself: real work goes to a session (or a subagent for quick synchronous lookups), exactly as described above.`

/**
 * The butler's own profile — a full-replace system prompt plus the Walnut MCP
 * mount, i.e. "the butler is just a session with a profile".
 *
 * `name` is the user's display name (`config.user.name`); the caller resolves it
 * so this stays pure/synchronous — it is built on the spawn path and rebuilt on
 * every cold resume, neither of which should do config I/O.
 *
 * `allowedTools` is deliberately left UNDEFINED: the butler runs on the user's
 * own machine and full tool access is today's behavior. Narrowing it is a later
 * polish item, not an MVP requirement.
 */
export function butlerProfile(name: string): SessionProfile {
  return mergeProfiles(
    {
      systemPrompt: `${buildRoleSection(name)}\n\n${BUTLER_SESSION_ADDENDUM}`,
      systemPromptMode: 'replace',
    },
    walnutMcpProfile(),
  )!
}

/**
 * Merge two profiles, `overlay` winning per field. MCP servers merge per key so
 * a config-driven pre-mount (walnutMcpProfile) composes with a caller's own
 * mounts instead of replacing them; allowedTools union, deduped.
 */
export function mergeProfiles(
  base: SessionProfile | undefined,
  overlay: SessionProfile | undefined,
): SessionProfile | undefined {
  // Shallow-clone the early returns too: the result is persisted on the session
  // record, and handing back the caller's own object would let a later mutation
  // of that object silently rewrite what the record holds.
  if (!base) return overlay ? { ...overlay } : undefined
  if (!overlay) return { ...base }
  const mcpServers = { ...(base.mcpServers ?? {}), ...(overlay.mcpServers ?? {}) }
  const allowedTools = [...new Set([...(base.allowedTools ?? []), ...(overlay.allowedTools ?? [])])]
  return {
    ...base,
    ...overlay,
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
  }
}
