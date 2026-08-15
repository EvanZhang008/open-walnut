/**
 * Session profile presets — the named launch bundles a session can carry.
 *
 * A `SessionProfile` (core/types.ts) is expanded into `claude` CLI args at every
 * spawn INCLUDING cold `--resume`, so a preset here defines an identity that
 * survives the CLI process being reaped. Keep presets pure (no I/O): they are
 * built on the spawn path, and the resume path rebuilds them from the record.
 */

import path from 'node:path'
import { buildRoleSection, buildWorkModesSection } from '../../agent/context.js'
import type { SessionProfile } from '../types.js'

/**
 * The walnut CLI entry of THIS running install, when identifiable.
 *
 * The bare bin name `open-walnut` proved unreliable: whether it exists on
 * PATH depends on how the package was linked (this very machine only links
 * `walnut`), and a dead command means the MCP mount silently never comes up —
 * the session falls back to raw curl. The server process IS the CLI package
 * (`node dist/cli.js web ...`), so its own argv[1] is the one entry we can
 * trust absolutely. Guarded by a basename allowlist so a test runner
 * (vitest) is never mistaken for the CLI.
 */
const CLI_ENTRY: string | null = (() => {
  const entry = process.argv[1]
  if (!entry) return null
  const base = path.basename(entry)
  return base === 'cli.js' || base === 'open-walnut.js' || base === 'walnut.js' || base === 'open-walnut' || base === 'walnut'
    ? path.resolve(entry)
    : null
})()

/**
 * Mount the Walnut MCP server into a session, giving the CLI structured access
 * to tasks / projects / sessions / search instead of prose instructions. The
 * mount targets this install's own CLI entry via the running node binary
 * (PATH-independent); the bare bin name is only a fallback for exotic setups.
 * The server talks to the local API (see src/mcp/server.ts).
 */
export function walnutMcpProfile(): SessionProfile {
  return {
    mcpServers: {
      walnut: CLI_ENTRY
        ? { command: process.execPath, args: [CLI_ENTRY, 'mcp'] }
        : { command: 'open-walnut', args: ['mcp'] },
    },
  }
}

/**
 * The Personal AI's own profile — a full-replace system prompt plus the Walnut MCP
 * mount, i.e. "the Personal AI is just a session with a profile".
 *
 * `name` is the user's display name (`config.user.name`); the caller resolves it
 * so this stays pure/synchronous — it is built on the spawn path and rebuilt on
 * every cold resume, neither of which should do config I/O.
 *
 * `allowedTools` is deliberately left UNDEFINED: the Personal AI runs on the user's
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
export function personalAiProfile(name: string, skillsIndex?: string, memoryContext?: string): SessionProfile {
  const skillsSection = skillsIndex?.trim() ? `\n\n${skillsIndex}` : ''
  const memorySection = memoryContext?.trim() ? `\n\n${memoryContext}` : ''
  return mergeProfiles(
    {
      systemPrompt: `${buildRoleSection(name)}${memorySection}${skillsSection}`,
      systemPromptMode: 'replace',
    },
    walnutMcpProfile(),
  )!
}

/**
 * Lane profile for a NON-general console agent (mentor, note-agent, custom
 * ones): the agent's OWN persona replaces the Personal AI identity, then gets
 * the same two work modes. `contextBlock` carries whatever the agent's context
 * sources resolve to (its own memory etc.); the caller does the I/O.
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
      systemPrompt: `${persona}\n\n${buildWorkModesSection()}${contextSection}${skillsSection}`,
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
