/**
 * The clipboard, from the background: a one-time code copied after a fill (no page of the
 * extension has the person's click then), and clearing a copied password or code after 30 s
 * when the clipboard still holds it. Chrome's service worker has no clipboard, so an offscreen
 * document does the work (clipboard-page.ts); Firefox's background is a page and has its own.
 * Only a hash of what was copied is kept, to tell whether it is still there.
 */
import { ext } from './ext'

export const CLEAR_MS = 30_000
const ALARM = 'walnut-clear-clipboard'
const OFFSCREEN_URL = 'popup.html?clipboard=1'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chromeApi = (globalThis as any).chrome as { offscreen?: { createDocument(o: { url: string; reasons: string[]; justification: string }): Promise<void>; hasDocument?(): Promise<boolean> } } | undefined

async function hash(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

let creating: Promise<boolean> | null = null
async function offscreen(): Promise<boolean> {
  const off = chromeApi?.offscreen
  if (!off) return false
  if (await off.hasDocument?.().catch(() => false)) return true
  creating ??= off.createDocument({ url: OFFSCREEN_URL, reasons: ['CLIPBOARD'], justification: 'Copy a one-time code, and clear a copied password after 30 seconds' })
    .then(() => true, (err) => /single offscreen|only a single/i.test(String(err)))
    .finally(() => { creating = null })
  return creating
}

/** Read or write through whatever has a clipboard here; null when nothing does. */
async function clip(op: 'write' | 'read', text = ''): Promise<{ ok: boolean; text?: string } | null> {
  if (await offscreen()) {
    const r = await ext.runtime.sendMessage({ target: 'walnut-clipboard', op, text }).catch(() => null)
    return r && typeof r.ok === 'boolean' ? r : null
  }
  // Firefox: the background page itself (the clipboardWrite / clipboardRead permissions).
  if (typeof document !== 'undefined' && typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      if (op === 'write') { await navigator.clipboard.writeText(text); return { ok: true } }
      return { ok: true, text: await navigator.clipboard.readText() }
    } catch { return null }
  }
  return null
}

/** Put text on the clipboard from the background; false when this browser gives it no way to. */
export async function copyText(text: string): Promise<boolean> {
  const r = await clip('write', text)
  if (r?.ok) await clearLater(text)
  return !!r?.ok
}

/** Clear `text` off the clipboard in 30 s, if it is still what the clipboard holds then. */
export async function clearLater(text: string): Promise<void> {
  if (!text) return
  await ext.storage.session.set({ clipboardCopied: { hash: await hash(text), at: Date.now() } })
  armClear(CLEAR_MS)
}

let clearTimer: ReturnType<typeof setTimeout> | undefined
/** A timer for when the clear is due, and an alarm in case the service worker is stopped before then. */
function armClear(ms: number): void {
  clearTimeout(clearTimer)
  clearTimer = setTimeout(() => void clearIfDue(), ms + 200)
  // Chrome's alarms wait at least 30 s; the timer covers a shorter wait while the worker lives.
  try { void Promise.resolve(ext.alarms.create(ALARM, { delayInMinutes: Math.max(ms, CLEAR_MS) / 60_000 })).catch(() => undefined) } catch { /* the timer alone */ }
}

const READ_TRIES = 3
const READ_GAP_MS = 1000
let clearing: Promise<void> | null = null

/** The timer, the alarm and a woken worker may all ask at once: one clear runs. */
export function clearIfDue(): Promise<void> {
  clearing ??= clearNow().finally(() => { clearing = null })
  return clearing
}

async function clearNow(): Promise<void> {
  const { clipboardCopied: c } = await ext.storage.session.get('clipboardCopied')
  const copied = c as { hash: string; at: number } | undefined
  if (!copied) return
  // Woken before it is due (a later copy moved it, or a timer ran early): again when it is.
  const left = copied.at + CLEAR_MS - Date.now()
  if (left > 0) { armClear(left); return }
  // The offscreen page can miss a read on a busy machine (it is being made, or Chrome closed it):
  // a few tries before the clipboard is left alone.
  let now: { ok: boolean; text?: string } | null = null
  for (let i = 0; i < READ_TRIES && !now?.ok; i++) {
    if (i) await new Promise((r) => setTimeout(r, READ_GAP_MS))
    now = await clip('read')
  }
  // A copy made while it read is the one to clear now, later.
  const { clipboardCopied: latest } = await ext.storage.session.get('clipboardCopied')
  if ((latest as { at?: number } | undefined)?.at !== copied.at) return
  await ext.storage.session.remove('clipboardCopied')
  // Something else copied since (or the clipboard cannot be read): left alone.
  if (!now?.ok || typeof now.text !== 'string' || await hash(now.text) !== copied.hash) return
  await clip('write', '')
}

export function initClipboard(): void {
  ext.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void clearIfDue() })
  // A worker started after the clear was due (its timer died with the last one): now.
  void clearIfDue().catch(() => undefined)
}
