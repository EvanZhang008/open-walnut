/**
 * Connection store — pairing state, server status (LIVE/REPLICA), reachability.
 */

import { create } from 'zustand'
import { claimDevice, fetchStatus, testStatus } from '../api/client'
import { clearConfig, hydrateConfig, saveConfig } from '../api/config'
import { ApiError, type ServerStatus } from '../api/types'

interface ConnectionStore {
  hydrated: boolean
  configured: boolean
  serverUrl: string
  deviceName: string
  status: ServerStatus | null
  /** false after a network-level failure — drives the offline banner. */
  online: boolean

  hydrate: () => Promise<void>
  /** Save URL + token, then verify with a live /status round-trip. */
  configure: (url: string, token: string, deviceName?: string) => Promise<ServerStatus>
  /** First-boot claim: exchange setup token for a device token, then configure. */
  claim: (url: string, setupToken: string, deviceName: string) => Promise<ServerStatus>
  refreshStatus: () => Promise<void>
  /** Report a network-level result from any API call (chat/notes stores). */
  reportReachability: (ok: boolean) => void
  reset: () => Promise<void>
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  hydrated: false,
  configured: false,
  serverUrl: '',
  deviceName: '',
  status: null,
  online: true,

  hydrate: async () => {
    const { serverUrl, token, deviceName } = await hydrateConfig()
    set({
      hydrated: true,
      configured: !!serverUrl && !!token,
      serverUrl: serverUrl ?? '',
      deviceName: deviceName ?? '',
    })
    if (serverUrl && token) void get().refreshStatus()
  },

  configure: async (url, token, deviceName) => {
    await saveConfig(url, token, deviceName)
    try {
      const status = await fetchStatus()
      set({ configured: true, serverUrl: url, deviceName: deviceName ?? get().deviceName, status, online: true })
      return status
    } catch (err) {
      // Verification failed — roll back so the app doesn't get stuck half-paired.
      await clearConfig()
      set({ configured: false })
      throw err
    }
  },

  claim: async (url, setupToken, deviceName) => {
    const { token, deviceName: name } = await claimDevice(url, setupToken, deviceName)
    return get().configure(url, token, name)
  },

  refreshStatus: async () => {
    if (!get().configured) return
    try {
      const status = await fetchStatus()
      set({ status, online: true })
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) set({ online: false })
    }
  },

  reportReachability: (ok) => {
    if (get().online !== ok) set({ online: ok })
  },

  reset: async () => {
    await clearConfig()
    set({ configured: false, serverUrl: '', deviceName: '', status: null, online: true })
  },
}))

/** Setup-screen helper: probe a server before saving anything. */
export async function probeServer(url: string, token?: string): Promise<ServerStatus> {
  return testStatus(url, token)
}
