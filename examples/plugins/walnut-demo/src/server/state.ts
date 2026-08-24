import type { WalnutServerApi } from '@open-walnut/plugin-api/server'
import { STATE_FILE } from './constants'
import type { DemoCounters, DemoReceipt, DemoTimerState, RegistrationRecord } from './types'

const RECEIPT_LIMIT = 20
const RECEIPT_ROW_LIMIT = 50

const ZERO_COUNTERS: DemoCounters = {
  activations: 0,
  runs: 0,
  failures: 0,
  events: 0,
  hookCalls: 0,
  toolCalls: 0,
  cronRuns: 0,
  syncCalls: 0,
  providerCalls: 0,
  notifications: 0,
  statsRequests: 0,
  configChanges: 0,
}

interface PersistedState {
  counters: DemoCounters
  demoTaskId: string | null
}

export class DemoServerState {
  counters: DemoCounters = { ...ZERO_COUNTERS }
  /** Id of the ONE task this demo created. The demo touches no other task. */
  demoTaskId: string | null = null
  readonly receipts: DemoReceipt[] = []
  readonly registrations: RegistrationRecord[] = []
  readonly timers: DemoTimerState = {
    timeoutScheduled: false,
    timeoutFires: 0,
    intervalRunning: false,
    intervalTicks: 0,
    lastTickAt: null,
  }

  private readonly pendingCounters: Partial<DemoCounters> = {}
  private taskDirty = false

  constructor(private readonly walnut: WalnutServerApi) {}

  async load(): Promise<void> {
    // updateJson is read-modify-write under the host's file lock, so two activations racing still produce two increments.
    const persisted = await this.walnut.storage.updateJson<PersistedState>(
      STATE_FILE,
      { counters: { ...ZERO_COUNTERS }, demoTaskId: null },
      (current) => ({
        counters: {
          ...ZERO_COUNTERS,
          ...current.counters,
          activations: (current.counters?.activations ?? 0) + 1,
        },
        demoTaskId: current.demoTaskId ?? null,
      }),
    )
    this.counters = persisted.counters
    this.demoTaskId = persisted.demoTaskId
  }

  async initDatabase(): Promise<void> {
    await this.walnut.storage.database.migrate([
      {
        version: 1,
        sql: `CREATE TABLE demo_receipts (
          id INTEGER PRIMARY KEY,
          action TEXT NOT NULL,
          ok INTEGER NOT NULL,
          created_at TEXT NOT NULL
        )`,
      },
      {
        version: 2,
        sql: `CREATE TABLE demo_storage_probe (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        )`,
      },
    ])
  }

  bump(key: keyof DemoCounters, by = 1): void {
    this.counters[key] += by
    this.pendingCounters[key] = (this.pendingCounters[key] ?? 0) + by
  }

  setDemoTaskId(id: string | null): void {
    this.demoTaskId = id
    this.taskDirty = true
  }

  register(category: string, name: string, note: string): void {
    this.registrations.push({ category, name, note })
  }

  async flush(_force = false): Promise<void> {
    const deltas = { ...this.pendingCounters }
    const taskDirty = this.taskDirty
    if (Object.keys(deltas).length === 0 && !taskDirty) return
    for (const key of Object.keys(deltas) as Array<keyof DemoCounters>) {
      delete this.pendingCounters[key]
    }
    this.taskDirty = false
    const demoTaskId = this.demoTaskId

    try {
      const persisted = await this.walnut.storage.updateJson<PersistedState>(
        STATE_FILE,
        { counters: { ...ZERO_COUNTERS }, demoTaskId: null },
        (current) => {
          const counters = { ...ZERO_COUNTERS, ...current.counters }
          for (const key of Object.keys(deltas) as Array<keyof DemoCounters>) {
            counters[key] += deltas[key] ?? 0
          }
          return {
            counters,
            demoTaskId: taskDirty ? demoTaskId : current.demoTaskId ?? null,
          }
        },
      )
      this.counters = { ...persisted.counters }
      for (const key of Object.keys(this.pendingCounters) as Array<keyof DemoCounters>) {
        this.counters[key] += this.pendingCounters[key] ?? 0
      }
      if (!this.taskDirty) this.demoTaskId = persisted.demoTaskId
    } catch (error) {
      for (const key of Object.keys(deltas) as Array<keyof DemoCounters>) {
        this.pendingCounters[key] = (this.pendingCounters[key] ?? 0) + (deltas[key] ?? 0)
      }
      if (taskDirty && !this.taskDirty) {
        this.demoTaskId = demoTaskId
        this.taskDirty = true
      }
      this.walnut.log.warn('could not persist demo state', { error: describe(error) })
    }
  }

  async record(receipt: DemoReceipt): Promise<DemoReceipt> {
    this.receipts.unshift(receipt)
    if (this.receipts.length > RECEIPT_LIMIT) this.receipts.length = RECEIPT_LIMIT
    this.bump('runs')
    if (!receipt.ok) this.bump('failures')
    try {
      const database = this.walnut.storage.database
      await database.run(
        'INSERT INTO demo_receipts(action, ok, created_at) VALUES (?, ?, ?)',
        [receipt.action, receipt.ok ? 1 : 0, receipt.at],
      )
      await database.run(
        `DELETE FROM demo_receipts
         WHERE id <= (SELECT MAX(id) FROM demo_receipts) - ?`,
        [RECEIPT_ROW_LIMIT],
      )
    } catch (error) {
      this.walnut.log.warn('could not write the receipt audit row', { error: describe(error) })
    }
    await this.flush()
    return receipt
  }

  async receiptRowCount(): Promise<number> {
    try {
      const row = await this.walnut.storage.database.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM demo_receipts',
      )
      return row?.count ?? 0
    } catch {
      return 0
    }
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
