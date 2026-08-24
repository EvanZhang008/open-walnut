import type { WalnutWebApi } from '@open-walnut/plugin-api/web'
import type { DemoEventLog } from './event-log'

export type DemoBadge = number | 'dot' | null

export const SECTION_IDS = ['platform', 'views', 'web', 'server', 'registry', 'lifecycle'] as const
export type SectionId = typeof SECTION_IDS[number]

export const SECTION_LABELS: Record<SectionId, string> = {
  platform: 'App platform',
  views: 'Host views',
  web: 'Web API',
  server: 'Server API',
  registry: 'Registry',
  lifecycle: 'Lifecycle',
}

export type LayoutMode = 'compact' | 'wide'

export interface RunOutcome {
  ok: boolean
  action: string
  ms: number
  receipt?: unknown
  error?: string
}

export interface DemoStats {
  pluginId?: string
  pluginName?: string
  walnutVersion?: string
  capabilities?: string[]
  actions?: string[]
  counters?: Record<string, number>
  registrations?: Array<{ category: string; name: string; note: string }>
  timers?: Record<string, unknown>
  demoProject?: string
  demoTaskId?: string | null
  secretKeys?: string[]
  storage?: { relativeNames?: string[]; receiptRows?: number }
  receipts?: Array<{ action: string; ok: boolean; at: string; ms: number }>
}

export interface DemoContext {
  walnut: WalnutWebApi
  views: WalnutWebApi['ui']['views']
  run(action: string, input?: Record<string, unknown>): Promise<RunOutcome>
  fetchStats(): Promise<RunOutcome>
  lifecycle(operation: 'reload' | 'disable'): Promise<RunOutcome>
  setBadge(value: DemoBadge): void
  events: DemoEventLog
  /** Relative on purpose: it is displayed as-is, so no host path can be shown. */
  statsPath: string
  appPath: string
  auxiliaryPath: string
}
