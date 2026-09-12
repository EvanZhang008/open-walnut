import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'
import { withFileLock } from '../../utils/file-lock.js'

/**
 * Plugin boot sentinel: the crash-loop guard for plugin activation.
 *
 * Two kinds of activation failure reach this file, and they are NOT treated alike:
 *
 * - An INTERRUPTED activation (the process died while `activating[id]` was set) is the
 *   case the sentinel exists for. Nothing caught that failure, so the same plugin will
 *   take the server down again on the next boot; two in a row quarantine it.
 * - A CAUGHT failure (activate threw, timed out, or the entry could not be bundled) can
 *   not hurt the process. It is recorded so the plugin's row can say WHY it is down,
 *   but it never quarantines across restarts: retrying a caught failure costs one failed
 *   activation per boot, while quarantining it turned a deploy-shape change into a
 *   silent fifteen-day sync outage for an external tracker plugin (2026-08-27 →
 *   2026-09-11). The PluginManager still stops a reload loop inside ONE process with
 *   its in-memory count.
 *
 * Every record carries the `buildId` of the process that wrote it, and a reader only
 * honours records from its own build. The file lives in the shared data dir, so a dev
 * (tsx) server or a test that boots against the real home would otherwise write its
 * failures into the production server's verdict (this quarantined the calendar plugin
 * in production on 2026-09-11 with an error production never produced). A new deploy
 * is a new build, so it gets a fresh chance by construction.
 *
 * Known limits, all failing open (fewer quarantines, never a wrong one):
 * - `activating` has one slot per plugin id. Two processes activating the same plugin
 *   at the same moment overwrite each other's slot, so a crash in one of them may go
 *   unrecorded. Two processes of the SAME checkout (two dev servers) also share a
 *   buildId and can record each other's interruption.
 * - A plugin that hangs in activate now costs its code deadline (20s) on every boot
 *   instead of being quarantined after two; plugins load after the port is bound, so
 *   this delays plugin availability, not the server.
 * - A sentinel file that cannot be read is treated as empty. The sentinel must never
 *   be the reason no plugin loads.
 */

export type PluginFailureKind = 'interrupted' | 'error'

interface ActivationInProgress {
  startedAt: string
  buildId: string
}

interface CrashRecord {
  count: number
  lastAt: string
  buildId: string
}

export interface PluginLastFailure {
  at: string
  kind: PluginFailureKind
  error?: string
  buildId: string
}

interface BootSentinelState {
  version: 2
  activating: Record<string, ActivationInProgress>
  /** Interrupted activations, the only failures that count toward quarantine. */
  crashes: Record<string, CrashRecord>
  /** The most recent failure of either kind, kept so the UI can show the reason. */
  lastFailure: Record<string, PluginLastFailure>
}

export interface InterruptedPluginActivation {
  pluginId: string
  failureCount: number
  quarantined: boolean
}

export interface PluginBootStatus {
  failureCount: number
  quarantined: boolean
  lastFailure?: PluginLastFailure
}

export interface PluginBootSentinelOptions {
  filePath?: string
  quarantineAfter?: number
  now?: () => Date
  /** Identity of the running code; records from another build are ignored. */
  buildId?: string
}

function freshState(): BootSentinelState {
  return { version: 2, activating: {}, crashes: {}, lastFailure: {} }
}

export class PluginBootSentinel {
  private readonly filePath: string
  private readonly quarantineAfter: number
  private readonly now: () => Date
  private readonly buildId: string

  constructor(options: PluginBootSentinelOptions = {}) {
    this.filePath = options.filePath ?? path.join(WALNUT_HOME, 'cache', 'plugin-boot-state.json')
    this.quarantineAfter = Math.max(1, options.quarantineAfter ?? 2)
    this.now = options.now ?? (() => new Date())
    this.buildId = options.buildId ?? 'unknown'
  }

  /**
   * Turn activations this build left in flight into crash records. Entries written by
   * another build stay untouched: that process may still be running, and its crashes are
   * not evidence against this build's copy of the plugin.
   */
  async recoverInterruptedActivations(): Promise<InterruptedPluginActivation[]> {
    const recovered: InterruptedPluginActivation[] = []
    await this.update((state) => {
      for (const [pluginId, inFlight] of Object.entries(state.activating)) {
        if (inFlight.buildId !== this.buildId) continue
        delete state.activating[pluginId]
        const crash = this.recordCrash(state, pluginId)
        state.lastFailure[pluginId] = {
          at: crash.lastAt,
          kind: 'interrupted',
          error: 'The server exited while this plugin was activating',
          buildId: this.buildId,
        }
        recovered.push({
          pluginId,
          failureCount: crash.count,
          quarantined: crash.count >= this.quarantineAfter,
        })
      }
      return state
    })
    return recovered
  }

