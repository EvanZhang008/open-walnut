/**
 * `walnut.passwords` for web plugins: keep a secret the person just typed into a plugin's App in
 * their Passwords. It writes through this window's own unlock (api/vault.ts), so it works only
 * where the person has Passwords open, never unlocks or prompts, and never hands a stored value back.
 *
 * One item per title: none is created (tagged `plugin:<id>`), one has its password set (the old one
 * goes to the item's history, as an edit by hand does), two or more are left alone. The one item is
 * changed only when it is a login this plugin saved, or a login with no website (a PIN the person
 * entered by hand); anything else with the title (a website login, a key, a card) is left alone.
 * Nothing here logs the value.
 */
import type { PasswordSaveInput, PasswordSaveResult, PasswordsService } from '../../../packages/plugin-api/src/web'
import { isLockedError, vaultApi, vaultSession, VaultApiError, type VaultItemInput } from '@/api/vault'
import { NOTES_MAX, SECRET_MAX, TITLE_MAX } from '../../../src/core/vault/types'

type VaultClient = Pick<typeof vaultApi, 'list' | 'get' | 'create' | 'update'> & { session(): string | null }
const realClient: VaultClient = { ...vaultApi, session: vaultSession }

/** One save per title at a time across this browser's tabs (this page's only, with no Web Locks), so two saves never create two items. */
const chains = new Map<string, Promise<unknown>>()
async function oneAtATime<T>(title: string, run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks) return locks.request(`walnut-passwords:${title}`, run)
  const next = (chains.get(title) ?? Promise.resolve()).then(run, run)
  const settled = next.catch(() => undefined)
  chains.set(title, settled)
  void settled.then(() => { if (chains.get(title) === settled) chains.delete(title) })
  return next
}

export function createWebPasswords(pluginId: string, pluginName: string, client: VaultClient = realClient): PasswordsService {
  // The server keeps a tag's first 50 characters, so the plugin's tag is compared as stored.
  const tag = `plugin:${pluginId}`.slice(0, 50)
  async function once(title: string, password: string): Promise<PasswordSaveResult> {
    const same = (await client.list()).filter((item) => item.title === title && !item.trashedAt)
    if (same.length > 1) return { saved: false, reason: 'ambiguous' }
    if (same.length === 0) {
      const notes = `Saved by ${pluginName} after it worked.`.slice(0, NOTES_MAX)
      await client.create({ type: 'login', title, password, notes, tags: [tag] })
      return { saved: true, action: 'created' }
    }
    const item = await client.get(same[0].id)
    const ours = item.tags?.includes(tag) === true
    if (item.type !== 'login' || (!ours && (item.urls?.length ?? 0) > 0)) return { saved: false, reason: 'exists' }
    if (item.password === password) return { saved: true, action: 'unchanged' }
    const { id, createdAt: _c, updatedAt, passwordHistory: _h, trashedAt: _t, usedAt: _u, ...rest } = item
    const next: VaultItemInput = { ...rest, password, ...(ours ? {} : { tags: [...(item.tags ?? []), tag] }) }
    // The item as it was read: an edit made meanwhile (another window) is not overwritten.
    await client.update(id, next, updatedAt)
    return { saved: true, action: 'updated' }
  }
  return {
    async save(input: PasswordSaveInput): Promise<PasswordSaveResult> {
      const title = typeof input?.title === 'string' ? input.title.trim() : ''
      const password = input?.password
      if (!title || title.length > TITLE_MAX || typeof password !== 'string' || !password || password.length > SECRET_MAX) {
        return { saved: false, reason: 'invalid' }
      }
      // Only this window's own unlock: a status check could join an unlock made elsewhere on this
      // computer, and a plugin's save must never unlock the window. (A save is a use of the vault,
      // so it renews the unlock's idle timer, as an edit by hand does.)
      if (!client.session()) return { saved: false, reason: 'locked' }
      return oneAtATime(title, async () => {
        for (let tries = 0; ; tries++) {
          try {
            return await once(title, password)
          } catch (error) {
            if (error instanceof VaultApiError && error.code === 'stale_item') {
              if (tries === 0) continue // changed between our read and write: read it again, once
              return { saved: false, reason: 'conflict' }
            }
            return { saved: false, reason: isLockedError(error) ? 'locked' : 'unavailable' }
          }
        }
      })
    },
  }
}
