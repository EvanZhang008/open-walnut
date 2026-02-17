/**
 * SdkSession — wraps a single Claude Agent SDK query() call.
 *
 * Each session maintains:
 * - An AsyncGenerator prompt channel for multi-turn input
 * - A canUseTool callback for permission requests and AskUserQuestion
 * - An AbortController for interruption
 * - An output loop that maps SDK messages to session server events
 */

import crypto from 'node:crypto'
import type {
  Query,
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKPartialAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  CanUseTool,
  PermissionResult,
  Options,
  PermissionMode,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  SessionEventName,
  SessionResultSubtype,
  SessionStartParams,
} from './types.js'

// ── Types ──

export interface SdkSessionOptions {
  message: string
  cwd?: string
  mode?: string
  systemPrompt?: string
  sessionId?: string  // Resume existing session
}

export type EventEmitter = (name: SessionEventName, data: unknown) => void

interface PendingInteraction {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

// ── Message channel for multi-turn input ──

interface MessageChannel {
  push(msg: SDKUserMessage): void
  end(): void
  iterable: AsyncIterable<SDKUserMessage>
}

function createMessageChannel(): MessageChannel {
  const queue: SDKUserMessage[] = []
  let resolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null
  let done = false

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false })
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true })
          }
          return new Promise((r) => { resolve = r })
        },
      }
    },
  }

  return {
    push(msg: SDKUserMessage) {
      if (done) return
      if (resolve) {
        const r = resolve
        resolve = null
        r({ value: msg, done: false })
      } else {
        queue.push(msg)
      }
    },
    end() {
      done = true
      if (resolve) {
        const r = resolve
        resolve = null
        r({ value: undefined as unknown as SDKUserMessage, done: true })
      }
    },
    iterable,
  }
}

// ── SdkSession ──

export class SdkSession {
  readonly id: string
  private queryHandle: Query | null = null
  private channel: MessageChannel
  private abortController = new AbortController()
  private emitEvent: EventEmitter
  private _status: 'idle' | 'running' | 'error' = 'idle'
  private _cwd?: string
  private _mode: string
  private _sessionId?: string

  /** Map of pending interactive requests (question/permission) by requestId */
  private pendingInteractions = new Map<string, PendingInteraction>()

  constructor(id: string, emitEvent: EventEmitter) {
    this.id = id
    this.emitEvent = emitEvent
    this.channel = createMessageChannel()
    this._mode = 'default'
  }

  get status(): 'idle' | 'running' | 'error' { return this._status }
  get cwd(): string | undefined { return this._cwd }
  get mode(): string { return this._mode }
  get sessionId(): string | undefined { return this._sessionId }

  /**
   * Start a new query (or resume) and begin streaming events.
   */
  async start(params: SdkSessionOptions): Promise<string> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')

    this._cwd = params.cwd
    this._mode = params.mode ?? 'default'
    this._sessionId = params.sessionId
    this._status = 'running'

    // Build options
    const options: Options = {
      cwd: params.cwd,
      includePartialMessages: true,
      abortController: this.abortController,
    }

    // Permission mode
    if (params.mode === 'bypass') {
      options.permissionMode = 'bypassPermissions' as PermissionMode
      options.allowDangerouslySkipPermissions = true
    } else if (params.mode === 'accept') {
      options.permissionMode = 'acceptEdits' as PermissionMode
    } else if (params.mode === 'plan') {
      options.permissionMode = 'plan' as PermissionMode
    }

