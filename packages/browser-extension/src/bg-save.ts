/**
 * Offering to save a login just sent, or to update a saved one: the bar shows what was sent,
 * lets the person correct the username and password, and pick which saved login of the site to
 * update when there are several. "Never for this site" lists stay in storage.local; the popup's
 * Settings shows them and takes them off.
 */
import { ext, type Sender } from './ext'
import { ApiError, api, connection, vaultSession } from './walnut-api'
import { displayHost, matchItem } from '../../../src/core/vault/url-match'
import { touch } from './bg-autolock'
import { COVERED, openUnlock, stillShown } from './bg-fill'
import { PENDING_MS, forget, isWalnutPage, nonce, originOf, siteOf, state, stores, summaries, type Choice, type Pending, type Reply } from './bg-vault'

/** A pending login shows on another site's page only right after it was sent (a sign-in that lands elsewhere). */
export const ELSEWHERE_MS = 20_000
/** The strong password the menu made waits this long for its sign-up to be sent. */
export const GENERATED_MS = 10 * 60_000
/** At most this many saved logins are compared with one sent. */
const MAX_CHOICES = 10

export async function neverSites(): Promise<string[]> {
  const { neverSave } = await ext.storage.local.get('neverSave')
  return Array.isArray(neverSave) ? neverSave as string[] : []
}

/** A login sent on a page: offer to save it, or to update a saved one whose password differs. */
async function seenLogin(tabId: number, url: string, username: string | undefined, password: string, keep?: { at: number; nonce: string }): Promise<Pending | null> {
  const { seenUsername, pendingSave, lastLogin } = stores
  if (!(await connection())) return null
  if ((await neverSites()).includes(siteOf(url))) return null
  const step = await seenUsername.get(tabId)
  if (step && Date.now() - step.at > PENDING_MS) await seenUsername.sweep((x) => Date.now() - x.at > PENDING_MS)
  if (!username && step && Date.now() - step.at < PENDING_MS && siteOf(step.url) === siteOf(url)) username = step.username
  let p: Pending = { url, ...(username ? { username } : {}), password, kind: 'save', title: displayHost(url), at: keep?.at ?? Date.now(), checked: false, nonce: keep?.nonce ?? nonce() }
  if (await vaultSession()) {
    try {
      const matches = (await summaries()).filter((i) => i.type === 'login' && matchItem(i.urls, url)).slice(0, MAX_CHOICES)
      p.checked = true
      const same = matches.filter((i) => (i.username ?? '') === (username ?? ''))
      // No username on the page (a password-only step): any login of the site may be the one.
      const candidates = same.length ? same : !username ? matches : []
      for (const c of candidates) {
        const item = await api.item(c.id)
        if (item.password === password) {
          // Nothing new: the login is a saved one, and its code page may follow.
          await lastLogin.set(tabId, { itemId: item.id, url, hasTotp: !!item.totp, at: Date.now() })
          return null
        }
      }
      const choices: Choice[] = matches.map((i) => ({ id: i.id, title: i.title, ...(i.username ? { username: i.username } : {}) }))
      if (choices.length) p.choices = choices
      if (candidates.length) p = { ...p, kind: 'update', itemId: candidates[0].id, title: candidates[0].title }
    } catch (err) {
      if (!(err instanceof ApiError && (err.code === 'vault_session_needed' || err.code === 'vault_locked'))) throw err
      p = { ...p, kind: 'save', checked: false }
    }
  }
  await pendingSave.set(tabId, p)
  return p
}

export async function showSaveBar(tabId: number): Promise<void> {
  const p = await stores.pendingSave.get(tabId)
  if (!p) return
  await ext.tabs.sendMessage(tabId, { type: 'show-savebar', nonce: p.nonce }, { frameId: 0 }).catch(() => undefined)
}

async function pendingOf(tabId: number | undefined, msg: Record<string, unknown>): Promise<Pending | undefined> {
  const { pendingSave } = stores
  const p = tabId !== undefined ? await pendingSave.get(tabId) : undefined
  if (p && Date.now() - p.at > PENDING_MS) { await pendingSave.sweep((x) => Date.now() - x.at > PENDING_MS); return undefined }
  return p && typeof msg.nonce === 'string' && msg.nonce === p.nonce ? p : undefined
}

/** The top page of a tab with a login waiting gets the save bar's nonce, to show it. */
export async function barNonceFor(tabId: number, page: string): Promise<string | undefined> {
  const p = await stores.pendingSave.get(tabId)
  return p && Date.now() - p.at < PENDING_MS && (siteOf(p.url) === siteOf(page) || Date.now() - p.at < ELSEWHERE_MS) ? p.nonce : undefined
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)

