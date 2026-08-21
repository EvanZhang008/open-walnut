import type { JournalRecord } from './acp-worker/protocol.js'
import type {
  SessionHistoryMessage,
  SessionHistoryTool,
} from '../core/session-history.js'

interface AcpFrame {
  method?: string
  providerRequestId?: string
  params?: {
    update?: AcpUpdate
    toolCall?: {
      toolCallId?: string
      title?: string
      kind?: string
      rawInput?: unknown
    }
    options?: unknown[]
  }
}

interface AcpUpdate {
  sessionUpdate?: string
  messageId?: string | null
  content?: unknown
  toolCallId?: string
  title?: string | null
  kind?: string | null
  status?: string | null
  rawInput?: unknown
  rawOutput?: unknown
  used?: number
  size?: number
}

export type AcpProjectedEvent =
  | {
      type: 'user'
      ts: number
      commandId: string
      walnutMessageId: string
      text: string
      msgId: string
    }
  | {
      type: 'text' | 'thinking'
      ts: number
      commandId: string
      text: string
      msgId: string
    }
  | {
      type: 'tool-use'
      ts: number
      commandId: string
      msgId: string
      toolUseId: string
      toolName: string
      input?: Record<string, unknown>
    }
  | {
      type: 'tool-result'
      ts: number
      commandId: string
      msgId: string
      toolUseId: string
      result: string
      isError: boolean
    }
  | {
      type: 'permission-request'
      ts: number
      requestId: string
      toolName: string
      input?: Record<string, unknown>
      options: unknown[]
    }
  | {
      type: 'permission-resolved'
      ts: number
      requestId: string
      allowed: boolean
    }
  | {
      type: 'usage'
      ts: number
      used: number
      size: number
    }
  | {
      type: 'result'
      ts: number
      commandId: string
      stopReason: string
    }
  | {
      type: 'system'
      ts: number
      commandId: string
      msgId: string
      variant: 'error' | 'info'
      message: string
    }
  | {
      type: 'error'
      ts: number
      commandId: string
      msgId: string
      error: string
    }

interface ToolIdentity {
  msgId: string
  toolUseId: string
}

/**
 * Pure state fold over one ACP journal. The state is entirely derived from
 * records already supplied to project(), so live replay and full history use
 * byte-identical turn/segment identities.
 */
export class AcpJournalProjector {
  private currentCommandId = 'legacy'
  private segmentOrdinal = 0
  private currentSegment: { ordinal: number; providerMessageId?: string } | null = null
  private tools = new Map<string, ToolIdentity>()
  private turnHasError = false
  private terminalCommands = new Set<string>()
  /** providerRequestId → optionId → ACP option `kind`, harvested from the
   *  request frame so an ANSWER can tell an allow from a reject. Dropped as
   *  soon as the request resolves. */
  private permissionOptionKinds = new Map<string, Map<string, string>>()

  constructor(readonly runtimeId: string) {}

  project(record: JournalRecord): AcpProjectedEvent[] {
    if (record.kind === 'meta') return this.projectMeta(record)
    // Legacy records predate source tagging and represent their original live
    // stream. Explicit provider replay/control frames remain diagnostics only.
    if (record.source && record.source !== 'live') return []
    return this.projectFrame(record)
  }

