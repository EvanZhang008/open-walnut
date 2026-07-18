/**
 * CodexCliSession — Codex CLI backend (parallel to ClaudeCodeSession).
 *
 * Key protocol differences from Claude Code:
 * - ONE-SHOT process model: `codex exec` runs one turn per spawn. Multi-turn
 *   via `codex exec resume <thread_id>` (cold resume, no FIFO stdin hot path).
 * - Output: `--json` → JSONL with `thread.started{thread_id}`, `turn.started`,
 *   `turn.completed{usage}`, `item.completed{item:{type,text,...}}`, `error`.
 * - No live control protocol (no applyModel/applyEffort/askSideQuestion analogs).
 * - Config/auth: Codex CLI self-manages (`~/.codex/config.toml`, `OPENAI_API_KEY`,
 *   `codex login`) — Walnut only needs to spawn the binary with args.
 *
 * MVP architecture (Phase 1):
 * - Every turn (first + follow-ups) = fresh `codex exec [resume <thread_id>] --json "<prompt>"`
 * - Parse JSONL stream → translate to Walnut's `StreamingBlock` contract
 * - Store `thread_id` from `thread.started` → use it for subsequent resume
 * - Reuses: `SessionRunner` pool, `RemoteSessionManager` transport, daemon infra
 *
 * Phase 2 (future):
 * - Upgrade to `codex app-server` (experimental long-lived protocol) if cold-start
 *   latency becomes user pain → matches Claude's hot-path UX
 */

import { log } from '../logging/index.js'
import { createSessionManager, type SessionManager, type TransportStartOptions } from './session-manager.js'
import type { SshTarget } from './session-io.js'
import type { SessionMode } from '../core/types.js'

export interface CodexSessionConfig {
  /** Temp ID for file naming */
  tmpId: string
  /** Host key from config (undefined = local) */
  host?: string
  /** Resolved SSH target (remote only) */
  sshTarget?: SshTarget
  /** CWD for the codex process */
  cwd: string
  /** Task ID this session is attached to */
  taskId: string
  /** Initial model (e.g. 'gpt-5.5') */
  model?: string
  /** Sandbox mode: read-only | workspace-write | danger-full-access */
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Permission/approval policy */
  mode: SessionMode
  /** Direct WebSocket URL (tests only) */
  directWsUrl?: string
}

export interface CodexSendOptions {
  /** User message text */
  message: string
  /** Resume thread ID (for follow-up turns) */
  threadId?: string
}

/**
 * CodexCliSession — minimal MVP.
 * TODO Step 4: wire JSONL parsing & StreamingBlock emission.
 * TODO Step 5: extract thread_id from thread.started, store for resume.
 * TODO Step 6: translate item.completed → tool_call/text blocks.
 */
export class CodexCliSession {
  private transport: SessionManager
  private config: CodexSessionConfig
  private _threadId: string | null = null
  private _pid: number | null = null

  constructor(config: CodexSessionConfig) {
    this.config = config
    // Reuse createSessionManager (unified daemon transport)
    this.transport = createSessionManager(
      config.tmpId,
      config.host,
      config.sshTarget,
      undefined, // _outputFileOverride
      'codex',   // binary name ← the swap point
      config.directWsUrl,
    )
  }

  get sessionId(): string | null { return this._threadId }
  get pid(): number | null { return this._pid }
  get mode(): SessionMode { return this.config.mode }

  /**
   * Start or resume a Codex session. Builds `codex exec` arg vector.
   * MVP: cold resume on every turn (no FIFO hot path).
   */
  async send(opts: CodexSendOptions): Promise<void> {
    const args: string[] = ['exec', '--json', '--skip-git-repo-check']

    // Sandbox mode → --sandbox flag
    const sandbox = this.config.sandboxMode || 'workspace-write'
    args.push('--sandbox', sandbox)

    // Model → --model flag
    if (this.config.model) {
      args.push('--model', this.config.model)
    }

    // Resume if we have a thread_id from previous turn
    if (opts.threadId) {
      args.push('resume', opts.threadId)
    }

    // Prompt as positional arg (Codex CLI convention)
    args.push(opts.message)

    const startOptions: TransportStartOptions = {
      binary: 'codex',
      args,
      cwd: this.config.cwd,
      message: opts.message, // not used by Codex (it's in args), but transport contract requires it
      resume: !!opts.threadId,
      mode: this.config.mode,
      onOutput: (event) => {
        // TODO Step 4: parse JSONL line, extract thread_id, emit StreamingBlock
        log.session.info('Codex JSONL', { line: event.line, sessionId: this._threadId })
      },
      onExit: (code, stderr) => {
        log.session.info('Codex exec exited', { code, stderr, sessionId: this._threadId })
      },
    }

    const result = await this.transport.start(startOptions)
    this._pid = result.pid
    // TODO Step 5: extract thread_id from first `thread.started` event in onOutput
  }

  /**
   * Follow-up message (multi-turn). Codex MVP = fresh `codex exec resume <thread_id>`.
   */
  async sendFollowUp(message: string): Promise<void> {
    if (!this._threadId) {
      throw new Error('Cannot send follow-up: no thread_id (session not started)')
    }
    return this.send({ message, threadId: this._threadId })
  }

  /** Stop the Codex process. */
  async stop(): Promise<void> {
    await this.transport.stop()
  }

  /** Kill the Codex process. */
  async kill(): Promise<void> {
    await this.transport.kill()
  }
}
