/**
 * Codex app-server notifications as the ACP `session/update`s the codex-acp
 * adapter sent Walnut, field for field where Walnut reads them
 * (acp-journal-projector.ts, acp-session.ts meterTurnSpeed), so a direct
 * session's journal reads the same as an adapter session's and an older journal
 * stays readable. Titles and kinds follow the adapter's builders.
 */

import fs from 'node:fs'
import { applyPatch, parsePatch, reversePatch } from 'diff'

export type AcpUpdate = Record<string, unknown> & { sessionUpdate: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

export function toAcpStatus(status: unknown): 'in_progress' | 'completed' | 'failed' {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'declined') return 'failed'
  return 'in_progress'
}

/** `bash -lc 'ls'` reads as `ls` in a title (the adapter's stripShellPrefix). */
export function stripShellPrefix(command: string): string {
  const stripped = command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/, '')
  return stripped.length >= 2 && stripped.startsWith("'") && stripped.endsWith("'") ? stripped.slice(1, -1) : stripped
}

function searchTitle(query: string | undefined, path: string | undefined): string {
  if (query && path) return `Search for '${query}' in ${path}`
  if (query) return `Search for '${query}'`
  if (path) return `Search in '${path}'`
  return 'Search'
}

export function webSearchTitle(item: Record<string, unknown>): string {
  const action = isRecord(item.action) ? item.action : undefined
  const query = str(item.query)
  if (!action) return query ? `Web search: ${query}` : 'Web search'
  switch (action.type) {
    case 'search': {
      const queries = Array.isArray(action.queries) ? action.queries.filter((q): q is string => typeof q === 'string' && q !== '') : []
      const q = str(action.query) ?? (queries.length > 0 ? queries.join(', ') : undefined) ?? query
      return q ? `Web search: ${q}` : 'Web search'
    }
    case 'openPage': return str(action.url) ? `Open page: ${action.url}` : 'Open page'
    case 'findInPage': {
      const pattern = str(action.pattern)?.trim()
      const url = str(action.url)?.trim()
      return ['Find in page', pattern ? `for '${pattern}'` : '', url ? `in ${url}` : ''].filter(Boolean).join(' ')
    }
    default: return 'Web search'
  }
}

/** One fileChange entry as an ACP diff block, or undefined when it cannot be shown. */
export function patchContent(change: Record<string, unknown>): Record<string, unknown> | undefined {
  const path = str(change.path)
  const diff = str(change.diff) ?? ''
  const kind = isRecord(change.kind) ? str(change.kind.type) : undefined
  if (!path) return undefined
  if (kind === 'add') return { type: 'diff', oldText: null, newText: diff, path, _meta: { kind: 'add' } }
  if (kind === 'delete') return { type: 'diff', oldText: diff, newText: '', path, _meta: { kind: 'delete' } }
  if (kind !== 'update') return undefined
  const movePath = isRecord(change.kind) ? str(change.kind.move_path) : undefined
  const unified = diff.replace(/\n\nMoved to: .*$/, '')
  const read = (p: string): string | undefined => { try { return fs.readFileSync(p, 'utf8') } catch { return undefined } }
  const reverted = (text: string): string | undefined => {
    try {
      const parsed = parsePatch(unified)[0]
      if (!parsed) return undefined
      const out = applyPatch(text, reversePatch(parsed))
      return out === false ? undefined : out
    } catch { return undefined }
  }
  const current = read(path)
  if (current !== undefined) {
    let patched: string | false = false
    try { patched = applyPatch(current, unified) } catch { patched = false }
    if (patched !== false) return { type: 'diff', oldText: current, newText: patched, path: movePath ?? path, _meta: { kind: 'update' } }
    // Codex already wrote it: the file on disk is the new text.
    const old = reverted(current)
    return old === undefined ? undefined : { type: 'diff', oldText: old, newText: current, path, _meta: { kind: 'update' } }
  }
  if (movePath) {
    const moved = read(movePath)
    const old = moved === undefined ? undefined : reverted(moved)
    if (moved !== undefined && old !== undefined) return { type: 'diff', oldText: old, newText: moved, path: movePath, _meta: { kind: 'update' } }
  }
  return undefined
}

