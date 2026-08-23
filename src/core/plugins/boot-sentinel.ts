import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, updateJsonFile } from '../../utils/fs.js'

interface ActivationFailure {
  count: number
  lastAt: string
}

interface BootSentinelState {
  version: 1
  activating: Record<string, string>
  failures: Record<string, ActivationFailure>
  quarantined: string[]
}

export interface InterruptedPluginActivation {
  pluginId: string
  failureCount: number
  quarantined: boolean
}

const EMPTY_STATE: BootSentinelState = {
  version: 1,
  activating: {},
  failures: {},
  quarantined: [],
}

function freshState(): BootSentinelState {
  return { version: 1, activating: {}, failures: {}, quarantined: [] }
}

export class PluginBootSentinel {
  constructor(
    private readonly filePath = path.join(WALNUT_HOME, 'cache', 'plugin-boot-state.json'),
    private readonly quarantineAfter = 2,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recoverInterruptedActivations(): Promise<InterruptedPluginActivation[]> {
    const recovered: InterruptedPluginActivation[] = []
    await updateJsonFile(this.filePath, freshState(), (state) => {
      this.normalize(state)
      for (const pluginId of Object.keys(state.activating)) {
        const failure = this.incrementFailure(state, pluginId)
        const quarantined = failure.count >= this.quarantineAfter
        if (quarantined && !state.quarantined.includes(pluginId)) state.quarantined.push(pluginId)
        recovered.push({ pluginId, failureCount: failure.count, quarantined })
      }
      state.activating = {}
      return undefined
    })
    return recovered
  }

  async begin(pluginId: string): Promise<void> {
    await updateJsonFile(this.filePath, freshState(), (state) => {
      this.normalize(state)
      state.activating[pluginId] = this.now().toISOString()
      return undefined
    })
  }

  async finish(pluginId: string, outcome: 'active' | 'failed' | 'cancelled'): Promise<void> {
    await updateJsonFile(this.filePath, freshState(), (state) => {
      this.normalize(state)
      delete state.activating[pluginId]
      if (outcome === 'cancelled') return undefined
      if (outcome === 'active') {
        delete state.failures[pluginId]
        state.quarantined = state.quarantined.filter((id) => id !== pluginId)
        return undefined
      }
      const failure = this.incrementFailure(state, pluginId)
      if (failure.count >= this.quarantineAfter && !state.quarantined.includes(pluginId)) {
        state.quarantined.push(pluginId)
      }
      return undefined
    })
  }

  async getPluginStatus(pluginId: string): Promise<{ failureCount: number; quarantined: boolean }> {
    const state = await readJsonFile(this.filePath, EMPTY_STATE)
    this.normalize(state)
    return {
      failureCount: state.failures[pluginId]?.count ?? 0,
      quarantined: state.quarantined.includes(pluginId),
    }
  }

  async isQuarantined(pluginId: string): Promise<boolean> {
    return (await this.getPluginStatus(pluginId)).quarantined
  }

  async clearQuarantine(pluginId: string): Promise<void> {
    await updateJsonFile(this.filePath, freshState(), (state) => {
      this.normalize(state)
      delete state.failures[pluginId]
      delete state.activating[pluginId]
      state.quarantined = state.quarantined.filter((id) => id !== pluginId)
      return undefined
    })
  }

  private incrementFailure(state: BootSentinelState, pluginId: string): ActivationFailure {
    const failure = {
      count: (state.failures[pluginId]?.count ?? 0) + 1,
      lastAt: this.now().toISOString(),
    }
    state.failures[pluginId] = failure
    return failure
  }

  private normalize(state: BootSentinelState): void {
    state.version = 1
    if (!state.activating || typeof state.activating !== 'object') state.activating = {}
    if (!state.failures || typeof state.failures !== 'object') state.failures = {}
    if (!Array.isArray(state.quarantined)) state.quarantined = []
  }
}

export function pluginSafeModeEnabled(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): boolean {
  return env.WALNUT_PLUGIN_SAFE_MODE === '1' || argv.includes('--plugin-safe-mode')
}
