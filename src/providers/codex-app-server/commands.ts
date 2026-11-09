/**
 * The slash commands a direct Codex session answers itself, as the codex-acp adapter
 * did (its CodexCommands): a message that starts with one of these names is a command,
 * never text for the model. `$skill` names and anything else go to Codex as written.
 *
 * - /plan toggles plan mode (the collaboration_mode option)
 * - /compact runs Codex's own compaction (thread/compact/start)
 * - /review [instructions], /review-branch <branch>, /review-commit <sha> run a review turn
 * - /status, /mcp, /skills answer with a short text
 * - /goal and /logout say how to reach them (the adapter has them; this client does not)
 */

import { CODEX_COMMANDS } from '../../core/agents/codex-slash-commands.js'
import type { AppServerRpc } from './rpc.js'
import type { CodexSessionControls } from './controls.js'
import type { AcpUpdate } from './events.js'

const LIST_TIMEOUT_MS = 20_000

export interface SlashCommand { name: string; rest: string }

export type CommandStart =
  | { kind: 'compact' }
  | { kind: 'review'; target: Record<string, unknown> }

export type CommandPlan =
  | { kind: 'turn'; start: CommandStart }
  | { kind: 'plan' }
  | { kind: 'status' | 'mcp' | 'skills' }
  | { kind: 'say'; text: string }

export { CODEX_COMMANDS }

const KNOWN = new Set(CODEX_COMMANDS.map((c) => c.name))

/** The command a message is, read as the adapter read it: a leading `/name`, case-insensitive. */
export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const body = trimmed.slice(1).trim()
  const [name] = body.split(/\s+/)
  if (!name || !KNOWN.has(name.toLowerCase())) return null
  return { name: name.toLowerCase(), rest: body.slice(name.length).trim() }
}

const usage = (name: string, needs: string) => `Command "/${name}" requires ${needs}.`
const viaAdapter = (name: string) =>
  `\`/${name}\` is not offered by Walnut's direct Codex client. To use it, run Codex through the codex-acp adapter: set \`engines.codex.transport: acp\` in Walnut's config.yaml.`

/** What a command does. */
export function planCommand(command: SlashCommand): CommandPlan {
  switch (command.name) {
    case 'plan': return command.rest ? { kind: 'say', text: usage('plan', 'no arguments') } : { kind: 'plan' }
    case 'compact': return { kind: 'turn', start: { kind: 'compact' } }
    case 'review':
      return { kind: 'turn', start: { kind: 'review', target: command.rest ? { type: 'custom', instructions: command.rest } : { type: 'uncommittedChanges' } } }
    case 'review-branch':
      return command.rest ? { kind: 'turn', start: { kind: 'review', target: { type: 'baseBranch', branch: command.rest } } } : { kind: 'say', text: usage('review-branch', 'branch name') }
    case 'review-commit':
      return command.rest ? { kind: 'turn', start: { kind: 'review', target: { type: 'commit', sha: command.rest, title: null } } } : { kind: 'say', text: usage('review-commit', 'commit sha') }
    case 'status': case 'mcp': case 'skills': return { kind: command.name }
    case 'logout': return { kind: 'say', text: 'Walnut does not sign Codex out. To sign out, run `codex logout` in a terminal on this host.' }
    default: return { kind: 'say', text: viaAdapter(command.name) }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** `/mcp`: the host's MCP servers, as mcpServerStatus/list lists them. */
export function mcpText(resp: Record<string, unknown>): string {
  const lines = (Array.isArray(resp.data) ? resp.data.filter(isRecord) : []).map((s) => {
    const tools = isRecord(s.tools) ? Object.keys(s.tools).length : 0
    const resources = Array.isArray(s.resources) ? s.resources.length : 0
    return `- ${String(s.name)}: ${tools} tools, ${resources} resources, auth=${String(s.authStatus)}`
  })
  return lines.length > 0 ? ['Configured MCP servers:', ...lines].join('\n') : 'No MCP servers configured.'
}

/** `/skills`: the skills skills/list finds for the session folder. */
export function skillsText(resp: Record<string, unknown>): string {
  const skills = (Array.isArray(resp.data) ? resp.data.filter(isRecord) : [])
    .flatMap((entry) => Array.isArray(entry.skills) ? entry.skills.filter(isRecord) : [])
  const lines = skills.map((skill) => {
    const description = typeof skill.shortDescription === 'string' ? skill.shortDescription : typeof skill.description === 'string' ? skill.description : ''
    return description ? `- ${String(skill.name)}: ${description}` : `- ${String(skill.name)}`
  })
  return lines.length > 0 ? ['Available skills:', ...lines].join('\n') : 'No skills configured.'
}

export interface StatusFacts {
  model?: string
  effort?: string
  mode: string
  collaboration: string
  codexVersion: string
  threadId?: string
  usage?: Record<string, number>
  contextWindow?: number
}

/** `/status`: the session's configuration and its last turn's token use. */
export function statusText(f: StatusFacts): string {
  const lines = [
    `Model: ${f.model ?? 'from the host\'s Codex config'}${f.effort ? ` (reasoning effort ${f.effort})` : ''}`,
    `Mode: ${f.mode}`,
    `Collaboration mode: ${f.collaboration}`,
    `Codex: ${f.codexVersion}`,
  ]
  if (f.threadId) lines.push(`Thread: ${f.threadId}`)
  if (f.usage) {
    const used = f.usage.inputTokens ?? f.usage.totalTokens
    lines.push(`Last turn: ${f.usage.totalTokens ?? 0} tokens${f.contextWindow && used ? ` (context ${Math.round((used / f.contextWindow) * 100)}% of ${f.contextWindow})` : ''}`)
  }
  return lines.join('\n')
}

export interface CommandContext {
  controls: CodexSessionControls
  rpc: AppServerRpc
  cwd: string
  codexVersion: string
  threadId?: string
  lastUsage: { usage?: Record<string, number>; window?: number }
  emit: (update: AcpUpdate) => void
}

/** The words a command answered here (no Codex turn) puts in the chat; /plan also flips plan mode. */
export async function commandAnswer(plan: Exclude<CommandPlan, { kind: 'turn' }>, ctx: CommandContext): Promise<string> {
  if (plan.kind === 'say') return plan.text
  if (plan.kind === 'plan') {
    ctx.controls.set('collaboration_mode', ctx.controls.collaboration === 'plan' ? 'default' : 'plan')
    ctx.emit({ sessionUpdate: 'config_option_update', configOptions: ctx.controls.sessionState().configOptions })
    return ctx.controls.collaboration === 'plan' ? 'Plan mode is on: Codex plans before it changes anything.' : 'Plan mode is off.'
  }
  if (plan.kind === 'status') {
    return statusText({
      model: ctx.controls.model, effort: ctx.controls.effort, mode: ctx.controls.mode.name,
      collaboration: ctx.controls.collaboration, codexVersion: ctx.codexVersion, threadId: ctx.threadId,
      usage: ctx.lastUsage.usage, contextWindow: ctx.lastUsage.window,
    })
  }
  try {
    return plan.kind === 'mcp'
      ? mcpText(await ctx.rpc.request<Record<string, unknown>>('mcpServerStatus/list', {}, LIST_TIMEOUT_MS))
      : skillsText(await ctx.rpc.request<Record<string, unknown>>('skills/list', { cwds: [ctx.cwd] }, LIST_TIMEOUT_MS))
  } catch (error) {
    return `Codex could not list its ${plan.kind === 'mcp' ? 'MCP servers' : 'skills'}: ${error instanceof Error ? error.message : String(error)}`
  }
}
