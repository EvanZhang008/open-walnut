/**
 * Voice Accuracy's two model calls ride Walnut's own background path
 * (model.ts sendMessage, as the titlers and summaries do): the judge on the
 * strongest Claude tier of the main provider's catalog, the clean-up on the
 * fast (Haiku) model. Each call has a deadline and is recorded in usage.
 */
import { sendMessage } from '../../../model/model.js'
import { tierModelFor } from '../../../model/micro-agent.js'
import { resolveMainProviderName } from '../../../model/providers/default-provider.js'
import { fastCallBudgetMs, fastCallText, fastModelFor } from '../../cheap-model.js'
import type { Config } from '../../types.js'

/** The judge's model: the opus tier of the main provider's catalog (else the main model). */
export function judgeModel(config: Config): string {
  return tierModelFor(config, 'opus', resolveMainProviderName(config))
}

/** The clean-up's model: Walnut's fast model (else the main model). */
export function cleanupModel(config: Config): string | undefined {
  return fastModelFor(config)
}

export interface ModelAnswer { text: string; model: string; ms: number }

export async function callTextModel(opts: {
  config: Config
  model: string | undefined
  prompt: string
  helper: 'judge' | 'cleanup'
  maxTokens: number
  /** Deadline of a direct API call; a CLI or local model gets its own longer floor. */
  directMs: number
  signal?: AbortSignal
}): Promise<ModelAnswer> {
  const budget = fastCallBudgetMs(opts.config, opts.directMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budget)
  const stop = () => controller.abort()
  opts.signal?.addEventListener('abort', stop, { once: true })
  const t0 = Date.now()
  try {
    const result = await sendMessage({
      system: 'You follow the instructions in the user message exactly and answer with the requested text only.',
      messages: [{ role: 'user', content: opts.prompt }],
      config: { ...(opts.model ? { model: opts.model } : {}), maxTokens: opts.maxTokens },
      signal: controller.signal,
      purpose: 'background',
      usage: { source: 'voice-accuracy', agentId: `voice-accuracy-${opts.helper}` },
    })
    const text = fastCallText(result, budget).trim()
    if (!text) throw new Error('the model answered with no text')
    return { text, model: result.usage?.model ?? opts.model ?? 'main model', ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', stop)
  }
}
