/**
 * One unlock in this browser (docs/reference/passwords.md, "One unlock on this computer"): while the
 * extension holds an unlock, the Walnut page it is paired with, open in a tab of this browser, gets
 * its browser key from the extension, so the first visit to Walnut's Passwords page after an unlock
 * in the extension asks for no master password.
 *
 * The background half (this file): the page script on a Walnut page (page-browser-key.ts) sends
 * the key its page keeps, if any; the background asks Walnut (POST /vault/browser-key, with its
 * device token and its own vault session) and answers with the key to write, or nothing when the
 * page's key is already one Walnut knows. Only for the top frame of a tab whose origin is exactly
 * the address this extension is paired with: never another site, another loopback name of it, or
 * a frame. And after an unlock here, every such tab open now is offered one at once.
 */
import { ext, type Sender } from './ext'
import { call, connection, vaultSession } from './walnut-api'
import { originOf, type Reply } from './bg-vault'

/** The page script's question (background.ts routes it here, from content scripts only). */
export const BROWSER_KEY_MESSAGE = 'browser-key'
/** The background's nudge to a Walnut tab open now (page-browser-key.ts asks again). */
export const BROWSER_KEY_OFFER = 'browser-key-offer'

const keyShape = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)

/** The key Walnut last said it knows, under the unlock it said so for: the same page asking again costs no request. */
let lastKnown: { token: string; key: string } | null = null

/**
 * The origin of a message's page when it is the top frame of a tab at exactly `serverUrl` (the paired
 * Walnut, an origin: walnut-api.ts cleanServerUrl), else null: never a frame, another site, another
 * loopback name or port of it.
 */
export function pairedTopOrigin(serverUrl: string | undefined, sender: Sender): string | null {
  if (!serverUrl || sender.tab?.id === undefined || sender.frameId !== 0) return null
  const origin = String(sender.origin ?? originOf(String(sender.url ?? '')))
  return origin && origin === serverUrl ? origin : null
}

async function pairedTop(sender: Sender): Promise<string | null> {
  return pairedTopOrigin((await connection())?.serverUrl, sender)
}

export async function handBrowserKey(msg: { [k: string]: unknown }, sender: Sender): Promise<Reply> {
  const origin = await pairedTop(sender)
  if (!origin) return { ok: false, silent: true }
  return keyFor(msg, origin)
}

/**
 * The side panel's and the popup's own Walnut frame (`panel-browser-key`, from those extension
 * pages only, background.ts ALLOWED): it is no tab, so no page script runs in it, and its approval
 * cards read Passwords as locked while the key over them, the extension's, read it unlocked (review
 * round 5, Opus #3: an agent's purchase asked for the master password in an unlocked window). The
 * page asks for its frame (panel-page.ts), with the key the frame keeps, and posts the answer only
 * to the paired Walnut's origin.
 */
export async function handPanelBrowserKey(msg: { [k: string]: unknown }): Promise<Reply> {
  const origin = (await connection())?.serverUrl
  if (!origin) return { ok: false, silent: true }
  return keyFor(msg, origin)
}

async function keyFor(msg: { [k: string]: unknown }, origin: string): Promise<Reply> {
  const token = await vaultSession()
  if (!token) return { ok: false, code: 'locked' }
  const presented = keyShape(msg.key) ? msg.key : undefined
  if (presented && lastKnown?.token === token && lastKnown.key === presented) return { ok: true, known: true }
  const r = await call<{ browserKey?: string; known?: boolean }>('POST', '/vault/browser-key', presented ? { browserKey: presented } : {}, { quiet: true, timeoutMs: 8000 })
  if (!keyShape(r.browserKey)) return { ok: false }
  lastKnown = { token, key: r.browserKey }
  return r.known ? { ok: true, known: true } : { ok: true, key: r.browserKey, origin }
}

let offerTimer: ReturnType<typeof setTimeout> | null = null

/** After an unlock (the extension's own or a share), the paired Walnut's tabs open now ask for their key. */
async function offerOpenTabs(): Promise<void> {
  const conn = await connection()
  if (!conn || !(await vaultSession())) return
  for (const t of await ext.tabs.query({})) {
    if (t.id !== undefined && t.url && originOf(t.url) === conn.serverUrl) {
      void ext.tabs.sendMessage(t.id, { type: BROWSER_KEY_OFFER }, { frameId: 0 }).catch(() => undefined)
    }
  }
}

export function initHandBrowserKey(): void {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !('vaultSession' in changes)) return
    if (!changes.vaultSession.newValue) { lastKnown = null; return }
    // One unlock writes its mark twice (walnut-api.ts setVaultSession): one offer.
    if (offerTimer) clearTimeout(offerTimer)
    offerTimer = setTimeout(() => { offerTimer = null; void offerOpenTabs().catch(() => undefined) }, 300)
  })
}