  private projectMeta(record: Extract<JournalRecord, { kind: 'meta' }>): AcpProjectedEvent[] {
    const event = record.event
    switch (event.type) {
      case 'prompt-accepted':
        if (!this.terminalCommands.has(event.commandId)) {
          this.startTurn(event.commandId)
        }
        return [{
          type: 'user',
          ts: record.ts,
          commandId: event.commandId,
          walnutMessageId: event.walnutMessageId,
          text: event.text,
          msgId: this.id(event.commandId, 'user'),
        }]
      case 'steer-accepted':
        // Mid-turn injection: the user message joins the RUNNING turn. Break
        // the current text segment so the reply after the steer renders as a
        // new bubble, but keep the turn identity (no startTurn).
        this.currentSegment = null
        return [{
          type: 'user',
          ts: record.ts,
          commandId: this.currentCommandId,
          walnutMessageId: event.walnutMessageId,
          text: event.text,
          msgId: this.id(this.currentCommandId, 'user', event.walnutMessageId),
        }]
      case 'turn-started':
        if (!this.terminalCommands.has(event.commandId)
          && event.commandId !== this.currentCommandId) {
          this.startTurn(event.commandId)
        }
        return []
      case 'turn-ended': {
        if (this.terminalCommands.has(event.commandId)) return []
        this.terminalCommands.add(event.commandId)
        const out: AcpProjectedEvent[] = []
        if (event.stopReason === 'cancelled' && !this.turnHasError) {
          out.push(this.system(record.ts, event.commandId, 'Turn interrupted by user.'))
        }
        out.push({
          type: 'result',
          ts: record.ts,
          commandId: event.commandId,
          stopReason: event.stopReason,
        })
        this.finishTurn()
        return out
      }
      case 'turn-interrupted': {
        const commandId = event.commandId ?? this.currentCommandId
        if (this.terminalCommands.has(commandId)) return []
        this.terminalCommands.add(commandId)
        const out: AcpProjectedEvent[] = this.turnHasError
          ? []
          : [
              this.system(record.ts, commandId, interruptionMessage(event.reason)),
              {
                type: 'result',
                ts: record.ts,
                commandId,
                stopReason: 'interrupted',
              },
            ]
        this.finishTurn()
        return out
      }
      case 'permission-answered': {
        // `optionId !== null` only means "the user picked SOMETHING" — a REJECT
        // is a non-null optionId too (codex: reject_once / revise_plan /
        // decline), so that test stamped "Approved" on every denial. The
        // request frame's own option list carries each option's ACP `kind`,
        // which is the authoritative signal; the id prefix is the fallback for
        // an answer whose request frame isn't in this fold (mid-journal attach).
        const optionId = event.optionId
        const kind = optionId === null
          ? undefined
          : this.permissionOptionKinds.get(event.providerRequestId)?.get(optionId)
        this.permissionOptionKinds.delete(event.providerRequestId)
        return [{
          type: 'permission-resolved',
          ts: record.ts,
          requestId: event.providerRequestId,
          allowed: optionId !== null
            && !(kind ?? optionId).startsWith('reject'),
        }]
      }
      case 'permission-auto-cancelled':
        this.permissionOptionKinds.delete(event.providerRequestId)
        return [{
          type: 'permission-resolved',
          ts: record.ts,
          requestId: event.providerRequestId,
          allowed: false,
        }]
      case 'error': {
        this.turnHasError = true
        const commandId = event.commandId ?? this.currentCommandId
        return [{
          type: 'error',
          ts: record.ts,
          commandId,
          msgId: this.id(commandId, 'error'),
          error: `${event.errorKind}: ${event.message}`,
        }]
      }
      default:
        return []
    }
  }

