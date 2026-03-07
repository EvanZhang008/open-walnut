/**
 * Connection state store — manages server URL, API key, and WebSocket state.
 */

import { create } from 'zustand'
import { wsClient } from '../api/ws'
import { getServerUrl, getApiKey, setServerUrl, setApiKey, isConfigured } from '../utils/secure-store'
import type { ConnectionState } from '../api/types'

interface ConnectionStore {
  serverUrl: string
  apiKey: string
  connectionState: ConnectionState
  isConfigured: boolean
  isInitialized: boolean

  /** Load credentials from SecureStore on app start */
  initialize: () => Promise<void>
  /** Save credentials and connect */
  configure: (url: string, key: string) => Promise<void>
  /** Connect to the server */
  connect: () => void
  /** Disconnect */
  disconnect: () => void
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  serverUrl: '',
  apiKey: '',
  connectionState: 'disconnected',
  isConfigured: false,
  isInitialized: false,

  initialize: async () => {
    const url = await getServerUrl()
    const key = await getApiKey()
    const configured = !!(url && key)

    set({ serverUrl: url ?? '', apiKey: key ?? '', isConfigured: configured, isInitialized: true })

    // Listen for connection state changes
    wsClient.onConnectionChange((state) => {
      set({ connectionState: state })
    })

    // Auto-connect if configured
    if (configured) {
      wsClient.connect(url!, key!)
    }
  },

  configure: async (url: string, key: string) => {
    await setServerUrl(url)
    await setApiKey(key)
    set({ serverUrl: url, apiKey: key, isConfigured: true })
    wsClient.connect(url, key)
  },

  connect: () => {
    const { serverUrl, apiKey } = get()
    if (serverUrl && apiKey) {
      wsClient.connect(serverUrl, apiKey)
    }
  },

  disconnect: () => {
    wsClient.disconnect()
  },
}))
