/**
 * The in-page menu's messages: what it shows (logins, one-time codes with their countdown, a
 * strong password made to fit the field, cards, identities, or the step that comes first),
 * fills what it picked, and moves the keyboard into it. Every message is answered from the tab
 * and frame that opened the menu, with that menu's nonce.
 */
import { ext, type Sender } from './ext'
import { api } from './walnut-api'
import { displayHost, matchItem, siblingHost } from '../../../src/core/vault/url-match'
import { generate } from '../../../src/core/vault/generator'
import { generateFitting } from './field-rules'
import type { FieldRules } from './field-rules'
import { getSettings } from './settings'
import { clearLater } from './bg-clipboard'
import { walletValues } from './bg-wallet'
import { COVERED, afterLoginFill, credsOf, fillFrames, fillWalletFrame, openUnlock, stillShown } from './bg-fill'
import { CODE_PAGE_MS, PENDING_MS, insecureFor, isLockedError, matchesFor, nonce, originOf, siteOf, state, stores, tiersOf, walletItems, type MenuOwner, type Reply } from './bg-vault'
import { cleanAccount, domainOf, namedFirst, stepOneFirst } from './login-pick'

const WALLET = new Set(['card', 'identity'])

/** The menu of the sender's tab, when the message carries its nonce. */
async function menuOf(tabId: number | undefined, msg: Record<string, unknown>): Promise<MenuOwner | undefined> {
  const owner = tabId !== undefined ? await stores.menus.get(tabId) : undefined
  return owner && typeof msg.nonce === 'string' && msg.nonce === owner.nonce ? owner : undefined
}

/** A strong password the field accepts, made the way the person last set the generator. */
async function suggest(rules?: FieldRules): Promise<string> {
  const g = (await getSettings()).generator
  if (g.kind === 'words') {
    const words = generate(g.words)
    // A passphrase only where the field takes it as it is; else a password that fits.
    const fits = (!rules?.maxLength || words.length <= rules.maxLength) && (!rules?.minLength || words.length >= rules.minLength) && !rules?.pattern && !rules?.passwordrules
    if (fits) return words
  }
  return generateFitting(g.random, rules)
}

function cleanRules(r: unknown): FieldRules | undefined {
  if (!r || typeof r !== 'object') return undefined
  const x = r as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 1000 ? v : undefined)
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 500) : undefined)
  const out: FieldRules = { minLength: num(x.minLength), maxLength: num(x.maxLength), pattern: str(x.pattern), passwordrules: str(x.passwordrules) }
  for (const k of Object.keys(out) as Array<keyof FieldRules>) if (out[k] === undefined) delete out[k]
  return out
}

async function closeIt(owner: MenuOwner, refocus = false): Promise<void> {
  await stores.menus.delete(owner.tabId)
  await ext.tabs.sendMessage(owner.tabId, { type: 'close-menu', refocus }, { frameId: owner.frameId }).catch(() => undefined)
}

/** One-time codes for the menu's rows, the login just used first. */
async function withCodes(owner: MenuOwner, items: Awaited<ReturnType<typeof matchesFor>>) {
  const last = await stores.lastLogin.get(owner.tabId)
  const recentId = last && Date.now() - last.at < CODE_PAGE_MS && siteOf(last.url) === siteOf(owner.url) ? last.itemId : ''
  const sorted = [...items.filter((i) => i.hasTotp)].sort((a, b) => Number(b.id === recentId) - Number(a.id === recentId))
  return Promise.all(sorted.slice(0, 8).map(async (i) => ({ ...i, totp: await api.totp(i.id).catch(() => null) })))
}

const pathOf = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname } catch { return u } }

/**
 * Step two of a two-step sign in: the account of step one on this tab (picked from the menu, or
 * typed and sent), when it was on another page of the same site moments ago.
 */
async function stepOneHint(owner: MenuOwner): Promise<{ itemId?: string; username?: string } | undefined> {
  const now = Date.now()
  const last = await stores.lastLogin.get(owner.tabId)
  const typed = await stores.seenUsername.get(owner.tabId)
  const ok = (x: { url: string; at: number } | undefined, ms: number) => !!x && now - x.at < ms && siteOf(x.url) === siteOf(owner.url) && pathOf(x.url) !== pathOf(owner.url)
  const a = ok(last, CODE_PAGE_MS) ? last : undefined
  const b = ok(typed, PENDING_MS) ? typed : undefined
  if (a && (!b || a.at >= b.at)) return { itemId: a.itemId }
  return b ? { username: b.username } : undefined
}