  private projectFrame(record: Extract<JournalRecord, { kind: 'acp' }>): AcpProjectedEvent[] {
    const frame = record.frame as AcpFrame
    if (!frame || typeof frame !== 'object') return []
    if (frame.method === 'session/request_permission') {
      const params = frame.params
      if (!frame.providerRequestId || !params?.toolCall) return []
      this.permissionOptionKinds.set(frame.providerRequestId, optionKinds(params.options))
      return [{
        type: 'permission-request',
        ts: record.ts,
        requestId: frame.providerRequestId,
        toolName: params.toolCall.title ?? params.toolCall.kind ?? 'tool',
        input: asInput(params.toolCall.rawInput),
        options: params.options ?? [],
      }]
    }
    if (frame.method !== 'session/update') return []
    const update = frame.params?.update
    if (!update?.sessionUpdate) return []
    const commandId = this.currentCommandId

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const text = contentText(update.content)
        if (!text) return []
        const segment = this.ensureSegment(update.messageId ?? undefined)
        return [{
          type: update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thinking',
          ts: record.ts,
          commandId,
          text,
          msgId: this.segmentId(commandId, segment.ordinal),
        }]
      }
      case 'tool_call': {
        if (!update.toolCallId) return []
        const segment = this.allocateSegment()
        const identity = {
          msgId: this.segmentId(commandId, segment.ordinal),
          // Codex recycles short toolCallIds (call_0..call_7) for DIFFERENT tools
          // within one turn, so the raw id alone collides. The segment ordinal —
          // unique and monotonic per turn — disambiguates each call INSTANCE. The
          // map stays keyed by raw toolCallId; call→completed→next-call is
          // serialized, so tool_call_update resolves the right instance value.
          toolUseId: this.id(commandId, 'tool', String(segment.ordinal), update.toolCallId),
        }
        this.tools.set(update.toolCallId, identity)
        this.currentSegment = null
        return [{
          type: 'tool-use',
          ts: record.ts,
          commandId,
          ...identity,
          toolName: update.title ?? update.kind ?? 'tool',
          input: asInput(update.rawInput),
        }]
      }
      case 'tool_call_update': {
        if (!update.toolCallId
          || (update.status !== 'completed' && update.status !== 'failed')) return []
        const orphanOrdinal = this.segmentOrdinal
        const identity = this.tools.get(update.toolCallId) ?? {
          msgId: this.segmentId(commandId, this.allocateSegment().ordinal),
          toolUseId: this.id(commandId, 'tool', String(orphanOrdinal), update.toolCallId),
        }
        this.tools.set(update.toolCallId, identity)
        this.currentSegment = null
        return [{
          type: 'tool-result',
          ts: record.ts,
          commandId,
          ...identity,
          result: toolResultText(update),
          isError: update.status === 'failed',
        }]
      }
      case 'usage_update':
        return typeof update.used === 'number' && typeof update.size === 'number'
          ? [{ type: 'usage', ts: record.ts, used: update.used, size: update.size }]
          : []
      default:
        return []
    }
  }

  private startTurn(commandId: string): void {
    this.currentCommandId = commandId
    this.segmentOrdinal = 0
    this.currentSegment = null
    this.tools.clear()
    this.turnHasError = false
  }

  private finishTurn(): void {
    this.currentSegment = null
    this.tools.clear()
    this.turnHasError = false
  }

  private ensureSegment(providerMessageId?: string): { ordinal: number; providerMessageId?: string } {
    if (this.currentSegment
      && (!providerMessageId
        || !this.currentSegment.providerMessageId
        || providerMessageId === this.currentSegment.providerMessageId)) {
      if (providerMessageId && !this.currentSegment.providerMessageId) {
        this.currentSegment.providerMessageId = providerMessageId
      }
      return this.currentSegment
    }
    return this.allocateSegment(providerMessageId)
  }

  private allocateSegment(providerMessageId?: string): { ordinal: number; providerMessageId?: string } {
    const segment = { ordinal: this.segmentOrdinal++, ...(providerMessageId ? { providerMessageId } : {}) }
    this.currentSegment = segment
    return segment
  }

  private system(ts: number, commandId: string, message: string): Extract<AcpProjectedEvent, { type: 'system' }> {
    return {
      type: 'system',
      ts,
      commandId,
      msgId: this.id(commandId, 'system'),
      variant: 'error',
      message,
    }
  }

  private segmentId(commandId: string, ordinal: number): string {
    return this.id(commandId, 'segment', String(ordinal))
  }

  private id(commandId: string, ...parts: string[]): string {
    return ['acp', this.runtimeId, commandId, ...parts].join(':')
  }
}

/** Per-tool-result cap in the HISTORY DTO — parity with the native parser
 *  (parseSessionMessages slices tool results to 5000 chars). ACP rawOutput had
 *  no cap, so one turn of fat tool output could dominate a projected history
 *  (measured: 100 MB journal → 14.5 MB projected without the cap, 3.9 MB with).
 *  Live streaming (AcpStreamNormalizer) is NOT capped here — this applies only
 *  where the fold materializes the history DTO. */
const TOOL_RESULT_MAX_CHARS = 5000

/**
 * Stateful, incremental fold from journal records to the history DTO. One
 * instance can keep absorbing appended records across calls — the journal is
 * append-only, so a cached fold continues exactly where it stopped (this is
 * what makes whale journals cheap: only new bytes are ever re-projected).
 * `projectAcpJournalHistory` remains the one-shot wrapper.
 */