    // System prompt
    if (params.systemPrompt) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: params.systemPrompt,
      }
    }

    // Resume
    if (params.sessionId) {
      options.resume = params.sessionId
    }

    // Permission callback — forwards permission requests and AskUserQuestion to Walnut
    options.canUseTool = this.createCanUseTool()

    // Push initial message into the channel
    const initialMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: params.message },
      parent_tool_use_id: null,
      session_id: this._sessionId ?? '',
    }

    // Create query with async iterable prompt for multi-turn
    this.channel = createMessageChannel()

    // For initial query, use the message directly; for multi-turn we'll use streamInput
    this.queryHandle = query({
      prompt: params.message,
      options,
    })

    // Start the output loop in the background
    this.processOutput().catch((err) => {
      this.emitEvent('session:error', {
        sessionId: this._sessionId ?? this.id,
        error: err instanceof Error ? err.message : String(err),
      })
      this._status = 'error'
    })

    // Wait for session init (first message should contain session_id)
    // The output loop will capture the session ID from the init message
    // For now, return the provided sessionId or generate one
    return this._sessionId ?? this.id
  }

  /**
   * Send a follow-up message to the running session.
   *
   * If the session is idle (previous turn completed), starts a new query
   * with `resume: sessionId` — the SDK picks up the existing conversation.
   * If still running mid-turn, uses `streamInput` to inject the message.
   */
  async send(message: string): Promise<void> {
    // If session is idle (previous turn finished, process exited),
    // resume with a fresh query() call
    if (this._status === 'idle' && this._sessionId) {
      await this.resume(message)
      return
    }

    if (!this.queryHandle) {
      throw new Error('Session not started')
    }

    this._status = 'running'

    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: message },
      parent_tool_use_id: null,
      session_id: this._sessionId ?? '',
    }

    // Use streamInput for mid-turn multi-turn
    await this.queryHandle.streamInput((async function* () {
      yield msg
    })())
  }

  /**
   * Resume the session with a new query after the previous turn completed.
   */
  private async resume(message: string): Promise<void> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk')

    this._status = 'running'
    this.abortController = new AbortController()

    const options: Options = {
      cwd: this._cwd,
      includePartialMessages: true,
      abortController: this.abortController,
      resume: this._sessionId,
    }

    // Permission mode
    if (this._mode === 'bypass') {
      options.permissionMode = 'bypassPermissions' as PermissionMode
      options.allowDangerouslySkipPermissions = true
    } else if (this._mode === 'accept') {
      options.permissionMode = 'acceptEdits' as PermissionMode
    } else if (this._mode === 'plan') {
      options.permissionMode = 'plan' as PermissionMode
    }

    options.canUseTool = this.createCanUseTool()

    this.queryHandle = query({
      prompt: message,
      options,
    })

    // Start the output loop in the background
    this.processOutput().catch((err) => {
      this.emitEvent('session:error', {
        sessionId: this._sessionId ?? this.id,
        error: err instanceof Error ? err.message : String(err),
      })
      this._status = 'error'
    })
  }

  /**
   * Interrupt the current turn.
   */
  async interrupt(): Promise<void> {
    if (this.queryHandle) {
      await this.queryHandle.interrupt()
    }
    this._status = 'idle'
  }

  /**
   * Change permission mode.
   */
  async setMode(mode: string): Promise<void> {
    this._mode = mode
    if (this.queryHandle) {
      await this.queryHandle.setPermissionMode(mode as PermissionMode)
    }
  }

  /**
   * Stop the session entirely.
   */
  stop(): void {
    this.abortController.abort()
    if (this.queryHandle) {
      this.queryHandle.close()
      this.queryHandle = null
    }
    this.channel.end()
    this._status = 'idle'

    // Reject all pending interactions
    for (const [, pending] of this.pendingInteractions) {
      pending.reject(new Error('Session stopped'))
    }
    this.pendingInteractions.clear()
  }

  /**
   * Resolve a pending AskUserQuestion interaction.
   */
  resolveQuestion(questionId: string, answers: Record<string, string>): void {
    const pending = this.pendingInteractions.get(questionId)
    if (pending) {
      this.pendingInteractions.delete(questionId)
      pending.resolve(answers)
    }
  }

  /**
   * Resolve a pending permission request.
   */
  resolvePermission(requestId: string, allow: boolean, message?: string): void {
    const pending = this.pendingInteractions.get(requestId)
    if (pending) {
      this.pendingInteractions.delete(requestId)
      pending.resolve({ allow, message })
    }
  }

  // ── Private ──

  private createCanUseTool(): CanUseTool {
    return async (toolName, input, options) => {
      // AskUserQuestion — forward to Walnut and wait for response
      if (toolName === 'AskUserQuestion') {
        const questionId = `q-${crypto.randomBytes(4).toString('hex')}`
        const questions = (input as Record<string, unknown>).questions

        this.emitEvent('session:ask-question', {
          sessionId: this._sessionId ?? this.id,
          questionId,
          questions,
        })

        // Block until Walnut responds
        const answers = await new Promise<unknown>((resolve, reject) => {
          this.pendingInteractions.set(questionId, { resolve, reject })
        })

        // Return allow with answers injected into input
        return {
          behavior: 'allow' as const,
          updatedInput: { ...input, answers },
        }
      }

      // ExitPlanMode — detect and emit plan-complete event
      if (toolName === 'ExitPlanMode') {
        const planContent = typeof input.plan === 'string' ? input.plan : ''
        this.emitEvent('session:plan-complete', {
          sessionId: this._sessionId ?? this.id,
          planContent,
        })
        return { behavior: 'allow' as const }
      }

      // In bypass mode, auto-allow everything
      if (this._mode === 'bypass') {
        return { behavior: 'allow' as const }
      }

      // In accept mode, auto-allow file edits
      if (this._mode === 'accept') {
        const editTools = ['Write', 'Edit', 'NotebookEdit']
        if (editTools.includes(toolName)) {
          return { behavior: 'allow' as const }
        }
      }

      // For other tools, forward permission request to Walnut
      const requestId = `perm-${crypto.randomBytes(4).toString('hex')}`

      this.emitEvent('session:permission-request', {
        sessionId: this._sessionId ?? this.id,
        requestId,
        toolName,
        input,
        suggestions: options.suggestions,
      })

      // Block until Walnut responds
      const result = await new Promise<{ allow: boolean; message?: string }>((resolve, reject) => {
        this.pendingInteractions.set(requestId, {
          resolve: resolve as (v: unknown) => void,
          reject,
        })
      })

      if (result.allow) {
        return { behavior: 'allow' as const }
      } else {
        return { behavior: 'deny' as const, message: result.message ?? 'Permission denied' }
      }
    }
  }

  /**
   * Process the output stream from the SDK query.
   * Maps SDK messages to session server events.
   */
  private async processOutput(): Promise<void> {
    if (!this.queryHandle) return

    try {
      for await (const msg of this.queryHandle) {
        this.handleMessage(msg)
      }
    } catch (err) {
      // AbortError is expected when interrupted/stopped
      if (err instanceof Error && err.name === 'AbortError') {
        return
      }
      throw err
    } finally {
      this._status = 'idle'
    }
  }

  private handleMessage(msg: SDKMessage): void {
    const sessionId = this._sessionId ?? this.id

    switch (msg.type) {
    case 'system': {
      const sys = msg as SDKSystemMessage | SDKCompactBoundaryMessage
      if ('subtype' in sys) {
        if (sys.subtype === 'init') {
          const init = sys as SDKSystemMessage
          this._sessionId = init.session_id
          this.emitEvent('session:init', {
            sessionId: init.session_id,
            model: init.model,
            cwd: init.cwd,
            tools: init.tools,
          })
        } else if (sys.subtype === 'compact_boundary') {
          const compact = sys as SDKCompactBoundaryMessage
          this.emitEvent('session:compact', {
            sessionId,
            trigger: compact.compact_metadata.trigger,
            preTokens: compact.compact_metadata.pre_tokens,
          })
        }
      }
      break
    }

    case 'assistant': {
      const assistant = msg as SDKAssistantMessage
      if (!assistant.message?.content) break

      for (const block of assistant.message.content) {
        if (block.type === 'text' && 'text' in block) {
          this.emitEvent('session:text-delta', {
            sessionId,
            delta: block.text,
          })
        } else if (block.type === 'tool_use') {
          this.emitEvent('session:tool-use', {
            sessionId,
            toolUseId: block.id,
            name: block.name,
            input: block.input,
            parentToolUseId: assistant.parent_tool_use_id ?? undefined,
          })
        }
      }
      break
    }

    case 'user': {
      const user = msg as SDKUserMessage | SDKUserMessageReplay
      if ('isReplay' in user && user.isReplay) break  // Skip replayed messages

      if (user.message?.content && Array.isArray(user.message.content)) {
        for (const block of user.message.content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const content = 'content' in block
              ? (typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
              : ''
            this.emitEvent('session:tool-result', {
              sessionId,
              toolUseId: 'tool_use_id' in block ? block.tool_use_id : '',
              result: typeof content === 'string' ? content.slice(0, 2000) : '',
            })
          }
        }
      }
      break
    }

    case 'stream_event': {
      const partial = msg as SDKPartialAssistantMessage
      // Stream events contain raw API streaming events
      // Extract text deltas from content_block_delta events
      if (partial.event?.type === 'content_block_delta') {
        const delta = partial.event as unknown as { delta?: { type: string; text?: string } }
        if (delta.delta?.type === 'text_delta' && delta.delta.text) {
          this.emitEvent('session:text-delta', {
            sessionId,
            delta: delta.delta.text,
          })
        }
      }
      break
    }

    case 'result': {
      const result = msg as SDKResultMessage
      this._sessionId = result.session_id

      let subtype: SessionResultSubtype = 'success'
      let resultText = ''

      if (result.subtype === 'success') {
        subtype = 'success'
        resultText = (result as SDKResultSuccess).result ?? ''
      } else {
        // Error subtypes
        const errorResult = result as SDKResultError
        if (errorResult.subtype === 'error_max_turns') {
          subtype = 'error_max_turns'
        } else if (errorResult.subtype === 'error_max_budget_usd') {
          subtype = 'error_max_budget'
        } else {
          subtype = 'error'
        }
        resultText = errorResult.errors?.join('\n') ?? ''
      }

      this.emitEvent('session:result', {
        sessionId: result.session_id,
        result: resultText,
        subtype,
        cost: result.total_cost_usd,
        duration: result.duration_ms,
        usage: result.usage ? {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
        } : undefined,
        modelUsage: result.modelUsage,
      })

      this._status = 'idle'
      break
    }
    }
  }
}
