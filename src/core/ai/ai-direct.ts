/**
 * The direct route of `ai.run`: one model answer, no session, on what the user already set up.
 *
 * On a Claude Code login (the main provider resolves to `claude_cli`, see default-provider.ts) it
 * is micro-Claude on the warm pool: the caller's system prompt as the WHOLE prompt, `--bare`, no
 * settings chain, no tools, about 2 s when a child is ready (micro-claude.ts). On any other main
 * provider (Bedrock, an API key) it is the same `sendMessage` call every background helper makes.
 * Walnut has no key of its own on either path.
 */
import { AiError } from './ai-types.js'
import type { AiTurn } from './ai-prompt.js'

export interface DirectCall {
  system: string
  /** This turn's text (context, prompt, format) without the history. */
  turnText: string
  /** Earlier turns of the conversation, already bounded. */
  history: AiTurn[]
  /** The single prompt a one-message engine reads: history replay plus this turn. */
  prompt: string
  effort: 'quick' | 'normal' | 'deep'
  timeoutMs: number
  interactive: boolean
  onText?: (delta: string) => void
  signal?: AbortSignal
  /** Who the usage ledger row names (`plugin:<id>`). */
  ledgerAgentId?: string
}

export interface DirectAnswer {
  text: string
  engine: string
  model?: string
  costUsd?: number
}

export type DirectRunner = (call: DirectCall) => Promise<DirectAnswer>

let override: DirectRunner | null = null

/** In-process test servers swap the model out (the plugin AI e2e and the Playwright fixture). */
export function setAiDirectOverride(fn: DirectRunner | null): void {
  override = fn
}

export function aiDirectOverridden(): boolean {
  return override !== null
}

/** A vitest run never reaches a real model through this seam (same rule as plugin-fast-text.ts). */
function inTestRun(): boolean {
  return !!(process.env.VITEST || process.env.VITEST_WORKER_ID)
}

const CLI_MODEL: Record<DirectCall['effort'], string> = { quick: 'haiku', normal: 'sonnet', deep: 'opus' }

function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new AiError('ai_aborted', 'The call was cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AiError('ai_aborted', 'The call was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/** True when nothing can answer a direct call: no provider picked, no Claude Code, no AWS credentials. */
export async function directUnconfigured(): Promise<boolean> {
  const { getConfig } = await import('../config-manager.js')
  const { resolveMainProviderName, claudeCliAvailable, hasExplicitBedrockConfig, LEGACY_DEFAULT_PROVIDER, CLAUDE_CLI_PROVIDER } =
    await import('../../model/providers/default-provider.js')
  const config = await getConfig()
  const provider = resolveMainProviderName(config)
  if (provider === CLAUDE_CLI_PROVIDER) return !claudeCliAvailable()
  if (provider !== LEGACY_DEFAULT_PROVIDER || config.agent?.main_provider) return false
  // The implicit fallback: Bedrock nobody picked. It can still work through the SDK's chain.
  const env = process.env
  return !hasExplicitBedrockConfig(config) && !env.AWS_ACCESS_KEY_ID && !env.AWS_PROFILE && !env.AWS_BEARER_TOKEN_BEDROCK
}

export async function runDirect(call: DirectCall): Promise<DirectAnswer> {
  if (override) return override(call)
  if (inTestRun()) throw new AiError('ai_failed', 'No model call in a test run (install setAiDirectOverride).')
  if (await directUnconfigured()) {
    throw new AiError('ai_unconfigured', 'No AI is set up in Walnut yet. Open Settings, AI Provider.')
  }
  const { getConfig } = await import('../config-manager.js')
  const { resolveMainProviderName, CLAUDE_CLI_PROVIDER } = await import('../../model/providers/default-provider.js')
  const config = await getConfig()
  const provider = resolveMainProviderName(config)

  if (provider === CLAUDE_CLI_PROVIDER) {
    const { runMicroClaude } = await import('../../providers/micro-claude.js')
    const model = CLI_MODEL[call.effort]
    const run = await abortable(runMicroClaude({
      system: call.system,
      prompt: call.prompt,
      model,
      timeoutMs: call.timeoutMs,
      warm: true,
      // Always partial, so a call with and without a listener shares one warm child.
      onTextDelta: (delta) => call.onText?.(delta),
    }), call.signal)
    try {
      const { usageTracker } = await import('../usage/index.js')
      usageTracker.record({
        source: 'plugin', model, external_cost_usd: run.costUsd ?? 0, duration_ms: run.durationMs,
        ...(call.ledgerAgentId ? { agentId: call.ledgerAgentId } : {}),
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      })
    } catch { /* accounting never fails the call */ }
    return { text: run.response.trim(), engine: 'claude', model, ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}) }
  }

  const { sendMessageStream } = await import('../../model/model.js')
  const { fastModelFor } = await import('../cheap-model.js')
  const model = call.effort === 'quick' ? fastModelFor(config) : undefined
  const timeout = AbortSignal.timeout(call.timeoutMs)
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout
  const messages = [
    ...call.history.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: 'user' as const, content: call.turnText },
  ]
  let result
  try {
    result = await sendMessageStream({
      system: call.system,
      messages,
      config: { maxTokens: 4_096, ...(model ? { model } : {}) },
      signal,
      purpose: call.interactive ? 'interactive' : 'background',
      ...(call.onText ? { onTextDelta: call.onText } : {}),
    })
  } catch (error) {
    if (call.signal?.aborted) throw new AiError('ai_aborted', 'The call was cancelled')
    if (timeout.aborted) throw new AiError('ai_timeout', `No answer within ${Math.round(call.timeoutMs / 1000)} s`)
    throw error
  }
  if (call.signal?.aborted) throw new AiError('ai_aborted', 'The call was cancelled')
  if (timeout.aborted && result.aborted) throw new AiError('ai_timeout', `No answer within ${Math.round(call.timeoutMs / 1000)} s`)
  const text = (result.content ?? [])
    .map((block) => (block.type === 'text' && 'text' in block ? (block as { text: string }).text : ''))
    .join('')
    .trim()
  let costUsd: number | undefined
  if (result.usage) {
    try {
      const { usageTracker } = await import('../usage/index.js')
      costUsd = usageTracker.record({
        source: 'plugin',
        model: result.usage.model ?? model ?? 'main',
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
        cache_read_input_tokens: result.usage.cache_read_input_tokens,
        ...(call.ledgerAgentId ? { agentId: call.ledgerAgentId } : {}),
      }).cost_usd
    } catch { /* accounting never fails the call */ }
  }
  return { text, engine: provider, ...(result.usage?.model ?? model ? { model: result.usage?.model ?? model } : {}), ...(costUsd !== undefined ? { costUsd } : {}) }
}