export class AcpHistoryFold {
  private readonly projector: AcpJournalProjector
  private readonly byMessageId = new Map<string, SessionHistoryMessage>()
  private readonly tools = new Map<string, SessionHistoryTool>()
  /** Rough resident-size gauge for cache budgeting (chars pushed, not bytes). */
  charCount = 0
  readonly messages: SessionHistoryMessage[] = []

  constructor(readonly runtimeId: string) {
    this.projector = new AcpJournalProjector(runtimeId)
  }

  push(record: JournalRecord): void {
    for (const event of this.projector.project(record)) {
      const timestamp = new Date(event.ts).toISOString()
      switch (event.type) {
        case 'user': {
          const message: SessionHistoryMessage = {
            role: 'user',
            text: event.text,
            timestamp,
            msgId: event.msgId,
            walnutMessageId: event.walnutMessageId,
          }
          this.messages.push(message)
          this.byMessageId.set(event.msgId, message)
          this.charCount += event.text.length
          break
        }
        case 'text':
        case 'thinking': {
          let message = this.byMessageId.get(event.msgId)
          if (!message) {
            message = { role: 'assistant', text: '', timestamp, msgId: event.msgId }
            this.messages.push(message)
            this.byMessageId.set(event.msgId, message)
          }
          if (event.type === 'text') message.text += event.text
          else message.thinking = (message.thinking ?? '') + event.text
          this.charCount += event.text.length
          break
        }
        case 'tool-use': {
          const tool: SessionHistoryTool = {
            name: event.toolName,
            input: event.input ?? {},
            toolUseId: event.toolUseId,
          }
          const message: SessionHistoryMessage = {
            role: 'assistant',
            text: '',
            timestamp,
            msgId: event.msgId,
            tools: [tool],
          }
          this.messages.push(message)
          this.byMessageId.set(event.msgId, message)
          this.tools.set(event.toolUseId, tool)
          break
        }
        case 'tool-result': {
          let tool = this.tools.get(event.toolUseId)
          if (!tool) {
            tool = {
              name: 'tool',
              input: {},
              toolUseId: event.toolUseId,
            }
            this.messages.push({
              role: 'assistant',
              text: '',
              timestamp,
              msgId: event.msgId,
              tools: [tool],
            })
            this.tools.set(event.toolUseId, tool)
          }
          tool.result = event.result.slice(0, TOOL_RESULT_MAX_CHARS)
          if (event.isError) tool.isError = true
          this.charCount += tool.result.length
          break
        }
        case 'system':
          this.messages.push({
            role: 'system',
            text: event.message,
            timestamp,
            msgId: event.msgId,
            systemVariant: event.variant,
          })
          this.charCount += event.message.length
          break
        case 'error':
          this.messages.push({
            role: 'system',
            text: event.error,
            timestamp,
            msgId: event.msgId,
            systemVariant: 'error',
          })
          this.charCount += event.error.length
          break
        default:
          break
      }
    }
  }
}

/** Fold a complete journal into the existing session history DTO. */
export function projectAcpJournalHistory(
  runtimeId: string,
  records: JournalRecord[],
): SessionHistoryMessage[] {
  const fold = new AcpHistoryFold(runtimeId)
  for (const record of recoverLegacyUserPrompts(records)) fold.push(record)
  return fold.messages
}

/**
 * Restore user turns lost by legacy-schema journals, without touching modern ones.
 *
 * Journals written before the `prompt-accepted` meta record existed carry no user
 * text in their turn timeline: the only per-turn fact is `command-accepted
 * {op:'prompt'}`, which records the commandId but NOT the prompt text. The text
 * survives solely inside the provider's `session/load` replay burst (a run of
 * `user_message_chunk` frames), which the projector otherwise discards as non-live
 * — so on replay every legacy user turn was silently dropped.
 *
 * This pre-pass synthesizes the `prompt-accepted` record the projector already
 * understands for each legacy prompt command, sourcing the text by position from
 * the most complete replay burst. Two guards keep modern journals byte-identical:
 * modern journals never emit `command-accepted {op:'prompt'}` (prompts go straight
 * to `prompt-accepted`), so they never enter this path; and any command that
 * already has a real `prompt-accepted` is skipped, so a journal carrying BOTH
 * record kinds for one prompt can never double-emit the user message.
 */
