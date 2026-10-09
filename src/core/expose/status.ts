/**
 * The current exposure status, for code outside the web layer (the plugin API).
 * The web runtime that owns the tunnel port and the supervisor publishes here.
 */

import type { ExposeStatus } from './types.js'

let source: (() => ExposeStatus) | null = null

export function setExposeStatusSource(fn: (() => ExposeStatus) | null): void {
  source = fn
}

export function currentExposeStatus(): ExposeStatus {
  return source?.() ?? { enabled: false, provider: null, state: 'off', since: 0 }
}
