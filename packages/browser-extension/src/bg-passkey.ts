/**
 * Passkeys in the background (docs/reference/passwords.md, "Passkeys in the browser").
 *
 * While "Save and use passkeys" is on, two scripts are registered for top frames: the page-world
 * wrapper of navigator.credentials (passkey-page.ts) and its bridge (passkey-bridge.ts). Off, both
 * are unregistered: nothing of this runs in any page.
 *
 * A request from a page: the origin is the browser's word for the frame that asked (sender), never
 * the page's. Requests Walnut does not take, and sign-ins for a site Walnut keeps no passkey for, go
 * back to the browser at once, before any window. The rest open Walnut's own window (passkey.html,
 * passkey.ts), where the person picks, unlocks if needed and says yes (Touch ID through the
 * extension's confirm key, or the master password); the server checks that yes (begin, approve) and
 * only then makes or signs. Closing the window, Cancel, the page aborting or navigating, all end it.
 */
import { ext, type Sender } from './ext'
import { ApiError, api, connection, vaultSession, type PasskeyMatch } from './walnut-api'
import { getSettings } from './settings'
import { busyWaitOf, throwingWhileUnlockBusy } from '../../../src/core/vault/unlock-retry'
import {
  answeredExtensions, clientDataJSON, leaveCreate, leaveGet,
  type WireAnswer, type WireCreate, type WireGet,
} from './passkey-wire'

type Reply = Record<string, unknown> & { ok: boolean }

const SCRIPT_IDS = ['walnut-passkey-page', 'walnut-passkey-bridge']
const SITES = ['http://*/*', 'https://*/*']
/** A request the person has not answered by then ends (a site's own timeout is usually shorter). */
const MAX_WAIT_MS = 4 * 60_000
const WINDOW = { type: 'popup', width: 420, height: 480, focused: true } as const

