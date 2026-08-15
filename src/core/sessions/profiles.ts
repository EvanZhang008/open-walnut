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

You are running as a Claude Code session (a \`claude\` CLI process) that Walnut owns and keeps alive across turns. This is a change of ENGINE only — your role above is unchanged. The user is chatting with you live: answer FAST, with the fewest tool calls that get a correct answer.

**Walnut's data: MCP tools if mounted, HTTP API otherwise — decide in ONE step.** If \`mcp__walnut__*\` tools are in your tool list, use them (\`task_list\` / \`task_get\` / \`search\` to read, \`task_create\` / \`task_update\` / \`task_complete\` to write). If they are NOT in your list, they are NOT available — some machines block MCP servers by policy. Do NOT call ToolSearch to look for them (they are never deferred tools), do NOT go probing: go STRAIGHT to the HTTP API with a single Bash call. Recipes (the server is always \`localhost:3456\`, no auth):

- All open tasks: \`curl -s 'localhost:3456/api/tasks?slim=1' | jq '[.tasks[] | select(.phase != "COMPLETE" and .phase != "POST_ACTION_COMPLETE")]'\`
- One task: \`curl -s localhost:3456/api/tasks/<id>\` — create: \`curl -s -X POST localhost:3456/api/tasks -H 'Content-Type: application/json' -d '{"title":"…","project":"…"}'\`
- Search everything: \`curl -s -G localhost:3456/api/search --data-urlencode 'q=<query>' -d slim=1 | jq '.results'\` — always \`slim=1\` (one line per hit) and always \`--data-urlencode\` (bare \`?q=\` breaks on spaces/CJK). Task/session rows carry a \`ref\`; task rows also phase/project; memory rows have neither — their \`id\` is a file path you can Read. Extract fields with jq; NEVER pipe through \`head -c\` (it cuts mid-JSON and drops results). Projects: \`curl -s localhost:3456/api/projects\`
- "today's tasks" = open tasks that are overdue, due today, or pinned/focus — filter the open-tasks JSON with jq; one curl is enough.

**Paste \`ref\` tags verbatim.** API/MCP results carry \`ref\` tags (e.g. \`<task-ref id="…"/>\`). Copy them into your reply exactly as returned — that is what renders as a clickable pill for the user. Never rewrite, summarize, or invent one.

**You are still a coordinator for project work, not an executor.** Having a CLI's file and shell tools does NOT authorize you to do project work yourself: coding, debugging, and codebase investigation still go to a session (or a subagent for quick synchronous lookups), exactly as described above. Conversation deliverables (an explainer, a diagram, a quick file for THIS chat) stay inline — your shell tools are exactly right for those; write them under /tmp/, never into a repo.`

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
 *
 * `skillsIndex` is Walnut's own skills index (buildSessionSkillsPrompt) — the
 * caller resolves it (async I/O) so this stays pure. It covers ONLY the sources
 * no CLI engine auto-discovers (workspace/walnut/shipped skills), never
 * ~/.claude/skills/, so it composes with — instead of duplicating — whatever the
 * engine loads natively, and survives a provider switch unchanged.
 *
 * `memoryContext` is Walnut's standing-memory block (buildLaneMemoryContext) —
 * same deal: caller resolves the file I/O, this function just folds it in. It
 * rides the system prompt precisely so it is ENGINE-NEUTRAL — never delivered
 * through an engine's own context-file convention (CLAUDE.md, AGENTS.md, …),
 * which can change name/format outside our control.
 */
export function butlerProfile(name: string, skillsIndex?: string, memoryContext?: string): SessionProfile {
  const skillsSection = skillsIndex?.trim() ? `\n\n${skillsIndex}` : ''
  const memorySection = memoryContext?.trim() ? `\n\n${memoryContext}` : ''
  return mergeProfiles(
    {
      systemPrompt: `${buildRoleSection(name)}\n\n${BUTLER_SESSION_ADDENDUM}${memorySection}${skillsSection}`,
      systemPromptMode: 'replace',
    },
    walnutMcpProfile(),
  )!
}

/**
 * Lane profile for a NON-general console agent (mentor, note-agent, custom
 * ones): the agent's OWN persona replaces the butler role section, and the
 * same session addendum re-points it at the Walnut MCP/HTTP surface. This is
 * what lets every console agent run on the session engine with one consistent
 * feel — same timeline, same tools, same ref pills — while keeping its
 * identity. `contextBlock` carries whatever the agent's context sources
 * resolve to (its own memory etc.); the caller does the I/O.
 */
export function consoleAgentProfile(
  agentDef: { id: string; name: string; system_prompt?: string },
  skillsIndex?: string,
  contextBlock?: string,
): SessionProfile {
  const persona = agentDef.system_prompt?.trim() || `You are ${agentDef.name}.`
  const skillsSection = skillsIndex?.trim() ? `\n\n${skillsIndex}` : ''
  const contextSection = contextBlock?.trim() ? `\n\n${contextBlock}` : ''
  return mergeProfiles(
    {
      systemPrompt: `${persona}\n\n${BUTLER_SESSION_ADDENDUM}${contextSection}${skillsSection}`,
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
