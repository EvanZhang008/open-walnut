import type { PluginUiSnapshot } from './types'

/** Exact owner + local id + target, never the whole dialog slot list. */
export function pluginDialogSlot(slots: PluginUiSnapshot['slots'], pluginId: string, id: string) {
  return slots.find(slot => slot.pluginId === pluginId && slot.value.id === id && slot.value.target === 'dialog')
}

/** One dialog per window. Nothing here is persisted, logged or put in a URL. */
export interface PluginDialogRequest {
  sequence: number
  pluginId: string
  slot: string
  args?: Record<string, unknown>
  unavailable?: boolean
}

export function isPluginDialogId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)
}

/** Only local console paths, never a URL or a protocol-relative destination. */
export function isDialogNavigationPath(path: unknown): path is string {
  if (typeof path !== 'string' || !/^\/(?![\/\\])/.test(path) || /[\\\x00-\x20\x7f]/.test(path)) return false
  // A query may hold a URL as data; only the destination's path decides where it opens.
  const pathname = path.split(/[?#]/, 1)[0]
  if (/%(?:2f|5c|00|0a|0d)/i.test(pathname)) return false
  let segments: string[]
  try { segments = decodeURIComponent(pathname).split('/') } catch { return false }
  return !segments.some(segment => segment === '..')
}

const listeners = new Set<() => void>()
let request: PluginDialogRequest | null = null
let sequence = 0
let opener: Element | null = null

export const getPluginDialog = (): PluginDialogRequest | null => request
/** Internal focus return target, kept apart from plugin arguments and never persisted. */
export const getPluginDialogOpener = (expectedSequence: number): Element | null => request?.sequence === expectedSequence ? opener : null
export function subscribePluginDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(): void { for (const listener of listeners) listener() }

/** Duplicate clicks keep the original args and form. A different dialog never replaces it. */
export function openPluginDialog(pluginId: string, slot: string, args?: Record<string, unknown>): boolean {
  if (!isPluginDialogId(pluginId) || !isPluginDialogId(slot)) return false
  if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) return false
  if (request) return !request.unavailable && request.pluginId === pluginId && request.slot === slot
  let copied: Record<string, unknown> | undefined
  try { copied = args === undefined ? undefined : structuredClone(args) } catch { return false }
  opener = typeof document === 'undefined' ? null : document.activeElement
  request = { sequence: ++sequence, pluginId, slot, ...(copied === undefined ? {} : { args: copied }) }
  publish()
  return true
}

/** Identity fences keep a late callback from closing a newer dialog. */
export function closePluginDialog(expectedSequence: number): void {
  if (request?.sequence !== expectedSequence) return
  request = null
  opener = null
  publish()
}

/** Keep the explanation visible, but release arguments when its component cannot run any more. */
export function invalidatePluginDialog(expectedSequence: number): void {
  if (!request || request.sequence !== expectedSequence || request.unavailable) return
  request = { sequence: request.sequence, pluginId: request.pluginId, slot: request.slot, unavailable: true }
  publish()
}