  async begin(pluginId: string): Promise<void> {
    await this.update((state) => {
      state.activating[pluginId] = { startedAt: this.now().toISOString(), buildId: this.buildId }
      return state
    })
  }

  async finish(
    pluginId: string,
    outcome: 'active' | 'failed' | 'cancelled',
    detail: { error?: string } = {},
  ): Promise<void> {
    await this.update((state) => {
      delete state.activating[pluginId]
      if (outcome === 'cancelled') return state
      if (outcome === 'active') {
        // Only this build's own records: another build's crash history is about its
        // copy of the plugin, and this build running fine says nothing about that.
        if (state.crashes[pluginId]?.buildId === this.buildId) delete state.crashes[pluginId]
        if (state.lastFailure[pluginId]?.buildId === this.buildId) delete state.lastFailure[pluginId]
        return state
      }
      state.lastFailure[pluginId] = {
        at: this.now().toISOString(),
        kind: 'error',
        ...(detail.error ? { error: detail.error } : {}),
        buildId: this.buildId,
      }
      return state
    })
  }

  async getPluginStatus(pluginId: string): Promise<PluginBootStatus> {
    const state = await this.read()
    const crash = state.crashes[pluginId]
    const ownCrash = crash && crash.buildId === this.buildId ? crash : undefined
    const lastFailure = state.lastFailure[pluginId]
    return {
      failureCount: ownCrash?.count ?? 0,
      quarantined: (ownCrash?.count ?? 0) >= this.quarantineAfter,
      ...(lastFailure && lastFailure.buildId === this.buildId ? { lastFailure } : {}),
    }
  }

  async isQuarantined(pluginId: string): Promise<boolean> {
    return (await this.getPluginStatus(pluginId)).quarantined
  }

  /** The user's explicit "clear quarantine": every build's record for the plugin goes. */
  async clearQuarantine(pluginId: string): Promise<void> {
    await this.update((state) => {
      delete state.crashes[pluginId]
      delete state.lastFailure[pluginId]
      delete state.activating[pluginId]
      return state
    })
  }

  /** Read, tolerating a missing or unreadable file (either reads as empty). */
  private async read(): Promise<BootSentinelState> {
    try {
      return this.normalize(await readJsonFile<unknown>(this.filePath, freshState()))
    } catch {
      return freshState()
    }
  }

  /** Read-mutate-write under the cross-process file lock. */
  private async update(mutate: (state: BootSentinelState) => BootSentinelState): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const next = mutate(await this.read())
      await writeJsonFile(this.filePath, next)
    })
  }

  private recordCrash(state: BootSentinelState, pluginId: string): CrashRecord {
    const previous = state.crashes[pluginId]
    const crash: CrashRecord = {
      count: previous && previous.buildId === this.buildId ? previous.count + 1 : 1,
      lastAt: this.now().toISOString(),
      buildId: this.buildId,
    }
    state.crashes[pluginId] = crash
    return crash
  }

  /**
   * Accept whatever is on disk and return a v2 state. A v1 file (per-plugin failure
   * counts with no build identity and no failure kind) is the exact record that caused
   * the incidents above, so it is dropped rather than migrated: every plugin gets a fresh
   * activation attempt under the new rules.
   */
  private normalize(raw: unknown): BootSentinelState {
    const state = freshState()
    if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 2) return state
    const input = raw as Partial<BootSentinelState>
    if (input.activating && typeof input.activating === 'object') {
      for (const [id, entry] of Object.entries(input.activating)) {
        if (entry && typeof entry === 'object' && typeof entry.buildId === 'string' && typeof entry.startedAt === 'string') {
          state.activating[id] = { startedAt: entry.startedAt, buildId: entry.buildId }
        }
      }
    }
    if (input.crashes && typeof input.crashes === 'object') {
      for (const [id, entry] of Object.entries(input.crashes)) {
        if (entry && typeof entry === 'object' && typeof entry.count === 'number' && typeof entry.buildId === 'string') {
          state.crashes[id] = { count: entry.count, lastAt: String(entry.lastAt ?? ''), buildId: entry.buildId }
        }
      }
    }
    if (input.lastFailure && typeof input.lastFailure === 'object') {
      for (const [id, entry] of Object.entries(input.lastFailure)) {
        if (entry && typeof entry === 'object' && typeof entry.buildId === 'string'
          && (entry.kind === 'interrupted' || entry.kind === 'error')) {
          state.lastFailure[id] = {
            at: String(entry.at ?? ''),
            kind: entry.kind,
            ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
            buildId: entry.buildId,
          }
        }
      }
    }
    return state
  }
}

export function pluginSafeModeEnabled(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): boolean {
  return env.WALNUT_PLUGIN_SAFE_MODE === '1' || argv.includes('--plugin-safe-mode')
}
