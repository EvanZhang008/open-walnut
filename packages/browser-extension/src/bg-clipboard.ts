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
  setTimeout(() => void clearIfDue(), CLEAR_MS + 200)
  // The service worker may be stopped before then: an alarm wakes it.
  try { await ext.alarms.create(ALARM, { delayInMinutes: CLEAR_MS / 60_000 }) } catch { /* the timer alone */ }
}

async function clearIfDue(): Promise<void> {
  const { clipboardCopied: c } = await ext.storage.session.get('clipboardCopied')
  const copied = c as { hash: string; at: number } | undefined
  if (!copied || Date.now() - copied.at < CLEAR_MS) return
  await ext.storage.session.remove('clipboardCopied')
  const now = await clip('read')
  // Something else copied since (or the clipboard cannot be read): left alone.
  if (!now?.ok || typeof now.text !== 'string' || await hash(now.text) !== copied.hash) return
  await clip('write', '')
}

export function initClipboard(): void {
  ext.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void clearIfDue() })
}
