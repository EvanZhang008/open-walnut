/// <reference types="vite/client" />
/**
 * Dev-only test hooks (the Playwright fixture runs Vite dev): register a fake plugin
 * settings panel or App from a spec. A panel shows on its plugin's page in Apps, so both
 * the Apps page and Settings import this. Stripped from builds.
 */
import { pluginUiRegistry } from './registry'
import { appRegistry } from '@/apps/registry'

declare global {
  interface Window {
    __walnutSettingsTestHooks?: { pluginUiRegistry: typeof pluginUiRegistry; appRegistry: typeof appRegistry }
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__walnutSettingsTestHooks = { pluginUiRegistry, appRegistry }
}

export {}
