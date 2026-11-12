/**
 * Session profile presets — the named launch bundles a session can carry.
 *
 * A `SessionProfile` (core/types.ts) is expanded into `claude` CLI args at every
 * spawn INCLUDING cold `--resume`, so a preset here defines an identity that
 * survives the CLI process being reaped. Keep presets pure (no I/O): they are
 * built on the spawn path, and the resume path rebuilds them from the record.
 */

import path from 'node:path'
import { buildRoleSection, buildWorkModesSection } from './persona-sections.js'
import { PromptComposer, promptRollback, type ComposedBlock, type PromptOverflow } from './prompt-blocks.js'

/** The heading the standing memory puts MEMORY.md under (personal-ai-lane.ts laneMemoryContextOf). */
export const GLOBAL_MEMORY_HEADING = '### Global memory (memory/MEMORY.md)'
import { WORK_PLACE_RULE } from '../work-place.js'
import { TEAM_CHARTER } from '../team-charter.js'
import { TASK_ROUTING_CONTRACT } from '../task-routing-contract.js'
import type { SessionProfile } from '../types.js'

/**
 * The walnut CLI entry of THIS running install, when identifiable.
 *
 * The bare bin name `open-walnut` proved unreliable: whether it exists on
 * PATH depends on how the package was linked (this very machine only links
 * `walnut`), and a dead command means the MCP mount silently never comes up —
 * the session falls back to raw curl. The server process IS the CLI
 * (`bun dist/cli.js web ...`, `bun src/cli.ts web ...` from source, the
 * compiled file, whose argv[1] is its own entry `/$bunfs/root/walnut`), so its
 * own argv[1] is the one entry we can trust absolutely, run by its own
 * runtime (process.execPath). Guarded by a basename allowlist so a test runner
 * (vitest) is never mistaken for the CLI.
 */
export function cliEntryOf(argv1: string | undefined): string | null {
  if (!argv1) return null
  const base = path.basename(argv1)
  return base === 'cli.js' || base === 'cli.ts' || base === 'open-walnut.js' || base === 'walnut.js' || base === 'open-walnut' || base === 'walnut'
    ? path.resolve(argv1)
    : null
}

const CLI_ENTRY: string | null = cliEntryOf(process.argv[1])

/**
 * Mount the Walnut MCP server into a session, giving the CLI structured access
 * to tasks / projects / sessions / search instead of prose instructions. The
 * mount targets this install's own CLI entry via the running bun or walnut file
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
 * Persona precedence header for APPEND-mode profiles.
 *
 * Persona profiles ride `--append-system-prompt` (NOT `--system-prompt`): a
 * full replace throws away the CLI's whole default prompt — verified in the CLI
 * source, that means the env block (today's date / cwd / platform / model),
 * gitStatus, the MCP servers' `instructions` section (the walnut mount's usage
 * note among them), the tool-orchestration / tone / output-efficiency
 * guidance, and the CLI's own memory prompt. (CLAUDE.md/AGENTS.md and the
 * Skill tool's listing were never affected — they ride userContext and the
 * tool schema, not the system prompt.) Append keeps all of that (the same
 * pattern the CLI itself uses for custom agents) and layers the persona on
 * top — this header settles the identity conflict explicitly: persona wins on
 * WHO/HOW-TO-SPEAK, the default prompt keeps authority on tools and safety.
 */
function personaPrecedenceHeader(): string {
  return `${PERSONA_PRECEDENCE_OPENING}

The sections below define WHO YOU ARE and HOW YOU SPEAK. Where they conflict with the coding-agent identity, tone, or response-length rules above, this persona wins. Everything else above still applies: keep following the tool-usage and safety guidance, and use the environment info (working directory, today's date, platform) given above.`
}
const PERSONA_PRECEDENCE_OPENING = '## Persona override'

/**
 * The Personal AI's own profile — an appended persona system prompt plus the
 * Walnut MCP mount, i.e. "the Personal AI is just a session with a profile".
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
 *
 * `withSessionContext`: Walnut's session context rides beside this persona (a task session on
 * the native engine), and it carries where work lives, the charter and the routing rules: the
 * persona leaves them out (one copy per prompt). Every block is held to its cap (prompt-blocks.ts);
 * what a cap moved is in `overflows`, for the caller to write to the memory folder.
 */
