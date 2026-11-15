/**
 * What each connected Walnut extension last said about itself: its version, its build, how the
 * browser installed it (a folder Walnut keeps, another unpacked copy, a store copy) and when.
 * Settings, Browser extension, shows it beside each connected browser (installed, up to date,
 * updates itself or needs Set up again). The extension says it with its update check
 * (GET /api/v1/browser/panel with its own token, every 10 minutes and at start: self-update.ts)
 * and with every agents poll. Memory only: a restarted Walnut hears it again within minutes.
 */

/** How the browser installed it (the extension's self-update.ts installKindOf; Settings words it in browser-extension-model.ts). */
export type InstallKind = 'walnut-folder' | 'unpacked' | 'store' | 'other'
const KINDS: readonly InstallKind[] = ['walnut-folder', 'unpacked', 'store', 'other']

export interface ExtensionSeen {
  device: string
  version: string
  build?: string
  install?: InstallKind
  at: number
}

const seen = new Map<string, ExtensionSeen>()
const BUILD = /^[0-9a-f]{6,64}$/

/** One report from an extension (`device` is its own token's device; the rest is what it says). */
export function noteExtension(device: string, said: { version?: unknown; build?: unknown; install?: unknown }, now = Date.now()): void {
  const before = seen.get(device)
  const version = typeof said.version === 'string' && said.version ? said.version.slice(0, 40) : before?.version ?? ''
  const build = typeof said.build === 'string' && BUILD.test(said.build) ? said.build : before?.build
  const install = (KINDS as readonly unknown[]).includes(said.install) ? said.install as InstallKind : before?.install
  seen.set(device, { device, version, ...(build ? { build } : {}), ...(install ? { install } : {}), at: now })
}

export function extensionsSeen(): ExtensionSeen[] {
  return [...seen.values()]
}

/** The device was removed (its token ended): nothing is said about it any more. */
export function forgetExtension(device: string): void { seen.delete(device) }

export function _resetExtensionsSeenForTesting(): void { seen.clear() }
