/**
 * Passkeys through the extension, as a person uses them (docs/reference/passwords.md, "Passkeys in
 * the browser"), against a local site that checks every answer itself (passkey-rp-site.ts):
 *   - on by default: the switch is on with no click, the script is in the page;
 *   - a site's "create a passkey" opens Walnut's window, the master password says yes, the site
 *     verifies the registration, the vault holds the passkey (its private key never in a read);
 *   - sign out, then "sign in with a passkey": Walnut's window, yes, the site verifies the signature;
 *   - Cancel tells the site no; "Use the browser instead" hands the request to the browser's own
 *     authenticator; a site with no Walnut passkey never sees a Walnut window;
 *   - Touch ID: the window's "Next time, confirm with Touch ID" adds a confirm key (here the
 *     browser's virtual authenticator stands in for the Mac's), and the next sign-in is one click;
 *   - turned off: the page gets the browser's own functions back on its next load, and the
 *     browser's own dialog answers.
 * The site is shop.localhost (a secure context on http), so nothing the other specs keep matches it.
 */
import { expect, test, chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'
import { vaultSession } from './vault-session-helper'
import { holdVaultLock } from './vault-lock'
import { startRpSite, type RpSite } from './passkey-rp-site'

test.describe.configure({ mode: 'serial' })
holdVaultLock('shared', 'file')

const MASTER = 'Correct Horse Battery Staple 42'
const RP = 'shop.localhost'
const account = `evan-test-${Date.now().toString(36)}`

let ctx: BrowserContext
let extId = ''
let base = ''
let site: RpSite

const sw = () => ctx.serviceWorkers()[0]

async function api(page: Page, p: string): Promise<any> {
  const s = await vaultSession(page, base, { password: MASTER })
  const r = await page.request.get(`${base}/api/v1${p}`, { headers: { 'x-walnut-vault-session': s } })
  expect(r.ok(), await r.text()).toBe(true)
  return r.json()
}

/** A virtual authenticator on one page (the browser's own passkeys there, or the Mac's Touch ID stand-in). */
const authIds = new WeakMap<CDPSession, string>()
const authenticatorIdOf = async (cdp: CDPSession) => authIds.get(cdp)!

async function virtualAuthenticator(page: Page, opts: { internal?: boolean } = {}): Promise<CDPSession> {
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const r = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: opts.internal ? 'internal' : 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } })
  authIds.set(cdp, r.authenticatorId)
  return cdp
}

/** Click on the site, and the Walnut window that opens for it. */
async function walnutWindowFrom(page: Page, button: string, onOpen?: (w: Page) => Promise<void>): Promise<Page> {
  const opened = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('/passkey.html'), timeout: 15_000 })
  await page.locator(button).click()
  const w = await opened
  if (onOpen) await onOpen(w)
  await expect(w.getByTestId('passkey-title')).toBeVisible({ timeout: 10_000 })
  return w
}

async function passkeysSwitch(on: boolean): Promise<void> {
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.getByRole('button', { name: 'Settings' }).click()
  const box = p.getByTestId('popup-passkeys')
  await expect(box).toBeVisible()
  if ((await box.isChecked()) !== on) await box.click({ force: true })
  await expect(box).toBeChecked({ checked: on })
  // The scripts follow the setting in the background.
  await expect.poll(() => sw().evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).filter((id) => id.startsWith('walnut-passkey')).length), { timeout: 10_000 }).toBe(on ? 2 : 0)
  await p.close()
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-pk-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  site = await startRpSite(RP)
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-pk-profile-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${path.join(dir, 'chrome')}`,
      `--load-extension=${path.join(dir, 'chrome')}`,
      '--host-resolver-rules=MAP *.localhost 127.0.0.1',
    ],
  })
  let worker = ctx.serviceWorkers()[0]
  if (!worker) worker = await ctx.waitForEvent('serviceworker')
  worker.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[background ${m.type()}] ${m.text()}`) })
  extId = new URL(worker.url()).host

  const p = await ctx.newPage()
  // The fixture vault set up (or unlocked) first, as every vault spec does.
  await vaultSession(p, base, { password: MASTER })
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
  await connect.getByTestId('connect-extension-agents').uncheck()
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  const un = await ctx.newPage()
  await un.goto(`chrome-extension://${extId}/popup.html`)
  await un.getByLabel('Master password').fill(MASTER)
  await un.getByTestId('popup-unlock').click()
  await expect(un.getByLabel('Search Walnut')).toBeVisible({ timeout: 30_000 })
  await un.close()
})

test.afterAll(async () => {
  await ctx?.close()
  await site?.close()
})