export function personalAiPersona(
  name: string, skillsIndex?: string, memoryContext?: string, opts: { withSessionContext?: boolean; uncapped?: boolean } = {},
): ComposedPersona {
  const c = new PromptComposer(opts)
    .add('persona', `${personaPrecedenceHeader()}\n\n${buildRoleSection(name, { withSessionContext: true })}\n\n`)
  if (!besideSessionContext(opts)) addSessionRules(c)
  const memory = splitStandingMemory(memoryContext)
  c.add('standing-user', blockOf(memory.head)).add('standing-memory', blockOf(memory.memory)).add('skills-index', blockOf(skillsIndex))
  return { systemPrompt: c.text().trimEnd(), overflows: c.overflows, blocks: c.blocks }
}

/**
 * The standing memory as two blocks: its head lines with USER.md (when the persona carries it),
 * then the global MEMORY.md, so a long MEMORY.md moves to the folder and never takes the user's
 * profile with it. Text with no MEMORY.md heading is all head.
 */
function splitStandingMemory(text: string | undefined): { head: string; memory: string } {
  const t = text?.trim() ?? ''
  const at = t.indexOf(`\n\n${GLOBAL_MEMORY_HEADING}`)
  return at < 0 ? { head: t, memory: '' } : { head: t.slice(0, at), memory: t.slice(at + 2) }
}

/** A persona as built: its prompt, the blocks it is made of, and what their caps moved. */
export type ComposedPersona = { systemPrompt: string; overflows: PromptOverflow[]; blocks: ComposedBlock[] }

export function personalAiProfile(name: string, skillsIndex?: string, memoryContext?: string, opts: { withSessionContext?: boolean } = {}): SessionProfile {
  return mergeProfiles(
    { systemPrompt: personalAiPersona(name, skillsIndex, memoryContext, opts).systemPrompt, systemPromptMode: 'append' },
    walnutMcpProfile(),
  )!
}

/** The persona leaves out what the session context carries; under the rollback switch it never does (as before). */
const besideSessionContext = (opts: { withSessionContext?: boolean }): boolean => !!opts.withSessionContext && !promptRollback()

/**
 * Whether a stored persona was built beside Walnut's session context (it left the charter out):
 * the mint's own decision, read back from what it stamped, for a session whose spawn prompt is
 * not stored yet (personal-ai-lane.ts hasWalnutContext). Only a Walnut persona answers yes.
 */
export function personaBuiltBesideSessionContext(systemPrompt: string | undefined): boolean {
  if (!systemPrompt || !systemPrompt.includes(PERSONA_PRECEDENCE_OPENING)) return false
  return !systemPrompt.includes(TEAM_CHARTER_OPENING)
}
// The charter's first sentence: its heading alone could be the user's own words in USER.md.
const TEAM_CHARTER_OPENING = TEAM_CHARTER.split('\n').find((l) => l.length > 40)!

/** A block of the persona after its head ('' when there is none). */
const blockOf = (text: string | undefined): string => (text?.trim() ? `${text.trim()}\n\n` : '')

/** The rules Walnut's session context carries, for a persona that rides without it (an ACP engine, a taskless lane). */
function addSessionRules(c: PromptComposer): PromptComposer {
  return c.add('where-work-lives', `${WORK_PLACE_RULE}\n\n`).add('how-we-work', `${TEAM_CHARTER}\n\n`)
    .add('task-routing', `${TASK_ROUTING_CONTRACT}\n\n`)
}

/**
 * Lane profile for a NON-general console agent (mentor, note-agent, custom
 * ones): the agent's OWN persona replaces the Personal AI identity, then gets
 * the same two work modes. `contextBlock` carries whatever the agent's context
 * sources resolve to (its own memory etc.); the caller does the I/O.
 */
export function consoleAgentPersona(
  agentDef: { id: string; name: string; system_prompt?: string },
  skillsIndex?: string,
  contextBlock?: string,
  opts: { withSessionContext?: boolean; uncapped?: boolean } = {},
): ComposedPersona {
  const persona = agentDef.system_prompt?.trim() || `You are ${agentDef.name}.`
  const c = new PromptComposer(opts)
    .add('agent-persona', `${personaPrecedenceHeader()}\n\n${persona}\n\n`)
    .add('persona', `${buildWorkModesSection({ withSessionContext: true })}\n\n`)
  if (!besideSessionContext(opts)) addSessionRules(c)
  c.add('agent-context', blockOf(contextBlock)).add('skills-index', blockOf(skillsIndex))
  return { systemPrompt: c.text().trimEnd(), overflows: c.overflows, blocks: c.blocks }
}

export function consoleAgentProfile(
  agentDef: { id: string; name: string; system_prompt?: string },
  skillsIndex?: string,
  contextBlock?: string,
  opts: { withSessionContext?: boolean } = {},
): SessionProfile {
  return mergeProfiles(
    { systemPrompt: consoleAgentPersona(agentDef, skillsIndex, contextBlock, opts).systemPrompt, systemPromptMode: 'append' },
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
