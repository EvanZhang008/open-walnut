/**
 * Settings store — syncs developer preferences from the server config.
 */

import { create } from 'zustand'
import { apiFetch } from '../api/client'

interface ServerConfig {
  developer?: {
    show_ui_only_triage?: boolean
  }
}

interface SettingsStore {
  showUiOnlyTriage: boolean
  loaded: boolean
  load: () => Promise<void>
  setShowUiOnlyTriage: (value: boolean) => Promise<void>
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  showUiOnlyTriage: false,
  loaded: false,

  load: async () => {
    try {
      const config = await apiFetch<ServerConfig>('/api/config')
      set({
        showUiOnlyTriage: config.developer?.show_ui_only_triage ?? false,
        loaded: true,
      })
    } catch {
      set({ loaded: true })
    }
  },

  setShowUiOnlyTriage: async (value: boolean) => {
    set({ showUiOnlyTriage: value })
    try {
      await apiFetch('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ developer: { show_ui_only_triage: value } }),
      })
    } catch {
      // Revert on failure
      set({ showUiOnlyTriage: !value })
    }
  },
}))
