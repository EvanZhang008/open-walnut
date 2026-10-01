/**
 * The host half of `walnut.model.fastText`: one short text answer on the user's configured main
 * provider, fast tier.
 *
 * The call shape is `src/core/fork-title.ts`'s, deliberately: `sendMessage` with NO `provider`
 * field, so the adapter is always the one the user configured, and the model from `fastModelFor`
 * (undefined falls back to the main model inside sendMessage). It never takes `directFastRoute`
 * (that one picks ANOTHER configured provider) and never any third-party endpoint: a plugin can
 * hand this work mail, and work mail may only go where the user already sends everything else.
 */
import { sendMessage } from '../../model/model.js'
import { fastModelFor } from '../cheap-model.js'

export interface PluginFastTextRequest {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxTokens: number
  signal?: AbortSignal
}

export type PluginFastTextFn = (request: PluginFastTextRequest) => Promise<string>

/** A cap so a plugin cannot ask for the catalog's 64K (the SDK then refuses a non-stream call). */
const MAX_FAST_TEXT_TOKENS = 2_048

let override: PluginFastTextFn | null = null

/**
 * In-process test servers swap the real call out (the Playwright mail fixture fakes the model
 * this way). `null` restores the real one.
 */
export function setPluginFastTextOverride(fn: PluginFastTextFn | null): void {
  override = fn
}

/**
 * A vitest run never reaches a real model through this seam: a plugin that labels mail in the
 * background (mail's sort-ai.ts) would otherwise send test fixtures to whatever provider the machine
 * has credentials for, from any test that starts a server with mail in it. A test that wants an
 * answer installs an override; without one the call fails, which a plugin already handles as "the
 * model is down".
 */
let testGuard = true

function inTestRun(): boolean {
  return testGuard && !!(process.env.VITEST || process.env.VITEST_WORKER_ID)
}

/** Test seam for the one test that grades the real path with `sendMessage` mocked out. */
export function setPluginFastTextTestGuard(on: boolean): void {
  testGuard = on
}

export async function pluginFastText(request: PluginFastTextRequest): Promise<string> {
  if (override) return override(request)
  if (inTestRun()) throw new Error('No model call in a test run (install setPluginFastTextOverride).')
  const { getConfig } = await import('../config-manager.js')
  const config = await getConfig()
  const model = fastModelFor(config)
  const maxTokens = Math.max(1, Math.min(Math.floor(request.maxTokens) || 1, MAX_FAST_TEXT_TOKENS))
  const result = await sendMessage({
    system: request.system,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    config: { maxTokens, ...(model ? { model } : {}) },
    ...(request.signal ? { signal: request.signal } : {}),
  })
  if (request.signal?.aborted) throw new Error('aborted')
  return (result.content ?? [])
    .map((block) => (block.type === 'text' && 'text' in block ? (block as { text: string }).text : ''))
    .join('')
    .trim()
}
