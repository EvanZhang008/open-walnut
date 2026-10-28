import { FeatureNodeClient, type FeatureRelayConnection, type FeatureNodeStatus } from './feature-client.js'
import type { ReadContract } from './contracts.js'
import type { ReadCall } from './calls.js'
import type { JsonValue, Outcome } from './protocol.js'
import { role } from '../server-role.js'
import { localDaemon } from '../../providers/local-daemon.js'
import { getDirectDaemonConnection } from '../../providers/daemon-connection.js'

export interface FeatureClientApi {
  register(contract: ReadContract): { dispose(): void }
  list(): Promise<Outcome<FeatureNodeStatus[]>>
  read(call: ReadCall): Promise<Outcome<JsonValue>>
  dispose(): void
}
export interface CoreFeatureNodesApi { createClient(): FeatureClientApi }

export function createFeatureNodesService(): { api: CoreFeatureNodesApi; dispose(): void } {
  const clients = new Set<FeatureClientApi>()
  let closed = false
  let connection: (FeatureRelayConnection & { connected: boolean }) | undefined
  let connecting: Promise<void> | undefined
  const prepare = async (): Promise<void> => {
    if (closed || role() !== 'leader' || !localDaemon.wsUrl) return
    if (connection?.connected) return
    if (!connecting) {
      const source = getDirectDaemonConnection('__local__', localDaemon.wsUrl).then((value) => {
        if (!closed) connection = value
      }, () => {}).finally(() => { connecting = undefined })
      connecting = source
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([connecting, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000) })])
    } finally { if (timer) clearTimeout(timer) }
  }
  return {
    api: {
      createClient: () => {
        if (closed) throw new Error('Feature service unavailable')
        if (clients.size >= 64) throw new Error('Feature client limit reached')
        const client = new FeatureNodeClient(() => connection?.connected ? connection : undefined, prepare)
        const contracts = new Set<() => void>()
        let disposed = false
        const api: FeatureClientApi = {
          register: (contract) => {
            if (disposed) throw new Error('Feature client unavailable')
            const remove = client.register(contract)
            contracts.add(remove)
            return { dispose: () => { remove(); contracts.delete(remove) } }
          },
          list: () => client.list(),
          read: (call) => client.read(call),
          dispose: () => {
            if (disposed) return
            disposed = true
            client.dispose()
            for (const remove of contracts) remove()
            contracts.clear()
            void client.quiet().then(() => clients.delete(api))
          },
        }
        clients.add(api)
        return api
      },
    },
    dispose: () => {
      closed = true
      for (const client of [...clients]) client.dispose()
      connection = undefined
    },
  }
}