test('on by default: the switch is on, with no click, and Walnut\'s script is in the page', async () => {
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.getByRole('button', { name: 'Settings' }).click()
  await expect(p.getByTestId('popup-passkeys')).toBeChecked()
  await p.close()
  await expect.poll(() => sw().evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).filter((id) => id.startsWith('walnut-passkey')).length), { timeout: 10_000 }).toBe(2)
  const page = await ctx.newPage()
  await page.goto(site.url())
  expect(await page.evaluate(() => (window as any)[Symbol.for('walnut.passkeys')] ?? null)).toBe(true)
  await page.close()
})

test('on: a site\'s new passkey is saved in Walnut after the master password, and the site verifies it', async () => {
  await passkeysSwitch(true)
  const page = await ctx.newPage()
  await page.goto(site.url())
  expect(await page.evaluate(() => (window as any)[Symbol.for('walnut.passkeys')] ?? null)).toBe(true)
  await page.locator('#name').fill(account)
  const w = await walnutWindowFrom(page, '#register')
  await expect(w.getByTestId('passkey-title')).toHaveText(`Save a passkey for ${RP}`)
  await expect(w.getByTestId('passkey-account')).toContainText(account)
  // A wrong password says so and keeps the window.
  await w.getByTestId('passkey-password').fill('not the master password')
  await w.getByTestId('passkey-confirm').click()
  await expect(w.getByTestId('passkey-error')).toHaveText('That is not the master password.', { timeout: 30_000 })
  await w.getByTestId('passkey-password').fill(MASTER)
  await w.getByTestId('passkey-confirm').click()
  await expect(w.getByTestId('passkey-done')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('#status')).toHaveText(`Passkey created for ${account}. The site checked it.`, { timeout: 15_000 })
  await expect.poll(() => w.isClosed(), { timeout: 10_000 }).toBe(true)
  expect(site.log.at(-1)).toBe(`registered ${account} fmt=none credProps={"rk":true}`)

  // In the vault, on a login for the site, without its private key in any read.
  const items = (await api(page, '/vault/items')).items.filter((i: any) => i.username === account)
  expect(items).toHaveLength(1)
  const item = (await api(page, `/vault/items/${items[0].id}`)).item
  expect(item.passkeys).toEqual([expect.objectContaining({ rpId: RP, userName: account, madeBy: 'walnut' })])
  expect(JSON.stringify(item)).not.toMatch(/keyValue/)
  await page.close()
})

test('signed out, the site signs in with the Walnut passkey after the master password', async () => {
  const page = await ctx.newPage()
  await virtualAuthenticator(page)
  await page.goto(site.url())
  await page.locator('#signout').click()
  await expect(page.locator('#status')).toHaveText('Signed out.')
  const w = await walnutWindowFrom(page, '#signin')
  await expect(w.getByTestId('passkey-title')).toHaveText(`Sign in to ${RP}`)
  await expect(w.getByTestId('passkey-account')).toContainText(account)
  await w.getByTestId('passkey-password').fill(MASTER)
  await w.getByTestId('passkey-confirm').click()
  await expect(page.locator('#status')).toHaveText(`Signed in as ${account} with a passkey. The site checked the signature.`, { timeout: 30_000 })
  await page.close()
})

test('Cancel tells the site no; "Use the browser instead" gives the request to the browser\'s own authenticator', async () => {
  const page = await ctx.newPage()
  await virtualAuthenticator(page)
  await page.goto(site.url())
  let w = await walnutWindowFrom(page, '#signin')
  await w.getByTestId('passkey-cancel').click()
  await expect(page.locator('#status')).toContainText('NotAllowedError', { timeout: 15_000 })
  // Another way, for a new passkey: the browser's own authenticator (this page's) makes it.
  await page.locator('#name').fill(`${account}-other`)
  w = await walnutWindowFrom(page, '#register')
  await w.getByTestId('passkey-another').click()
  await expect(page.locator('#status')).toHaveText(`Passkey created for ${account}-other. The site checked it.`, { timeout: 15_000 })
  // And for a sign-in: the browser's authenticator answers with its own passkey.
  w = await walnutWindowFrom(page, '#signin')
  await w.getByTestId('passkey-another').click()
  await expect(page.locator('#status')).toHaveText(`Signed in as ${account}-other with a passkey. The site checked the signature.`, { timeout: 15_000 })
  // Closing the window is a no too.
  w = await walnutWindowFrom(page, '#signin')
  await w.close()
  await expect(page.locator('#status')).toContainText('NotAllowedError', { timeout: 15_000 })
  await page.close()
})

