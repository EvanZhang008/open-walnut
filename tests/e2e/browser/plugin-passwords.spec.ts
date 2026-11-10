/**
 * walnut.passwords for web plugins (web/src/plugins/plugin-passwords.ts) against the fixture's real
 * vault: a plugin keeps a secret the person typed. The page's own unlock creates the login, a second
 * save sets that item's password (the old one goes to its history), the same value writes nothing,
 * two items of the title change none, a website login of the title is left alone, and a window with no
 * unlock of its own saves nothing (and is not unlocked by it). No answer carries a value.
 * Fake data only. Run on the Mac app's engine: PW_WEBKIT=1 bun x playwright test plugin-passwords --project webkit
 */
import { expect, test, type Page } from '@playwright/test'
import { VAULT_MASTER, vaultSession } from './vault-session-helper'
import { holdVaultLock } from './vault-lock'

test.describe.configure({ mode: 'serial' })
holdVaultLock('shared', 'file')

const stamp = Date.now().toString(36)
const TITLE = `Plugin PIN ${stamp}`
const TOKEN_KEY = 'walnut.vault.session'

async function save(page: Page, title: string, password: string): Promise<unknown> {
  return page.evaluate(async ({ title, password }) => {
    const mod = await import('/src/plugins/plugin-passwords.ts' as string)
    return mod.createWebPasswords('spec-plugin', 'Spec Plugin').save({ title, password })
  }, { title, password })
}

test('a plugin keeps a typed secret in Passwords through the window\'s own unlock', async ({ page, request, baseURL }) => {
  const base = baseURL!
  const token = await vaultSession(request, base)
  const headers = { 'x-walnut-vault-session': token }
  const items = async () => ((await (await request.get(`${base}/api/v1/vault/items`, { headers })).json()).items as Array<{ id: string; title: string; trashedAt?: string }>)
    .filter(item => item.title === TITLE && !item.trashedAt)
  // The vault deletes for good only from the trash.
  const remove = async (id: string) => {
    expect((await request.post(`${base}/api/v1/vault/items/${id}/trash`, { headers })).ok()).toBe(true)
    expect((await request.delete(`${base}/api/v1/vault/items/${id}`, { headers })).ok()).toBe(true)
  }
  const item = async (id: string) => (await (await request.get(`${base}/api/v1/vault/items/${id}`, { headers })).json()).item

  // This tree's dev server must be the one serving (a fixture server of another checkout would not have the module).
  expect((await request.get(`${base}/src/plugins/plugin-passwords.ts`)).status()).toBe(200)
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')

  // Locked in this window: nothing is written.
  await page.evaluate(key => localStorage.removeItem(key), TOKEN_KEY)
  expect(await save(page, TITLE, 'fake-pin-1111')).toEqual({ saved: false, reason: 'locked' })
  expect(await items()).toHaveLength(0)
  expect(await page.evaluate(key => localStorage.getItem(key), TOKEN_KEY)).toBeNull()

  // The window's unlock: created, then updated, then unchanged.
  await page.evaluate(({ key, token }) => localStorage.setItem(key, token), { key: TOKEN_KEY, token })
  const created = await save(page, TITLE, 'fake-pin-2222')
  expect(created).toEqual({ saved: true, action: 'created' })
  expect(JSON.stringify(created)).not.toContain('fake-pin')
  const [one] = await items()
  expect((await item(one.id)).password).toBe('fake-pin-2222')
  expect((await item(one.id)).type).toBe('login')
  expect((await item(one.id)).tags).toEqual(['plugin:spec-plugin'])

  expect(await save(page, TITLE, 'fake-pin-3333')).toEqual({ saved: true, action: 'updated' })
  const updated = await item(one.id)
  expect(updated.password).toBe('fake-pin-3333')
  expect(updated.passwordHistory?.[0]?.password).toBe('fake-pin-2222')
  expect(await items()).toHaveLength(1)

  expect(await save(page, TITLE, 'fake-pin-3333')).toEqual({ saved: true, action: 'unchanged' })
  expect((await item(one.id)).updatedAt).toBe(updated.updatedAt)

  // Two items of the title: none is changed.
  const second = await request.post(`${base}/api/v1/vault/items`, { headers, data: { item: { type: 'login', title: TITLE, password: 'fake-other' } } })
  expect(second.ok()).toBe(true)
  const secondId = (await second.json()).item.id as string
  expect(await save(page, TITLE, 'fake-pin-4444')).toEqual({ saved: false, reason: 'ambiguous' })
  expect((await item(one.id)).password).toBe('fake-pin-3333')
  expect((await item(secondId)).password).toBe('fake-other')

  // The person's own website login of the title: left alone.
  await remove(one.id)
  const put = await request.put(`${base}/api/v1/vault/items/${secondId}`, { headers, data: { item: { type: 'login', title: TITLE, password: 'fake-other', urls: ['https://example.test'] } } })
  expect(put.ok()).toBe(true)
  expect(await save(page, TITLE, 'fake-pin-5555')).toEqual({ saved: false, reason: 'exists' })
  expect((await item(secondId)).password).toBe('fake-other')

  await remove(secondId)
  expect(await items()).toHaveLength(0)
})

const call = (page: Page, method: 'state' | 'unlock') => page.evaluate(async (method) => {
  const mod = await import('/src/plugins/plugin-passwords.ts' as string)
  const api = mod.createWebPasswords('spec-plugin', 'Spec Plugin')
  const w = window as unknown as { __pwUnlock?: Promise<boolean> }
  if (method === 'state') return api.state()
  // The answer comes once the sheet closes: keep it, and read it after acting on the sheet.
  w.__pwUnlock = api.unlock({ reason: 'to save a test PIN' })
  return null
}, method)
const unlockAnswer = (page: Page) => page.evaluate(() => (window as unknown as { __pwUnlock: Promise<boolean> }).__pwUnlock)

test('unlock() asks with Walnut\'s own sheet, and the plugin hears only whether it worked', async ({ page, request, baseURL }) => {
  await vaultSession(request, baseURL!)
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(key => localStorage.removeItem(key), TOKEN_KEY)
  expect(await call(page, 'state')).toBe('locked')
  expect(await page.evaluate(key => localStorage.getItem(key), TOKEN_KEY)).toBeNull()

  // Escape cancels: false, and the window stays locked.
  await call(page, 'unlock')
  const sheet = page.getByTestId('pw-unlock-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('Spec Plugin asks to unlock Passwords to save a test PIN. Enter your master password; Walnut does not give it to Spec Plugin.')
  await expect(sheet.getByLabel('Master password')).toBeFocused()
  // Tab stays in the sheet, never in the page under it.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    expect(await sheet.evaluate(el => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  expect(await unlockAnswer(page)).toBe(false)
  expect(await call(page, 'state')).toBe('locked')

  // Cancel does the same.
  await call(page, 'unlock')
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  expect(await unlockAnswer(page)).toBe(false)

  // The master password unlocks this window (a wrong one is UnlockScreen's own, tested with Passwords).
  await call(page, 'unlock')
  await sheet.getByLabel('Master password').fill(VAULT_MASTER)
  await sheet.getByRole('button', { name: 'Unlock' }).click()
  await expect(sheet).toBeHidden()
  expect(await unlockAnswer(page)).toBe(true)
  expect(await call(page, 'state')).toBe('unlocked')
  expect(await page.evaluate(key => localStorage.getItem(key), TOKEN_KEY)).not.toBeNull()

  // Already unlocked: true with no sheet.
  await call(page, 'unlock')
  expect(await unlockAnswer(page)).toBe(true)
  await expect(sheet).toHaveCount(0)
})
