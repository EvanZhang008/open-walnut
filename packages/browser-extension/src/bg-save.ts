/**
 * Offering to save a login just sent, or to update a saved one: the bar shows what was sent,
 * lets the person correct the username and password, and pick which saved login of the site to
 * update when there are several. "Never for this site" lists stay in storage.local; the popup's
 * Settings shows them and takes them off.
 */
import { ext, type Sender } from './ext'
import { ApiError, api, connection, vaultSession } from './walnut-api'
import { displayHost } from '../../../src/core/vault/url-match'
import { touch } from './bg-autolock'
import { COVERED, openUnlock, stillShown } from './bg-fill'
import { CODE_PAGE_MS, PENDING_MS, forget, isWalnutPage, matchesFor, nonce, originOf, siteOf, state, stores, summaries, type Choice, type Pending, type Reply } from './bg-vault'
import { defaultLoginName, neverCovers, neverEntry, pickUpdate, type UpdateCandidate } from './login-pick'

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

/** What a page sent: the login, and on a change form the password it replaces. */
interface Sent { username?: string; password: string; current?: string; siteName?: string; title?: string }

/** A login sent on a page: offer to save it, or to update a saved one whose password differs. */
async function seenLogin(tabId: number, url: string, sent: Sent, keep?: { at: number; nonce: string; title?: string }): Promise<Pending | null> {
  const { seenUsername, pendingSave, lastLogin } = stores
  if (!(await connection())) return null
  if (neverCovers(await neverSites(), url)) return null
  let { username } = sent
  const { password, current } = sent
  const step = await seenUsername.get(tabId)
  if (step && Date.now() - step.at > PENDING_MS) await seenUsername.sweep((x) => Date.now() - x.at > PENDING_MS)
  if (!username && step && Date.now() - step.at < PENDING_MS && siteOf(step.url) === siteOf(url)) username = step.username
  const title = keep?.title ?? defaultLoginName({ url, metaName: sent.siteName, title: sent.title })
  let p: Pending = { url, ...(username ? { username } : {}), password, kind: 'save', title, at: keep?.at ?? Date.now(), checked: false, nonce: keep?.nonce ?? nonce() }
  if (current) p.current = current
  if (await vaultSession()) {
    try {
      // Only logins of this host and its parent or child hosts (tier 1), this host's first.
      const tier1 = (await matchesFor(url)).slice(0, MAX_CHOICES)
      const exact = new Map(tier1.map((m) => [m.id, m.exact]))
      const byId = new Map((await summaries()).map((i) => [i.id, i]))
      const matches = tier1.map((m) => byId.get(m.id)!).filter(Boolean)
      p.checked = true
      const full: UpdateCandidate[] = []
      for (const c of matches) {
        const item = await api.item(c.id)
        full.push({ id: item.id, ...(item.username ? { username: item.username } : {}), ...(item.password ? { password: item.password } : {}), exact: !!exact.get(item.id), ...(c.usedAt ? { usedAt: c.usedAt } : {}) })
      }
      const sameUser = full.filter((i) => (i.username ?? '') === (username ?? ''))
      // No username on the page (a password-only step, or a change form that hides it): any login of
      // the site may be the one; a username no saved login has may still be one whose current password this is.
      const candidates = sameUser.length ? sameUser : !username ? full : current ? full.filter((i) => i.password === current) : []
      const unchanged = candidates.find((c) => c.password === password)
      if (unchanged) {
        // Nothing new: the login is a saved one, and its code page may follow.
        const item = await api.item(unchanged.id)
        await lastLogin.set(tabId, { itemId: item.id, url, hasTotp: !!item.totp, at: Date.now() })
        return null
      }
      const choices: Choice[] = matches.map((i) => ({ id: i.id, title: i.title, ...(i.username ? { username: i.username } : {}) }))
      if (choices.length) p.choices = choices
      const last = await lastLogin.get(tabId)
      const lastId = last && Date.now() - last.at < CODE_PAGE_MS && siteOf(last.url) === siteOf(url) ? last.itemId : undefined
      const target = pickUpdate(candidates, current, lastId)
      // `title` stays the name a new login would get: the bar names the login it updates from `choices`.
      if (target) p = { ...p, kind: 'update', itemId: target }
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

/** A bar that just saved or updated still shows its confirmation and resizes for it, this long. */
const DONE_MS = 8_000
const doneBars = new Map<number, { nonce: string; until: number }>()
const doneBar = (tabId: number, n: unknown) => { const d = doneBars.get(tabId); return !!d && d.nonce === n && Date.now() < d.until }

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
      const p = await seenLogin(tabId, url, {
        ...(typeof msg.username === 'string' && msg.username ? { username: msg.username.slice(0, 500) } : {}),
        password: msg.password,
        ...(typeof msg.current === 'string' && msg.current ? { current: msg.current.slice(0, 4000) } : {}),
        // The name the site gives itself (the page script reads og:site_name or application-name), else its title.
        ...(typeof msg.siteName === 'string' && msg.siteName ? { siteName: msg.siteName.slice(0, 200) } : {}),
        ...(sender.tab?.title ? { title: sender.tab.title.slice(0, 300) } : {}),
      })
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
        const again = await seenLogin(tabId, p.url, { ...(p.username ? { username: p.username } : {}), password: p.password, ...(p.current ? { current: p.current } : {}) }, { at: p.at, nonce: p.nonce, ...(p.title ? { title: p.title } : {}) })
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
        // This host only: a sibling part of the site keeps its offers.
        const entry = neverEntry(p.url)
        if (entry) await ext.storage.local.set({ neverSave: [...new Set([...list, entry])] })
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
      else doneBars.set(tabId, { nonce: p.nonce, until: Date.now() + DONE_MS })
      return { ok: true }
    }
    case 'savebar-size': {
      if (tabId !== undefined && (doneBar(tabId, msg.nonce) || await pendingOf(tabId, msg))) await ext.tabs.sendMessage(tabId, { type: 'savebar-size', height: msg.height }, { frameId: 0 }).catch(() => undefined)
      return { ok: true }
    }
  }
  return { ok: false, error: `Unknown message ${msg.type}` }
}