export function recoverLegacyUserPrompts(records: JournalRecord[]): JournalRecord[] {
  const acceptedCommands = new Set<string>()
  let hasLegacyPromptCommand = false
  for (const record of records) {
    if (record.kind !== 'meta') continue
    if (record.event.type === 'prompt-accepted') {
      acceptedCommands.add(record.event.commandId)
    } else if (record.event.type === 'command-accepted' && record.event.op === 'prompt') {
      hasLegacyPromptCommand = true
    }
  }
  if (!hasLegacyPromptCommand) return records

  const recoveredTexts = recoverReplayUserTexts(records)
  if (recoveredTexts.length === 0) return records

  const out: JournalRecord[] = []
  let cursor = 0
  for (const record of records) {
    if (record.kind === 'meta'
      && record.event.type === 'command-accepted'
      && record.event.op === 'prompt'
      && !acceptedCommands.has(record.event.commandId)
      && cursor < recoveredTexts.length) {
      const commandId = record.event.commandId
      out.push({
        kind: 'meta',
        ts: record.ts,
        event: {
          type: 'prompt-accepted',
          commandId,
          // Legacy journals never persisted the queue id; the commandId is the only
          // stable per-turn key and history replay does not echo-claim against it.
          walnutMessageId: commandId,
          text: recoveredTexts[cursor++],
        },
      })
    }
    out.push(record)
  }
  return out
}

/**
 * Ordered user texts from the most complete `session/load` replay burst. Each load
 * replays the provider's full conversation as one maximal run of ACP frames between
 * meta records; live turns never journal `user_message_chunk`, so only replay runs
 * contribute. Self-report control prompts that the provider retained as user turns
 * are excluded so they neither pollute history nor shift the positional pairing.
 */
function recoverReplayUserTexts(records: JournalRecord[]): string[] {
  let best: string[] = []
  let current: string[] = []
  const flush = (): void => {
    if (current.length > best.length) best = current
    current = []
  }
  for (const record of records) {
    if (record.kind === 'meta') { flush(); continue }
    const text = replayUserText(record)
    if (text !== null) current.push(text)
  }
  flush()
  return best
}

function replayUserText(record: Extract<JournalRecord, { kind: 'acp' }>): string | null {
  const frame = record.frame as AcpFrame
  const update = frame?.params?.update
  if (!update || update.sessionUpdate !== 'user_message_chunk') return null
  const text = contentText(update.content)
  if (!text || isSelfReportPrompt(text)) return null
  return text
}

/** Anchor on the fixed opening of buildSelfReportPrompt() (src/core/session-hooks). */
function isSelfReportPrompt(text: string): boolean {
  return text.startsWith('You just finished a turn. Update this task')
}

function contentText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content]
  return blocks
    .filter((block): block is { type: string; text: string } =>
      !!block && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('')
}

function asInput(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** optionId → ACP option `kind` (allow_once | allow_always | reject_once | reject_always). */
function optionKinds(options: unknown[] | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const option of options ?? []) {
    if (!option || typeof option !== 'object') continue
    const { optionId, kind } = option as { optionId?: unknown; kind?: unknown }
    if (typeof optionId === 'string' && typeof kind === 'string') out.set(optionId, kind)
  }
  return out
}

function toolResultText(update: AcpUpdate): string {
  if (update.rawOutput !== undefined) {
    return typeof update.rawOutput === 'string'
      ? update.rawOutput
      : JSON.stringify(update.rawOutput)
  }
  return contentText(update.content) || update.status || ''
}

function interruptionMessage(reason: string): string {
  switch (reason) {
    case 'dispatch-indeterminate':
      return 'Prompt delivery is uncertain after a worker crash. Check the provider thread before retrying to avoid duplicate work.'
    case 'daemon-restart':
      return 'Turn interrupted: the session host restarted. Send a message to continue.'
    case 'shutdown':
      return 'Turn interrupted: the session was shut down.'
    case 'user-cancelled':
      return 'Turn interrupted by user.'
    default:
      return 'Turn interrupted: the session worker crashed. Send a message to continue.'
  }
}