export async function handleSave(msg: { type: string; [k: string]: unknown }, sender: Sender): Promise<Reply> {
  const tabId = sender.tab?.id
  const { pendingSave, generated, seenUsername } = stores
  switch (msg.type) {
    case 'seen-login': {
      if (tabId === undefined || typeof msg.password !== 'string' || !msg.password) return { ok: false }
      const url = String(sender.url ?? '')
      if (await isWalnutPage(url)) return { ok: false }
      // Only what the person typed, or the strong password Walnut just made here, is offered:
      // a page that fills a field itself and sends the form offers nothing.
      const made = await generated.get(tabId)
      const ours = !!made && Date.now() - made.at < GENERATED_MS && made.password === msg.password && siteOf(made.url) === siteOf(url)
      if (msg.typed !== true && !ours) return { ok: true, offered: false }
      const p = await seenLogin(tabId, url, typeof msg.username === 'string' && msg.username ? msg.username : undefined, msg.password)
      if (ours) await generated.delete(tabId)
      // A page that sends without leaving (a single-page app) gets the bar now; one that leaves gets it on the next page.
      if (p) setTimeout(() => void showSaveBar(tabId), 600)
      return { ok: true, offered: !!p }
    }
    case 'seen-username': {
      if (tabId !== undefined && typeof msg.username === 'string' && msg.username) await seenUsername.set(tabId, { url: String(sender.url ?? ''), username: msg.username, at: Date.now() })
      return { ok: true }
    }
    case 'savebar-data': {
      let p = await pendingOf(tabId, msg)
      if (tabId === undefined || !p) return { ok: false }
      const st = await state()
      if (st.unlocked && !p.checked) {
        // Seen while locked: now that it is open, is it new, a changed password, or one already saved?
        const again = await seenLogin(tabId, p.url, p.username, p.password, { at: p.at, nonce: p.nonce })
        if (!again) { await pendingSave.delete(tabId); return { ok: false } }
        p = again
      }
      if (!st.unlocked) return { ok: true, kind: 'locked', site: displayHost(p.url), username: p.username ?? '', title: p.title ?? '' }
      // The save bar is the extension's own page: it may show the password the person sent, to correct it.
      return { ok: true, kind: p.kind, site: displayHost(p.url), username: p.username ?? '', password: p.password, title: p.title ?? '', itemId: p.itemId ?? '', choices: p.choices ?? [] }
    }
    case 'savebar-action': {
      if (tabId === undefined) return { ok: false }
      const action = String(msg.action)
      const hide = () => ext.tabs.sendMessage(tabId, { type: 'hide-savebar' }, { frameId: 0 }).catch(() => undefined)
      const p = await pendingOf(tabId, msg)
      if (action === 'close') { await hide(); return { ok: true } }
      if (!p) { await hide(); return { ok: false } }
      if (action === 'unlock') { await openUnlock(); return { ok: true } }
      // "Not now" needs no check: it only drops the login.
      if (action !== 'later' && !(await stillShown(tabId, 0, 'bar'))) return COVERED
      void touch()
      // What the person corrected in the bar, else what was sent.
      const username = text(msg.username, 500)?.trim() ?? p.username ?? ''
      const password = text(msg.password, 4000) || p.password
      if (action === 'never') {
        const list = await neverSites()
        await ext.storage.local.set({ neverSave: [...new Set([...list, siteOf(p.url)])] })
      } else if (action === 'save') {
        await api.create({ type: 'login', title: String(msg.title || p.title || displayHost(p.url)).slice(0, 200), ...(username ? { username } : {}), password, urls: [originOf(p.url)] })
        forget()
      } else if (action === 'update') {
        // Only a login this site's bar offered may be updated from it.
        const id = typeof msg.itemId === 'string' && msg.itemId ? msg.itemId : p.itemId
        if (!id || !(id === p.itemId || p.choices?.some((c) => c.id === id))) return { ok: false, error: 'Pick the login to update.' }
        const item = await api.item(id)
        const { id: _i, createdAt: _c, updatedAt, passwordHistory: _h, usedAt: _u, trashedAt: _t, ...rest } = item
        await api.update(item.id, { ...rest, ...(username ? { username } : {}), password }, updatedAt)
        forget()
      }
      await pendingSave.delete(tabId)
      // A save or an update shows its confirmation, then closes itself; the rest close now.
      if (action !== 'save' && action !== 'update') await hide()
      return { ok: true }
    }
    case 'savebar-size': {
      if (tabId !== undefined && await pendingOf(tabId, msg)) await ext.tabs.sendMessage(tabId, { type: 'savebar-size', height: msg.height }, { frameId: 0 }).catch(() => undefined)
      return { ok: true }
    }
  }
  return { ok: false, error: `Unknown message ${msg.type}` }
}