test('a site Walnut keeps no passkey for never sees a Walnut window', async () => {
  const other = await startRpSite('other.localhost')
  // Windows this test opens (an earlier test's closing window may still be listed).
  const opened: Page[] = []
  const onPage = (p: Page) => { opened.push(p) }
  ctx.on('page', onPage)
  try {
    const page = await ctx.newPage()
    // The browser's own authenticator keeps a passkey for this site (one the site never registered).
    const cdp = await virtualAuthenticator(page)
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    await cdp.send('WebAuthn.addCredential' as any, { authenticatorId: authIds.get(cdp), credential: {
      credentialId: Buffer.from('browser-own-key').toString('base64'), isResidentCredential: true, rpId: 'other.localhost',
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), userHandle: Buffer.from('someone').toString('base64'), signCount: 0,
    } })
    await page.goto(other.url())
    expect(await page.evaluate(() => (window as any)[Symbol.for('walnut.passkeys')] ?? null)).toBe(true)
    await page.locator('#signin').click()
    // The request went on to the browser's own authenticator, which answered with its key (the site
    // knows no such account, so it refuses it): no Walnut window came up for it.
    await expect(page.locator('#status')).toContainText('The site refused it', { timeout: 30_000 })
    expect(opened.filter((p) => p.url().includes('/passkey.html'))).toHaveLength(0)
    await page.close()
  } finally { ctx.off('page', onPage); await other.close() }
})

test('Touch ID: set up once with the master password, then the next sign-in is one click', async () => {
  const page = await ctx.newPage()
  await page.goto(site.url())
  await page.locator('#signout').click()
  // The Mac's Touch ID, played by the browser's virtual platform authenticator in Walnut's window.
  let cdp: CDPSession | undefined
  let w = await walnutWindowFrom(page, '#signin', async (win) => { cdp = await virtualAuthenticator(win, { internal: true }) })
  await w.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(w.getByTestId('passkey-enroll')).toBeChecked({ timeout: 10_000 })
  await w.getByTestId('passkey-password').fill(MASTER)
  await w.getByTestId('passkey-confirm').click()
  // The confirm key the browser made (in its authenticator, never in Walnut), kept for the next window.
  let saved: any[] = []
  await expect.poll(async () => {
    const auths = cdp ? await cdp.send('WebAuthn.getCredentials' as any, { authenticatorId: await authenticatorIdOf(cdp) }).catch(() => ({ credentials: [] })) as any : { credentials: [] }
    if (auths.credentials?.length) saved = auths.credentials
    return saved.length
  }, { timeout: 20_000, intervals: [100] }).toBe(1)
  await expect(page.locator('#status')).toHaveText(`Signed in as ${account} with a passkey. The site checked the signature.`, { timeout: 30_000 })
  // The site has its answer first; the window adds the confirm key to Walnut after it (the master password checked again).
  await expect.poll(async () => (await api(page, '/vault/passkeys/confirm-keys')).keys.length, { timeout: 20_000 }).toBe(1)
  // The key belongs to the extension (newer Chrome names its rp id with the scheme), never to a site.
  expect([extId, `chrome-extension://${extId}`]).toContain(saved[0].rpId)

  // Next time: one click, Touch ID, signed in. The same authenticator (its key put back) in the new window.
  await page.locator('#signout').click()
  w = await walnutWindowFrom(page, '#signin', async (win) => {
    const c = await virtualAuthenticator(win, { internal: true })
    await c.send('WebAuthn.addCredential' as any, { authenticatorId: await authenticatorIdOf(c), credential: saved[0] })
  })
  await expect(w.getByTestId('passkey-verify')).toBeVisible()
  await expect(w.getByTestId('passkey-password')).toHaveCount(0)
  await w.getByTestId('passkey-verify').click()
  await expect(page.locator('#status')).toHaveText(`Signed in as ${account} with a passkey. The site checked the signature.`, { timeout: 30_000 })
  await page.close()
})

test('turned off: no Walnut script in the page, and the browser\'s own authenticator answers', async () => {
  await passkeysSwitch(false)
  // Windows this test opens (the last test's window may still be closing itself).
  const opened: Page[] = []
  const onPage = (p: Page) => { opened.push(p) }
  ctx.on('page', onPage)
  const page = await ctx.newPage()
  await virtualAuthenticator(page)
  await page.goto(site.url())
  expect(await page.evaluate(() => (window as any)[Symbol.for('walnut.passkeys')] ?? null)).toBeNull()
  await page.locator('#name').fill(`${account}-browser`)
  await page.locator('#register').click()
  await expect(page.locator('#status')).toContainText('Passkey created for', { timeout: 15_000 })
  // No Walnut window came up for it.
  ctx.off('page', onPage)
  expect(opened.filter((p) => p !== page)).toHaveLength(0)
  await page.close()
})
