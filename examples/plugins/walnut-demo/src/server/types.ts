export interface DemoCounters {
  activations: number
  runs: number
  failures: number
  events: number
  hookCalls: number
  toolCalls: number
  cronRuns: number
  syncCalls: number
  providerCalls: number
  notifications: number
  statsRequests: number
  configChanges: number
}

/** `detail` is hand-built JSON: never pass a host object through, or a data directory or secret value rides along. */
export interface DemoReceipt {
  action: string
  ok: boolean
  at: string
  ms: number
  detail?: Record<string, unknown>
  error?: string
}

export interface DemoTimerState {
  timeoutScheduled: boolean
  timeoutFires: number
  intervalRunning: boolean
  intervalTicks: number
  lastTickAt: string | null
}

export interface RegistrationRecord {
  category: string
  name: string
  note: string
}

export type DemoActionHandler = (input: Record<string, unknown>) => Promise<Record<string, unknown>>
