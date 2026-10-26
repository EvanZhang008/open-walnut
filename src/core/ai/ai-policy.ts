/**
 * The user's limits on `ai.run`, per caller: an on/off switch, a monthly budget, and how many
 * runs may go at once. Plugins are trusted code (docs/reference/plugin-development.md, Trust
 * model), so none of this is a security fence: it is what the user sees and steers in Settings.
 *
 * Spend is this machine's record (`local/ai/spend.json`, never synced: `local/` is root-ignored
 * by git-sync), counted from the cost each call reports. A subscription login reports a nominal
 * cost, which still counts.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { AiError, type AiCaller } from './ai-types.js'

export const DEFAULT_MONTHLY_USD = 10
export const DIRECT_TIMEOUT_MS = 60_000
export const DIRECT_MAX_TIMEOUT_MS = 180_000
export const AGENT_TIMEOUT_MS = 10 * 60_000
export const MAX_AGENT_RUNS = 2
export const MAX_DIRECT_RUNS = 4

export interface CallerSettings { enabled: boolean; monthlyUsd: number }

export interface CallerSpend { usd: number; calls: number; lastAt?: string }

export function callerKey(caller: AiCaller): string {
  return `${caller.kind}:${caller.id}`
}

export async function callerSettings(caller: AiCaller): Promise<CallerSettings> {
  if (caller.kind === 'walnut') return { enabled: true, monthlyUsd: Number.POSITIVE_INFINITY }
  const { getConfig } = await import('../config-manager.js')
  const entry = (await getConfig()).plugin_ai?.[caller.id] ?? {}
  const monthly = typeof entry.monthly_usd === 'number' && entry.monthly_usd >= 0 ? entry.monthly_usd : DEFAULT_MONTHLY_USD
  return { enabled: entry.enabled !== false, monthlyUsd: monthly }
}

export async function setCallerSettings(pluginId: string, patch: { enabled?: boolean; monthlyUsd?: number }): Promise<CallerSettings> {
  const { getConfig, updateConfig } = await import('../config-manager.js')
  const current = { ...((await getConfig()).plugin_ai ?? {}) }
  const entry = { ...(current[pluginId] ?? {}) }
  if (patch.enabled !== undefined) entry.enabled = patch.enabled
  if (patch.monthlyUsd !== undefined) {
    if (!Number.isFinite(patch.monthlyUsd) || patch.monthlyUsd < 0) throw new AiError('ai_bad_request', 'The monthly budget must be zero or more')
    entry.monthly_usd = Math.round(patch.monthlyUsd * 100) / 100
  }
  current[pluginId] = entry
  await updateConfig({ plugin_ai: current })
  return callerSettings({ kind: 'plugin', id: pluginId })
}

// ── Spend ────────────────────────────────────────────────────────────────

interface SpendFile { month: string; callers: Record<string, CallerSpend> }

let spendDirOverride: string | null = null
let spend: SpendFile | null = null
let writeChain: Promise<void> = Promise.resolve()

/** Tests point the store at their own folder. */
export function _setAiSpendDirForTesting(dir: string | null): void {
  spendDirOverride = dir
  spend = null
}

function spendFile(): string {
  return path.join(spendDirOverride ?? path.join(WALNUT_HOME, 'local', 'ai'), 'spend.json')
}

function monthOf(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

async function loadSpend(now: Date): Promise<SpendFile> {
  if (!spend) {
    try {
      const parsed = JSON.parse(await fs.readFile(spendFile(), 'utf-8')) as SpendFile
      spend = parsed && typeof parsed.month === 'string' && parsed.callers ? parsed : { month: monthOf(now), callers: {} }
    } catch {
      spend = { month: monthOf(now), callers: {} }
    }
  }
  // A new month starts every caller at zero.
  if (spend.month !== monthOf(now)) spend = { month: monthOf(now), callers: {} }
  return spend
}

export async function callerSpend(caller: AiCaller, now = new Date()): Promise<CallerSpend> {
  const file = await loadSpend(now)
  return { ...(file.callers[callerKey(caller)] ?? { usd: 0, calls: 0 }) }
}

export async function recordSpend(caller: AiCaller, usd: number | undefined, now = new Date()): Promise<void> {
  const file = await loadSpend(now)
  const key = callerKey(caller)
  const row = file.callers[key] ?? { usd: 0, calls: 0 }
  row.usd = Math.round((row.usd + (usd && usd > 0 ? usd : 0)) * 1e6) / 1e6
  row.calls += 1
  row.lastAt = now.toISOString()
  file.callers[key] = row
  const snapshot = JSON.stringify(file, null, 2)
  writeChain = writeChain.then(async () => {
    const target = spendFile()
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.tmp-${process.pid}`
    await fs.writeFile(temp, snapshot, 'utf-8')
    await fs.rename(temp, target)
  }).catch((error) => {
    log.agent.warn('ai spend write failed', { error: error instanceof Error ? error.message : String(error) })
  })
  await writeChain
}

/** Throws when the caller is switched off or out of budget. */
export async function assertCallerMayRun(caller: AiCaller): Promise<CallerSettings> {
  const settings = await callerSettings(caller)
  const who = caller.name ?? caller.id
  if (!settings.enabled) {
    throw new AiError('ai_disabled', `AI is turned off for ${who}. Turn it on in Settings, Plugins.`)
  }
  const used = await callerSpend(caller)
  if (used.usd >= settings.monthlyUsd) {
    throw new AiError('ai_budget', `${who} has used its AI budget for this month ($${settings.monthlyUsd}). Raise it in Settings, Plugins.`)
  }
  return settings
}

// ── Concurrency ──────────────────────────────────────────────────────────

const running = new Map<string, number>()
const waiting = new Map<string, Array<() => void>>()

/**
 * Wait for one of the caller's slots of this kind; resolves to the release. A waiter that is
 * cancelled leaves the queue at once, so a release always wakes a live one.
 */
export async function acquireRunSlot(caller: AiCaller, kind: 'direct' | 'agent', signal?: AbortSignal): Promise<() => void> {
  const key = `${callerKey(caller)}|${kind}`
  const max = kind === 'agent' ? MAX_AGENT_RUNS : MAX_DIRECT_RUNS
  while ((running.get(key) ?? 0) >= max) {
    if (signal?.aborted) throw new AiError('ai_aborted', 'The call was cancelled')
    await new Promise<void>((resolve) => {
      const queue = waiting.get(key) ?? []
      const wake = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        const at = queue.indexOf(wake)
        if (at !== -1) queue.splice(at, 1)
        resolve()
      }
      queue.push(wake)
      waiting.set(key, queue)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  if (signal?.aborted) throw new AiError('ai_aborted', 'The call was cancelled')
  running.set(key, (running.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    running.set(key, Math.max(0, (running.get(key) ?? 1) - 1))
    waiting.get(key)?.shift()?.()
  }
}