export async function handleMenu(msg: { type: string; [k: string]: unknown }, sender: Sender): Promise<Reply> {
  const tabId = sender.tab?.id
  switch (msg.type) {
    // from the page script
    case 'open-menu': {
      if (tabId === undefined || sender.frameId === undefined) return { ok: false }
      const n = nonce()
      const rules = cleanRules(msg.rules)
      const account = cleanAccount(msg.account)
      await stores.menus.set(tabId, { tabId, frameId: sender.frameId, url: String(sender.url ?? ''), role: String(msg.role), kind: String(msg.kind), nonce: n, ...(rules ? { rules } : {}), ...(account ? { account } : {}) })
      return { ok: true, nonce: n }
    }
    case 'menu-focus': {
      // The person pressed an arrow key in the field: only the frame that opened the menu moves into it.
      const owner = tabId !== undefined ? await stores.menus.get(tabId) : undefined
      if (!owner || owner.frameId !== sender.frameId) return { ok: false }
      void ext.runtime.sendMessage({ type: 'menu-focus', nonce: owner.nonce, where: msg.where === 'last' ? 'last' : 'first', pick: msg.pick === true }).catch(() => undefined)
      return { ok: true }
    }
  }
  const owner = await menuOf(tabId, msg)
  if (!owner) return { ok: false }
  switch (msg.type) {
    case 'menu-data': {
      const st = await state()
      const base = { ok: true, role: owner.role, kind: owner.kind, site: displayHost(owner.url) }
      if (!st.connected) return { ...base, state: 'not-connected' }
      if (!st.unlocked) return { ...base, state: 'locked' }
      // Walnut ended this browser's unlock (Lock all, a Lock elsewhere): the menu's lock view, never an error.
      try {
        if (WALLET.has(owner.role)) return { ...base, state: 'unlocked', items: await walletItems(owner.role as 'card' | 'identity') }
        if (owner.role === 'totp') return { ...base, state: 'unlocked', items: await withCodes(owner, await matchesFor(owner.url)) }
        const { first, others } = await tiersOf(owner.url)
        const insecure = first.length || others.length ? 0 : await insecureFor(owner.url)
        // Logins saved for other parts of this site: listed apart, under their own heading.
        const apart = others.length ? { others, othersDomain: domainOf(owner.url) } : {}
        // The login the page names first (its account), else step one's on step two.
        const named = namedFirst(first, owner.account)
        if (owner.role === 'new-password') {
          owner.suggestion ??= await suggest(owner.rules)
          await stores.menus.set(owner.tabId, owner)
          return { ...base, state: 'unlocked', items: named ? [...named.items, ...named.more] : first, suggestion: owner.suggestion }
        }
        const { items, more } = named ?? stepOneFirst(first, await stepOneHint(owner))
        return { ...base, state: 'unlocked', items, ...(more.length ? { more } : {}), ...apart, insecure }
      } catch (err) {
        if (isLockedError(err)) return { ...base, state: 'locked' }
        throw err
      }
    }
    case 'menu-codes': {
      // The countdown ran out: the next codes.
      const items = await matchesFor(owner.url)
      return { ok: true, items: await withCodes(owner, items) }
    }
    case 'menu-fill': {
      if (!(await stillShown(owner.tabId, owner.frameId, 'menu'))) return COVERED
      const item = await api.item(String(msg.id))
      if (WALLET.has(owner.role)) {
        if (item.type !== owner.role) return { ok: false, error: 'That item is not for this form.' }
        const filled = await fillWalletFrame(owner.tabId, owner.frameId, walletValues(item) as Record<string, string>, owner.role, owner.url)
        if (!filled) return { ok: false, error: 'Walnut found no field here to put it in.' }
        void api.used(item.id)
        await closeIt(owner)
        return { ok: true }
      }
      // A login of this host (tier 1), or one of another part of the site the person picked from its own list (tier 2).
      const tier1 = !!matchItem(item.urls, owner.url)
      if (!tier1 && (owner.role === 'totp' || !siblingHost(item.urls, owner.url))) return { ok: false, error: 'That login is saved for another site, so Walnut does not fill it here.' }
      if (owner.role === 'totp') {
        const filled = await fillFrames(owner.tabId, owner.frameId, { totp: (await api.totp(item.id)).code }, 'totp', owner.url)
        if (!filled) return { ok: false, error: 'Walnut found no code field here to put it in.' }
        void api.used(item.id)
        await closeIt(owner)
        return { ok: true }
      }
      const filled = await fillFrames(owner.tabId, owner.frameId, credsOf(item), 'login', owner.url)
      if (!filled) return { ok: false, error: 'Walnut found no sign-in field here to put it in.' }
      const after = await afterLoginFill(owner.tabId, owner.frameId, item, owner.url)
      // The menu copies the code itself before it closes (it has the person's click).
      if (after.code) return { ok: true, code: after.code }
      await closeIt(owner)
      return { ok: true }
    }
    case 'menu-generate': {
      if (!(await stillShown(owner.tabId, owner.frameId, 'menu'))) return COVERED
      const value = owner.suggestion ?? await suggest(owner.rules)
      // Kept until the sign-up is sent: it is saved then, typed or not.
      await stores.generated.set(owner.tabId, { password: value, url: owner.url, at: Date.now() })
      await ext.tabs.sendMessage(owner.tabId, { type: 'fill-new-password', password: value, origin: originOf(owner.url) }, { frameId: owner.frameId }).catch(() => undefined)
      await closeIt(owner)
      return { ok: true }
    }
    case 'menu-regenerate': {
      owner.suggestion = await suggest(owner.rules)
      await stores.menus.set(owner.tabId, owner)
      return { ok: true, suggestion: owner.suggestion }
    }
    case 'menu-copied': {
      // The menu put the code on the clipboard itself: the page says so, and it is cleared in 30 s.
      if (typeof msg.value === 'string') await clearLater(msg.value.slice(0, 20))
      await ext.tabs.sendMessage(owner.tabId, { type: 'toast', text: 'Code copied' }, { frameId: owner.frameId }).catch(() => undefined)
      await closeIt(owner)
      return { ok: true }
    }
    case 'menu-unlock': await openUnlock(); return { ok: true }
    // The popup asks for Walnut's address (it may not be this machine's default).
    case 'menu-connect': await openUnlock(); return { ok: true }
    case 'menu-close': await closeIt(owner, msg.refocus === true); return { ok: true }
    case 'menu-size':
      await ext.tabs.sendMessage(owner.tabId, { type: 'menu-size', height: msg.height }, { frameId: owner.frameId }).catch(() => undefined)
      return { ok: true }
  }
  return { ok: false, error: `Unknown message ${msg.type}` }
}