export class CodexEventMapper {
  private phases = new Map<string, string>()
  private streamedReasoning = new Set<string>()
  private terminalCommands = new Set<string>()
  private commandsWithOutput = new Set<string>()
  private emittedImageViews = new Set<string>()
  private emittedSubagents = new Set<string>()
  private planText = new Map<string, string>()
  private running = new Set<string>()
  /** Warnings already shown by this app-server: Codex repeats some on every turn. */
  private warned = new Set<string>()
  /** The last started MCP call per server, for an elicitation that approves it. */
  readonly mcpCallByServer = new Map<string, string>()

  constructor(private readonly emit: (update: AcpUpdate) => void) {}

  /** A command, tool or edit runs (the stall watchdog then waits longer). */
  get itemRunning(): boolean { return this.running.size > 0 }

  beginTurn(): void { this.running.clear() }
  /** A Codex turn ended: its items' bookkeeping goes (a long-lived worker would keep it all otherwise). */
  endTurn(): void {
    this.running.clear(); this.planText.clear(); this.phases.clear(); this.streamedReasoning.clear()
    this.terminalCommands.clear(); this.commandsWithOutput.clear(); this.emittedImageViews.clear()
  }

  onNotification(method: string, p: Record<string, unknown>): void {
    switch (method) {
      case 'item/agentMessage/delta': {
        const itemId = str(p.itemId)
        const phase = itemId ? this.phases.get(itemId) : undefined
        this.emit({
          sessionUpdate: 'agent_message_chunk', messageId: itemId, content: { type: 'text', text: str(p.delta) ?? '' },
          ...(phase ? { _meta: { codex: { phase } } } : {}),
        })
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryPartAdded': {
        const itemId = str(p.itemId)
        if (itemId) this.streamedReasoning.add(itemId)
        const text = method === 'item/reasoning/summaryPartAdded' ? '\n\n' : str(p.delta) ?? ''
        this.emit({ sessionUpdate: 'agent_thought_chunk', messageId: itemId, content: { type: 'text', text } })
        return
      }
      case 'item/commandExecution/outputDelta':
      case 'item/commandExecution/terminalInteraction': {
        const itemId = str(p.itemId)
        if (!itemId) return
        const data = method === 'item/commandExecution/outputDelta' ? str(p.delta) ?? '' : `\n${str(p.stdin) ?? ''}\n`
        if (data && this.terminalCommands.has(itemId)) this.commandsWithOutput.add(itemId)
        this.emit({ sessionUpdate: 'tool_call_update', toolCallId: itemId, _meta: { terminal_output_delta: { data, terminal_id: itemId } } })
        return
      }
      case 'item/mcpToolCall/progress': {
        const itemId = str(p.itemId)
        if (itemId) this.emit({ sessionUpdate: 'tool_call_update', toolCallId: itemId, _meta: { mcp_output_delta: { data: (str(p.message) ?? '').trim() } } })
        return
      }
      case 'item/plan/delta': {
        const itemId = str(p.itemId)
        if (itemId) this.planText.set(itemId, (this.planText.get(itemId) ?? '') + (str(p.delta) ?? ''))
        return
      }
      case 'turn/plan/updated': {
        const plan = Array.isArray(p.plan) ? p.plan.filter(isRecord) : []
        this.emit({
          sessionUpdate: 'plan',
          entries: plan.map((s) => ({ status: s.status === 'inProgress' ? 'in_progress' : s.status, content: s.step, priority: 'medium' })),
        })
        return
      }
      case 'thread/tokenUsage/updated': {
        const usage = isRecord(p.tokenUsage) ? p.tokenUsage : {}
        const last = isRecord(usage.last) ? usage.last : {}
        const used = typeof last.totalTokens === 'number' ? last.totalTokens : undefined
        const size = typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : undefined
        if (used !== undefined && size !== undefined && size > 0) this.emit({ sessionUpdate: 'usage_update', used, size })
        return
      }
      case 'error': {
        const error = isRecord(p.error) ? p.error : {}
        if (p.willRetry === true) {
          this.emit({ sessionUpdate: 'session_info_update', _meta: { codex: { error: { ...error, turnId: p.turnId, willRetry: true } } } })
          return
        }
        // The provider's own words end the answer, as the adapter showed them (a usage limit's reset is
        // read from them), in a block of their own so they never run on from the reply's last words.
        const message = str(error.message)
        if (message) this.emit({ sessionUpdate: 'agent_message_chunk', messageId: `codex-error:${str(p.turnId) ?? 'turn'}`, content: { type: 'text', text: `${message}\n\n` } })
        return
      }
      case 'thread/compacted':
        this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '*Context compacted to fit the model\'s context window.*\n\n' } })
        return
      case 'warning': {
        const message = str(p.message)
        if (!message || this.warned.has(message)) return
        if (this.warned.size < 64) this.warned.add(message)
        this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Warning: ${message}\n\n` } })
        return
      }
      case 'configWarning': {
        const summary = str(p.summary)
        if (!summary) return
        const details = str(p.details)
        this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Config warning: ${summary}${details ? `\n\n${details}` : ''}\n\n` } })
        return
      }
      case 'model/rerouted':
        this.emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `Model rerouted from ${str(p.fromModel)} to ${str(p.toModel)} (${str(p.reason)}).\n\n` } })
        return
      case 'thread/name/updated':
        this.emit({ sessionUpdate: 'session_info_update', title: str(p.threadName) ?? null })
        return
      case 'item/started':
        if (isRecord(p.item)) this.itemStarted(p.item)
        return
      case 'item/completed':
        if (isRecord(p.item)) this.itemCompleted(p.item)
        return
      default:
        return
    }
  }

  /** A resumed thread's past turns, as the adapter's load replayed them (sent only when the journal lost them). */
  replayTurns(turns: unknown[]): void {
    for (const turn of turns) {
      const items = isRecord(turn) && Array.isArray(turn.items) ? turn.items.filter(isRecord) : []
      for (const item of items) this.replayItem(item)
    }
  }

  private replayItem(item: Record<string, unknown>): void {
    const id = str(item.id)
    switch (item.type) {
      case 'userMessage':
        for (const input of Array.isArray(item.content) ? item.content.filter(isRecord) : []) {
          const text = input.type === 'text' ? str(input.text)
            : input.type === 'image' ? `[@image](${str(input.url)})`
              : input.type === 'localImage' ? `[@${String(str(input.path) ?? '').split('/').pop()}](file://${str(input.path)})`
                : input.type === 'skill' ? `skill:${str(input.name)} (${str(input.path)})` : undefined
          if (text) this.emit({ sessionUpdate: 'user_message_chunk', messageId: id, content: { type: 'text', text } })
        }
        return
      case 'agentMessage': {
        const phase = str(item.phase)
        this.emit({ sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text: str(item.text) ?? '' }, ...(phase ? { _meta: { codex: { phase } } } : {}) })
        return
      }
      case 'reasoning': {
        const summary = Array.isArray(item.summary) ? item.summary.filter((s): s is string => typeof s === 'string') : []
        const parts = summary.length > 0 ? summary : Array.isArray(item.content) ? item.content.filter((s): s is string => typeof s === 'string') : []
        for (const text of parts) this.emit({ sessionUpdate: 'agent_thought_chunk', messageId: id, content: { type: 'text', text } })
        return
      }
      default:
        this.itemStarted(item, true)
        this.itemCompleted(item, true)
    }
  }

  private itemStarted(item: Record<string, unknown>, replay = false): void {
    const id = str(item.id)
    if (!id) return
    switch (item.type) {
      case 'agentMessage':
        if (str(item.phase)) this.phases.set(id, item.phase as string)
        return
      case 'commandExecution':
        this.running.add(id)
        this.emit(this.commandToolCall(item, id))
        return
      case 'fileChange': {
        this.running.add(id)
        const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : []
        this.emit({
          sessionUpdate: 'tool_call', toolCallId: id, title: 'Editing files', kind: 'edit', status: toAcpStatus(item.status),
          content: replay ? [] : changes.map(patchContent).filter((b): b is Record<string, unknown> => !!b),
        })
        return
      }
      case 'mcpToolCall': {
        this.running.add(id)
        if (str(item.server)) this.mcpCallByServer.set(item.server as string, id)
        const out = item.result != null || item.error != null ? { rawOutput: { result: item.result ?? null, error: item.error ?? null } } : {}
        this.emit({
          sessionUpdate: 'tool_call', toolCallId: id, kind: 'execute', title: `mcp.${str(item.server)}.${str(item.tool)}`, status: toAcpStatus(item.status),
          rawInput: { server: item.server, tool: item.tool, arguments: item.arguments }, ...out, _meta: { is_mcp_tool_call: true },
        })
        return
      }
      case 'dynamicToolCall':
        this.running.add(id)
        this.emit({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'execute', title: str(item.tool) ?? 'tool', status: toAcpStatus(item.status), rawInput: { arguments: item.arguments } })
        return
      case 'imageView': {
        const path = str(item.path) ?? ''
        this.emittedImageViews.add(id)
        this.emit({
          sessionUpdate: 'tool_call', toolCallId: id, kind: 'read', title: `View Image ${path}`, status: 'completed',
          content: [{ type: 'content', content: { type: 'resource_link', name: path, uri: path } }], locations: [{ path }], rawInput: { path },
        })
        return
      }
      case 'imageGeneration':
        this.emit({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'other', title: 'Image generation', status: 'in_progress', rawInput: { id } })
        return
      case 'webSearch':
        this.emit({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'search', title: webSearchTitle(item), status: 'in_progress', rawInput: { type: item.type, id, query: item.query, action: item.action } })
        return
      case 'collabAgentToolCall':
        this.running.add(id)
        this.emit({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'other', title: str(item.tool) ?? 'agent', status: toAcpStatus(item.status), ...this.collab(item) })
        return
      case 'subAgentActivity': {
        this.emittedSubagents.add(id)
        this.emit({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'other', title: subagentTitle(item), status: 'in_progress', ...subagentFields(item) })
        return
      }
      case 'contextCompaction':
        this.running.add(id)
        this.emit({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'think', title: 'Compact conversation', status: 'in_progress', _meta: { contextCompaction: { version: 1 } } })
        return
      default:
        return
    }
  }

  private itemCompleted(item: Record<string, unknown>, replay = false): void {
    const id = str(item.id)
    if (!id) return
    this.running.delete(id)
    switch (item.type) {
      case 'agentMessage':
        if (str(item.phase)) this.phases.set(id, item.phase as string)
        return
      case 'reasoning': {
        if (this.streamedReasoning.delete(id)) return
        const summary = Array.isArray(item.summary) ? item.summary.filter((s): s is string => typeof s === 'string' && s !== '') : []
        const parts = summary.length > 0 ? summary : Array.isArray(item.content) ? item.content.filter((s): s is string => typeof s === 'string' && s !== '') : []
        if (parts.length > 0) this.emit({ sessionUpdate: 'agent_thought_chunk', messageId: id, content: { type: 'text', text: parts.join('\n\n') } })
        return
      }
      case 'plan': {
        const text = str(item.text) || this.planText.get(id) || ''
        this.planText.delete(id)
        if (text) this.emit({ sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text }, _meta: { codex: { phase: 'final_answer' } } })
        return
      }
      case 'commandExecution': {
        if (item.status === 'inProgress' && replay) return
        const output = str(item.aggregatedOutput) ?? ''
        const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
        const terminal = this.terminalCommands.has(id)
        const meta = terminal ? {
          _meta: {
            ...(!this.commandsWithOutput.has(id) && output ? { terminal_output_delta: { data: output, terminal_id: id } } : {}),
            terminal_exit: { exit_code: exitCode, signal: null, terminal_id: id },
          },
        } : {}
        this.commandsWithOutput.delete(id)
        this.emit({
          sessionUpdate: 'tool_call_update', toolCallId: id, status: item.status === 'completed' ? 'completed' : 'failed',
          rawOutput: { formatted_output: output, exit_code: exitCode }, ...meta,
        })
        return
      }
      case 'fileChange':
      case 'dynamicToolCall':
        this.emit({ sessionUpdate: 'tool_call_update', toolCallId: id, status: item.status === 'completed' ? 'completed' : 'failed' })
        return
      case 'mcpToolCall': {
        if (str(item.server) && this.mcpCallByServer.get(item.server as string) === id) this.mcpCallByServer.delete(item.server as string)
        const out = item.result != null || item.error != null ? { rawOutput: { result: item.result ?? null, error: item.error ?? null } } : {}
        this.emit({
          sessionUpdate: 'tool_call_update', toolCallId: id, status: item.status === 'completed' ? 'completed' : 'failed',
          rawInput: { server: item.server, tool: item.tool, arguments: item.arguments }, ...out,
        })
        return
      }
      case 'imageView':
        if (this.emittedImageViews.delete(id)) return
        this.itemStarted(item)
        this.emittedImageViews.delete(id)
        return
      case 'imageGeneration': {
        const content: unknown[] = []
        if (str(item.revisedPrompt)) content.push({ type: 'content', content: { type: 'text', text: `Revised prompt: ${item.revisedPrompt}` } })
        if (str(item.result)?.trim()) content.push({ type: 'content', content: { type: 'image', data: item.result, mimeType: 'image/png', ...(str(item.savedPath) ? { uri: item.savedPath } : {}) } })
        this.emit({
          sessionUpdate: 'tool_call_update', toolCallId: id, status: item.status === 'failed' ? 'failed' : 'completed', content,
          rawOutput: { status: item.status, revisedPrompt: item.revisedPrompt, result: item.result, ...('savedPath' in item ? { savedPath: item.savedPath } : {}) },
        })
        return
      }
      case 'webSearch':
        this.emit({ sessionUpdate: 'tool_call_update', toolCallId: id, title: webSearchTitle(item), status: 'completed', rawInput: { type: item.type, id, query: item.query, action: item.action } })
        return
      case 'collabAgentToolCall':
        this.emit({ sessionUpdate: 'tool_call_update', toolCallId: id, title: str(item.tool) ?? 'agent', status: toAcpStatus(item.status), ...this.collab(item) })
        return
      case 'subAgentActivity':
        if (this.emittedSubagents.delete(id)) this.emit({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' })
        else this.emit({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'other', title: subagentTitle(item), status: 'completed', ...subagentFields(item) })
        return
      case 'contextCompaction':
        this.emit({ sessionUpdate: 'tool_call_update', toolCallId: id, title: 'Compact conversation', status: 'completed', _meta: { contextCompaction: { version: 1 } } })
        return
      case 'exitedReviewMode': {
        const review = str(item.review)?.trim()
        if (review) this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: review } })
        return
      }
      default:
        return
    }
  }

  private commandToolCall(item: Record<string, unknown>, id: string): AcpUpdate {
    const actions = Array.isArray(item.commandActions) ? item.commandActions.filter(isRecord) : []
    const action = actions.length === 1 ? actions[0] : undefined
    const status = toAcpStatus(item.status)
    if (action?.type === 'read' && str(action.path)) {
      return { sessionUpdate: 'tool_call', toolCallId: id, status, kind: 'read', title: `Read file '${action.path}'`, locations: [{ path: action.path }] }
    }
    if (action?.type === 'search') {
      return { sessionUpdate: 'tool_call', toolCallId: id, status, kind: 'search', title: searchTitle(str(action.query), str(action.path)) }
    }
    if (action?.type === 'listFiles') {
      return { sessionUpdate: 'tool_call', toolCallId: id, status, kind: 'read', title: str(action.path) ? `List files in '${action.path}'` : 'List files' }
    }
    const command = (action?.type === 'unknown' ? str(action.command) : undefined) ?? str(item.command) ?? ''
    this.terminalCommands.add(id)
    return {
      sessionUpdate: 'tool_call', toolCallId: id, status, kind: 'execute', title: stripShellPrefix(command),
      content: [{ type: 'terminal', terminalId: id }], rawInput: { command, cwd: item.cwd },
      _meta: { terminal_info: { cwd: item.cwd, terminal_id: id } },
    }
  }

  private collab(item: Record<string, unknown>): Record<string, unknown> {
    return {
      rawInput: {
        prompt: item.prompt, senderThreadId: item.senderThreadId, receiverThreadIds: item.receiverThreadIds,
        agentsStates: item.agentsStates, model: item.model, reasoningEffort: item.reasoningEffort, status: item.status,
      },
      _meta: { codex: { collaboration: { tool: item.tool, senderThreadId: item.senderThreadId, receiverThreadIds: item.receiverThreadIds } } },
    }
  }
}

function subagentName(item: Record<string, unknown>): string {
  return String(str(item.agentPath) ?? '').split('/').filter(Boolean).pop() ?? 'subagent'
}

function subagentTitle(item: Record<string, unknown>): string {
  const name = subagentName(item)
  if (item.kind === 'interacted') return `Interact with subagent ${name}`
  if (item.kind === 'interrupted') return `Interrupt subagent ${name}`
  return `Start subagent ${name}`
}

function subagentFields(item: Record<string, unknown>): Record<string, unknown> {
  return {
    rawInput: { agentThreadId: item.agentThreadId, agentPath: item.agentPath, activityKind: item.kind },
    _meta: { codex: { subagent: { threadId: item.agentThreadId, path: item.agentPath, activity: item.kind } } },
  }
}