interface Pending {
  key: string
  pageId: string
  tabId: number
  /** The browser window of the asking tab, focused again when the request goes back to the browser. */
  tabWindowId?: number
  origin: string
  op: 'create' | 'get'
  wire: WireCreate | WireGet
  clientData: string
  matches: PasskeyMatch[]
  approvalId?: string
  windowId?: number
  resolve: (a: WireAnswer) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()

type Scripting = {
  registerContentScripts(s: unknown[]): Promise<void>
  unregisterContentScripts(f?: { ids: string[] }): Promise<void>
  getRegisteredContentScripts(f?: { ids: string[] }): Promise<Array<{ id: string }>>
}
const scripting = () => (ext as unknown as { scripting?: Partial<Scripting> }).scripting

/** Register or unregister the page scripts to match the setting; one at a time, so a quick on-off ends off. */
let syncing: Promise<void> = Promise.resolve()
export function syncPasskeyScripts(): Promise<void> {
  syncing = syncing.then(syncScriptsNow, syncScriptsNow)
  return syncing
}

async function syncScriptsNow(): Promise<void> {
  const s = scripting()
  if (!s?.registerContentScripts || !s.getRegisteredContentScripts || !s.unregisterContentScripts) return
  const on = (await getSettings()).passkeys
  const have = (await s.getRegisteredContentScripts({ ids: SCRIPT_IDS }).catch(() => [])).map((x) => x.id)
  if (!on) {
    if (have.length) await s.unregisterContentScripts({ ids: have }).catch(() => undefined)
    return
  }
  if (have.length === SCRIPT_IDS.length) return
  if (have.length) await s.unregisterContentScripts({ ids: have }).catch(() => undefined)
  await s.registerContentScripts([
    { id: SCRIPT_IDS[0], js: ['passkey-page.js'], matches: SITES, runAt: 'document_start', allFrames: false, world: 'MAIN', persistAcrossSessions: true },
    { id: SCRIPT_IDS[1], js: ['passkey-bridge.js'], matches: SITES, runAt: 'document_start', allFrames: false, persistAcrossSessions: true },
  ])
}

const err = (name: Extract<WireAnswer, { kind: 'error' }>['name'], message: string): WireAnswer => ({ kind: 'error', name, message })
const leave = (why: string): Reply => ({ ok: true, answer: { kind: 'leave', why } })

/**
 * The browser's own word for where the asking frame is: its top frame, http(s), the tab's own
 * origin. An opaque origin ("null": a sandboxed page, as a site may serve its users' uploads) never
 * asks: the browser's own WebAuthn refuses it, and its URL's origin is not its own. `frameOrigin`
 * is the bridge's `self.origin`, which the page cannot change (Firefox gives no sender.origin).
 */
function originOf(sender: Sender, frameOrigin: unknown): string | null {
  if (sender.frameId !== 0 || sender.tab?.id === undefined) return null
  if (sender.origin === 'null' || typeof frameOrigin !== 'string' || frameOrigin === 'null') return null
  let o: string
  try { o = sender.origin ?? new URL(String(sender.url)).origin } catch { return null }
  if (!/^https?:\/\//.test(o) || frameOrigin !== o) return null
  try { if (sender.tab.url && new URL(sender.tab.url).origin !== o) return null } catch { return null }
  return o
}

/** WebAuthn's rule, before any window: the rp id is the page's host or a parent of it (the server checks the public suffix list too). */
function rpFits(origin: string, rpId: string | undefined): boolean {
  if (!rpId) return true
  const host = new URL(origin).hostname.toLowerCase()
  const rp = rpId.toLowerCase()
  return host === rp || (host.endsWith(`.${rp}`) && rp.includes('.'))
}

const busyWaitOfError = (e: unknown) => (e instanceof ApiError ? busyWaitOf(e) : null)

/** Each tab's latest request: a newer one makes an older one, still starting, give way (one window per tab). */
const tabSeq = new Map<number, number>()

/** The site's request as the server takes it (the client data made here, from the browser's origin). */
function requestOf(p: Pending, credentialId?: string): Record<string, unknown> {
  if (p.op === 'get') {
    const w = p.wire as WireGet
    return { origin: p.origin, ...(w.rpId ? { rpId: w.rpId } : {}), credentialId, clientDataJSON: p.clientData }
  }
  const w = p.wire as WireCreate
  return {
    origin: p.origin, ...(w.rp.id ? { rpId: w.rp.id } : {}), ...(w.rp.name ? { rpName: w.rp.name } : {}),
    user: w.user, exclude: w.exclude.map((d) => d.id), clientDataJSON: p.clientData,
  }
}

function end(p: Pending, a: WireAnswer, opts: { keepWindow?: boolean } = {}): void {
  if (!pending.has(p.key)) return
  pending.delete(p.key)
  clearTimeout(p.timer)
  if (p.approvalId && a.kind !== 'created' && a.kind !== 'asserted') void api.passkeyCancel(p.approvalId)
  const hadWindow = p.windowId !== undefined && !opts.keepWindow
  if (hadWindow) void (ext.windows as unknown as { remove?(id: number): Promise<void> }).remove?.(p.windowId!).catch(() => undefined)
  // Going back to the browser's own dialog: the browser takes a request only from a focused page,
  // so the site's window gets the focus back before the page asks it (the page also waits for it).
  if (hadWindow && a.kind === 'leave') void focusTab(p).finally(() => p.resolve(a))
  else p.resolve(a)
}

async function focusTab(p: Pending): Promise<void> {
  const w = ext.windows as unknown as { update?(id: number, info: { focused: boolean }): Promise<unknown> }
  const t = ext.tabs as unknown as { update?(id: number, info: { active: boolean }): Promise<unknown> }
  await Promise.all([
    p.tabWindowId !== undefined ? w.update?.(p.tabWindowId, { focused: true })?.catch(() => undefined) : undefined,
    t.update?.(p.tabId, { active: true })?.catch(() => undefined),
  ])
}

/**
 * What the server says before any yes (needs an open vault): for a sign-in, the passkeys it keeps
 * for the site (none: back to the browser); for a new one, that the site may have one (public
 * suffixes too: throws passkey_rp) and that none it keeps is in the page's exclude list.
 */
async function siteChecks(op: 'create' | 'get', wire: WireCreate | WireGet, origin: string): Promise<PasskeyMatch[] | WireAnswer | null> {
  if (op === 'get') {
    const g = wire as WireGet
    const matches = await api.passkeyMatch({ origin, ...(g.rpId ? { rpId: g.rpId } : {}), allow: g.allow.map((d) => d.id) })
    return matches.length ? matches : { kind: 'leave', why: 'none-here' }
  }
  const c = wire as WireCreate
  const rp = c.rp.id ? { rpId: c.rp.id } : {}
  await api.passkeyMatch({ origin, ...rp, allow: [] })
  if (c.exclude.length && (await api.passkeyMatch({ origin, ...rp, allow: c.exclude.map((d) => d.id) })).length) {
    return err('InvalidStateError', 'Walnut already keeps a passkey for this account on this site.')
  }
  return null
}

/** A page's request (passkey-bridge.ts). Answers when the person is done, or at once when Walnut leaves it. */
export async function passkeyRequest(msg: { [k: string]: unknown; id?: unknown; op?: unknown; wire?: unknown }, sender: Sender): Promise<Reply> {
  const origin = originOf(sender, msg.frameOrigin)
  const tabId0 = sender.tab?.id
  const seq = tabId0 === undefined ? 0 : (tabSeq.get(tabId0) ?? 0) + 1
  if (tabId0 !== undefined) tabSeq.set(tabId0, seq)
  if (!(await getSettings()).passkeys) return leave('off')
  if (!origin || typeof msg.id !== 'string' || (msg.op !== 'create' && msg.op !== 'get') || !msg.wire || typeof msg.wire !== 'object') return leave('not-here')
  const op = msg.op
  const wire = msg.wire as WireCreate | WireGet
  if (typeof wire.challenge !== 'string' || !wire.challenge) return leave('bad-request')
  const why = op === 'create' ? leaveCreate(wire as WireCreate) : leaveGet(wire as WireGet)
  if (why) return leave(why)
  const rpId = op === 'create' ? (wire as WireCreate).rp.id : (wire as WireGet).rpId
  if (!rpFits(origin, rpId)) return { ok: true, answer: err('SecurityError', 'This page may not use a passkey for that site.') }
  // As the browser's own: a tab the person is not looking at gets no window, and while one is open
  // for a tab, a newer request from it is refused (a page asking again and again never takes focus).
  if (sender.tab?.active === false) return { ok: true, answer: err('NotAllowedError', 'The page is not focused.') }
  if ([...pending.values()].some((p) => p.tabId === sender.tab!.id)) return { ok: true, answer: err('NotAllowedError', 'A passkey request is already open for this page.') }
  if (!(await connection())) return leave('not-connected')
  const tabId = sender.tab!.id!
  const superseded = () => tabSeq.get(tabId) !== seq

  const clientData = clientDataJSON(op === 'create' ? 'webauthn.create' : 'webauthn.get', wire.challenge, origin)
  let matches: PasskeyMatch[] = []
  if (await vaultSession()) {
    try {
      const early = await siteChecks(op, wire, origin)
      if (Array.isArray(early)) matches = early
      else if (early) return { ok: true, answer: early }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'passkey_rp') return { ok: true, answer: err('SecurityError', 'This page may not use a passkey for that site.') }
      if (!(e instanceof ApiError && (e.code === 'vault_session_needed' || e.code === 'vault_locked'))) return leave('walnut-error')
    }
  }

  // A newer request from this tab came while this one was starting: it gives way, without a window.
  if (superseded()) return { ok: true, answer: err('NotAllowedError', 'Another passkey request replaced this one.') }
  // The page gave up while this was starting.
  if (abortedEarly.delete(`${tabId}:${String(msg.id)}`)) return { ok: true, answer: err('AbortError', 'The operation was aborted.') }
  // One window per tab: one opened for it meanwhile keeps it.
  if ([...pending.values()].some((p) => p.tabId === tabId)) return { ok: true, answer: err('NotAllowedError', 'A passkey request is already open for this page.') }
  return new Promise<Reply>((resolveReply) => {
    const key = crypto.randomUUID()
    const p: Pending = {
      key, pageId: msg.id as string, tabId, ...(sender.tab?.windowId !== undefined ? { tabWindowId: sender.tab.windowId } : {}), origin, op, wire, clientData, matches,
      resolve: (answer) => resolveReply({ ok: true, answer }),
      timer: setTimeout(() => end(p, err('NotAllowedError', 'The request timed out.')), MAX_WAIT_MS),
    }
    pending.set(key, p)
    void ext.windows.create({ url: ext.runtime.getURL(`passkey.html?k=${encodeURIComponent(key)}`), ...WINDOW }).then(
      (win) => {
        p.windowId = win.id
        // The request ended while the window was being made (the page gave up, the tab went): it closes too.
        if (!pending.has(p.key) && win.id !== undefined) void (ext.windows as unknown as { remove?(id: number): Promise<void> }).remove?.(win.id).catch(() => undefined)
      },
      () => end(p, { kind: 'leave', why: 'no-window' }),
    )
  })
}

/** Requests a page gave up while they were still starting (no window yet): they never get one. */
const abortedEarly = new Set<string>()

/** The page gave up (its AbortSignal): the window closes, or never opens. */
export function passkeyPageCancel(msg: { [k: string]: unknown; id?: unknown }, sender: Sender): Reply {
  let found = false
  for (const p of pending.values()) if (p.pageId === msg.id && p.tabId === sender.tab?.id) { found = true; end(p, err('AbortError', 'The operation was aborted.')) }
  if (!found && typeof msg.id === 'string' && sender.tab?.id !== undefined && abortedEarly.size < 100) {
    const key = `${sender.tab.id}:${msg.id}`
    abortedEarly.add(key)
    setTimeout(() => abortedEarly.delete(key), 60_000)
  }
  return { ok: true }
}

// ── the window (passkey.ts) ──

const CONFIRM_KEY = 'passkeyConfirmKey'

async function confirmKeyHere(): Promise<string | null> {
  const { [CONFIRM_KEY]: id } = await ext.storage.local.get(CONFIRM_KEY)
  if (typeof id !== 'string' || !id) return null
  try {
    // Removed in Walnut (or another vault): forget it here too.
    if (!(await api.confirmKeys()).some((k) => k.id === id)) { await ext.storage.local.remove(CONFIRM_KEY); return null }
  } catch { return null }
  return id
}

function windowData(p: Pending, locked: boolean, confirmKey: string | null): Reply {
  const host = new URL(p.origin).hostname
  const c = p.op === 'create' ? (p.wire as WireCreate) : null
  return {
    ok: true, op: p.op, origin: p.origin, site: (c?.rp.id ?? (p.wire as WireGet).rpId) || host,
    ...(c ? { rpName: c.rp.name ?? '', userName: c.user.name ?? '', userDisplayName: c.user.displayName ?? '' } : {}),
    matches: p.matches, locked, confirmKey,
  }
}

const pendingFor = (k: unknown): Pending | undefined => (typeof k === 'string' ? pending.get(k) : undefined)
const gone = (): Reply => ({ ok: false, error: 'This request has ended. Go back to the site and try again.', code: 'gone' })

/** Every message the passkey window sends. */
export async function passkeyWindow(msg: { type: string; k?: unknown; [x: string]: unknown }, sender: Sender): Promise<Reply> {
  // Touch ID for next time is set up after the request was answered (its window stays a moment): not tied to it.
  if (msg.type === 'passkey-enroll-begin') return { ok: true, ...(await api.confirmEnrollBegin()) }
  if (msg.type === 'passkey-enroll') {
    const passwordKey = await api.passwordKey(String(msg.password ?? ''))
    const c = (msg.credential ?? {}) as Record<string, string>
    const body = { enrollId: String(msg.enrollId ?? ''), credentialId: c.credentialId, publicKey: c.publicKey, clientDataJSON: c.clientDataJSON, authenticatorData: c.authenticatorData, name: String(msg.name ?? 'This browser'), passwordKey }
    // Right after the yes, another check of the master password may still be running on the
    // server (one at a time): wait it out, as an unlock does, rather than lose the Touch ID set-up.
    const r = await throwingWhileUnlockBusy(() => api.confirmEnroll(body), busyWaitOfError)
    await ext.storage.local.set({ [CONFIRM_KEY]: r.key.id })
    return { ok: true }
  }
  const p = pendingFor(msg.k)
  if (msg.type === 'passkey-ping') return { ok: !!p }
  if (!p) return gone()
  // The window belongs to this request: another extension page cannot answer it.
  if (p.windowId !== undefined && sender.tab?.windowId !== undefined && sender.tab.windowId !== p.windowId) return { ok: false, error: 'Not this window' }
  switch (msg.type) {
    case 'passkey-data': {
      const locked = !(await vaultSession())
      return windowData(p, locked, locked ? null : await confirmKeyHere())
    }
    case 'passkey-unlock': {
      await throwingWhileUnlockBusy(() => api.unlock(String(msg.password ?? '')), busyWaitOfError)
      // The checks a locked start could not make, now: their answer goes to the page, as it would have.
      const early = await siteChecks(p.op, p.wire, p.origin).catch((e) => e instanceof ApiError && e.code === 'passkey_rp' ? err('SecurityError', 'This page may not use a passkey for that site.') : Promise.reject(e))
      if (Array.isArray(early)) p.matches = early
      else if (early) { end(p, early); return { ok: true, gone: true } }
      return windowData(p, false, await confirmKeyHere())
    }
    case 'passkey-begin': {
      if (p.approvalId) { void api.passkeyCancel(p.approvalId); p.approvalId = undefined }
      const credentialId = typeof msg.credentialId === 'string' ? msg.credentialId : undefined
      if (p.op === 'get' && !p.matches.some((m) => m.credentialId === credentialId)) return { ok: false, error: 'Pick one of the passkeys shown.' }
      const b = await api.passkeyBegin(p.op, requestOf(p, credentialId))
      p.approvalId = b.id
      return { ok: true, id: b.id, challenge: b.challenge, summary: b.summary }
    }
    case 'passkey-approve': {
      if (!p.approvalId || msg.id !== p.approvalId) return { ok: false, error: 'Start again: verify it is you once more.' }
      const proof = typeof msg.password === 'string'
        ? { passwordKey: await api.passwordKey(msg.password) }
        : { assertion: msg.assertion as Record<string, string> }
      const r = await api.passkeyApprove(p.approvalId, proof)
      p.approvalId = undefined
      const extensions = answeredExtensions(p.wire.extensions)
      const answer: WireAnswer = p.op === 'create'
        ? { kind: 'created', id: String(r.credentialId), clientDataJSON: p.clientData, attestationObject: String(r.attestationObject), authenticatorData: String(r.authenticatorData), publicKey: String(r.publicKey), publicKeyAlgorithm: Number(r.publicKeyAlgorithm), extensions }
        : { kind: 'asserted', id: String(r.credentialId), clientDataJSON: p.clientData, authenticatorData: String(r.authenticatorData), signature: String(r.signature), ...(typeof r.userHandle === 'string' ? { userHandle: r.userHandle } : {}), extensions }
      // The window shows "done" a moment, then closes itself.
      end(p, answer, { keepWindow: true })
      return { ok: true, itemId: r.itemId }
    }
    case 'passkey-leave': end(p, { kind: 'leave', why: 'person' }); return { ok: true }
    case 'passkey-cancel': end(p, err('NotAllowedError', 'The person cancelled.')); return { ok: true }
  }
  return { ok: false, error: `Unknown message ${msg.type}` }
}

/** The person closed the window: the page hears "not allowed", as when it closes the browser's own dialog. */
export function passkeyWindowClosed(windowId: number): void {
  for (const p of pending.values()) if (p.windowId === windowId) end(p, err('NotAllowedError', 'The person closed the passkey window.'))
}

/** The tab went away: its request ends. */
export function passkeyTabGone(tabId: number): void {
  for (const p of pending.values()) if (p.tabId === tabId) end(p, err('AbortError', 'The page went away.'))
}

/**
 * The tab went to another site: the page that asked is gone, so its request ends. A reload or
 * another page of the same site ends it through the bridge (pagehide); a same-page URL change of
 * a single-page app does not end it.
 */
export function passkeyTabChanged(tabId: number, change: { status?: string; url?: string }): void {
  if (!change.url) return
  for (const p of pending.values()) {
    if (p.tabId !== tabId) continue
    let otherSite = true
    try { otherSite = new URL(change.url).origin !== p.origin } catch { /* unreadable: treat as gone */ }
    if (otherSite) end(p, err('AbortError', 'The page went away.'))
  }
}
