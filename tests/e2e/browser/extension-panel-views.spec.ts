/**
 * The side panel's full views and the key, after the second D02 review (packages/browser-extension/
 * src/panel-ask.ts, popup.ts, popup-view.ts, popup-ui.ts, popup-item.ts, unlock-words.ts), through
 * the real extension in Chromium:
 *
 * - R2-9: on an unlocked vault the key never wears its padlock, even while the live answer (a
 *   round trip to Walnut) is slow: the frame hears the last known state as soon as it is ready;
 * - R2-10, R2-14: the key popover's Settings opens Settings every time, it stays Settings while the
 *   person moves to another tab and while the vault watch runs, and its Back goes to Ask; Settings
 *   and the generator opened from the Passwords list stay too, wear the list's bar (same height)
 *   and their Back says "Passwords";
 * - R2-13: the lock screen names the site, never the Walnut server;
 * - R2-15: a row's buttons leave its name and account whole;
 * - R3-5: an open Settings follows the storage it reads ("Never offer to save on" as the save bar adds
 *   or removes a site), also after Back and opening it again;
 * - R3-9: Fill in the key popover closes it, in the side panel and in the toolbar popup's window;
 * - R3-6: a Lock made in Walnut reaches the open panel's key within about a second.
 *
 * Screenshots: PW_SHOTS_DIR (default test-results/extension-panel-views). Fake data only.
 */
import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { askView, backToAsk, openView, pageShown, passwordsView, startPanelLab, sw, toAsk, type PanelLab } from './extension-panel-harness'
import { ensureVaultSetUp, vaultSession, VAULT_MASTER } from './vault-session-helper'
import { holdVaultLock, vaultExclusively } from './vault-lock'

test.describe.configure({ mode: 'serial' })
// It needs its unlocks to hold on the shared fixture vault, where another file may end every unlock.
// Its cleanup's Lock of every window runs alone (vaultExclusively).
holdVaultLock('shared', 'file')

const SHOTS = process.env.PW_SHOTS_DIR ?? 'test-results/extension-panel-views'
const stamp = Date.now().toString(36)
/** The review's row: a name and an account that the row's buttons cut to a few letters. */
const WORK_TITLE = 'Lab Shop (work)'
const WORK_USER = 'alex.work@lab.test'
/** How long the slowed live vault answer takes (the R2-9 case). */
// Long enough that a loaded runner (load 90+, 2026-11-07) still opens the drawer before the answer comes.
const SLOW_MS = 30_000

let lab: PanelLab
let itemId = ''

async function shot(p: Page, name: string, keepPointer = false): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  if (!keepPointer) await p.mouse.move(399, 700)
  await p.waitForTimeout(250)
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

/** The extension's own unlock goes (its token is in its IndexedDB, secret-store.ts). */
async function lockExtension(): Promise<void> {
  await sw(lab).evaluate(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.open('walnut', 1)
      req.onsuccess = () => { const tx = req.result.transaction('kv', 'readwrite'); tx.objectStore('kv').delete('vaultSession'); tx.oncomplete = () => { req.result.close(); resolve() }; tx.onerror = () => resolve() }
      req.onerror = () => resolve()
    })
    await chrome.storage.session.remove('vaultSession').catch(() => undefined)
  })
}

/** Unlock in the extension's own lock screen, as a person does. */
async function unlockExtension(): Promise<void> {
  const p = await lab.ctx.newPage()
  await p.goto(`chrome-extension://${lab.extId}/popup.html`)
  const pw = p.getByLabel('Master password')
  const list = p.getByLabel('Search Walnut')
  await expect(pw.or(list)).toBeVisible({ timeout: 30_000 })
  if (await pw.isVisible()) {
    await pw.fill(VAULT_MASTER)
    // The fixture's one vault checks one master password at a time for every spec beside this
    // one, and the popup waits out a busy answer only a few seconds: on a loaded runner the right
    // password then reads "Another unlock is being checked. Try again in a moment." (or, after
    // other specs' wrong passwords, "Too many tries. Wait N s."), and the list never comes (CI
    // 2026-11-10). A person presses Unlock again, after the wait it names; so does this.
    const refused = p.getByRole('alert').filter({ hasText: /\S/ })
    const deadline = Date.now() + 120_000
    for (;;) {
      await p.getByTestId('popup-unlock').click()
      await expect(list.or(refused)).toBeVisible({ timeout: 30_000 })
      if (await list.isVisible()) break
      const said = (await refused.textContent()) ?? ''
      expect(said, 'the right password was refused').toMatch(/Another unlock is being checked|Too many/)
      expect(Date.now() < deadline, `still refused after two minutes: ${said}`).toBe(true)
      await p.waitForTimeout(Math.min(60, Number(said.match(/(\d+) s\b/)?.[1] ?? 1)) * 1000)
    }
  }
  await p.close()
}

/** The side panel for the person's window, at the mock's size; `query` adds to its address. */
async function panelPage(query = ''): Promise<Page> {
  const opened = lab.ctx.waitForEvent('page')
  await sw(lab).evaluate(([w, q]: [number, string]) => chrome.windows.create({ url: chrome.runtime.getURL(`sidepanel.html?window=${w}${q}`), type: 'popup', width: 420, height: 760 }), [lab.docWindow, query] as [number, string])
  const panel = await opened
  await panel.setViewportSize({ width: 400, height: 760 })
  await toAsk(panel)
  return panel
}

/** Another tab in the person's window, then back to the page: the side panel follows both moves. */
async function switchTabs(): Promise<void> {
  const other = await sw(lab).evaluate(async ([w, url]: [number, string]) => (await chrome.tabs.create({ windowId: w, url, active: true })).id ?? 0, [lab.docWindow, lab.site('docs.example.test', '/other')] as [number, string])
  await new Promise((r) => setTimeout(r, 1200))
  await lab.doc.bringToFront()
  await sw(lab).evaluate(async (id: number) => { await chrome.tabs.remove(id) }, other)
  // The view's own watch on the vault runs every 3 s: it must not redraw the view either.
  await new Promise((r) => setTimeout(r, 3800))
}

const settingsIn = (v: FrameLocator) => v.getByText('Let Walnut agents use this browser')

test.beforeAll(async ({}, info) => {
  test.setTimeout(300_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'panel-views')
  await ensureVaultSetUp(lab.doc, lab.base, { password: VAULT_MASTER })
  const s = await vaultSession(lab.doc, lab.base, { password: VAULT_MASTER })
  const made = await lab.doc.request.post(`${lab.base}/api/v1/vault/items`, {
    headers: { 'x-walnut-vault-session': s },
    // A one-time code too: its button makes the row's hover the tightest one.
    data: { item: { type: 'login', title: WORK_TITLE, username: WORK_USER, password: `Work-${stamp}`, totp: 'JBSWY3DPEHPK3PXP', urls: [lab.site('docs.example.test', '')] } },
  })
  expect(made.ok(), await made.text()).toBe(true)
  itemId = String((await made.json()).item.id)
  await lab.doc.goto(lab.site('docs.example.test', '/login'))
  await unlockExtension()
})

test.afterAll(async () => {
  // Alone on the vault: its own unlock for the cleanup holds, and the Lock ends nobody else's.
  if (lab) await vaultExclusively(async () => {
    if (itemId) {
      const s = await vaultSession(lab.doc, lab.base, { password: VAULT_MASTER }).catch(() => '')
      if (s) await lab.doc.request.delete(`${lab.base}/api/v1/vault/items/${itemId}`, { headers: { 'x-walnut-vault-session': s } }).catch(() => undefined)
    }
    await lab.doc.request.post(`${lab.base}/api/v1/vault/lock`, { data: { everywhere: true } }).catch(() => undefined)
  })
  await lab?.close()
})

test('unlocked, the key never wears its padlock, even while Walnut is slow to answer (R2-9)', async () => {
  test.setTimeout(120_000)
  // The panel page's live vault question answers only after SLOW_MS: what the frame shows until
  // then is the last known state alone.
  await lab.ctx.addInitScript((ms: number) => {
    if (location.protocol !== 'chrome-extension:' || !location.search.includes('slowvault=1')) return
    const rt = (globalThis as any).chrome?.runtime
    if (!rt?.sendMessage) return
    const orig = rt.sendMessage.bind(rt)
    ;(globalThis as any).__liveAnswered = 0
    rt.sendMessage = (m: { type?: string }, ...rest: unknown[]) => m?.type !== 'vault-watch' ? orig(m, ...rest)
      : new Promise((res) => setTimeout(() => { (globalThis as any).__liveAnswered++; res(orig(m, ...rest)) }, ms))
  }, SLOW_MS)
  // Opened once, so the count of this site's logins is known for the next open.
  const first = await panelPage()
  await expect(askView(first).getByTestId('ext-key-locked')).toHaveCount(0, { timeout: 20_000 })
  await first.close()

  const panel = await panelPage('&slowvault=1')
  const v = askView(panel)
  // The look the extension drew goes once the view is up: the key under it already unlocked.
  await expect(panel.getByTestId('panel-snap')).toHaveCount(0, { timeout: SLOW_MS - 1000 })
  expect(await panel.evaluate(() => (globalThis as any).__liveAnswered)).toBe(0)
  await expect(v.getByTestId('ext-key-locked')).toHaveCount(0)
  // The drawer's Passwords row has this site's count from the last state told for it.
  await v.getByTestId('ask-walnut-menu').click()
  await expect(v.getByTestId('ext-drawer-passwords-meta')).toHaveText(/logins? here/)
  expect(await panel.evaluate(() => (globalThis as any).__liveAnswered)).toBe(0)
  await shot(panel, 'r2-9-drawer-before-live-answer')
  await panel.close()
})

test('the key\'s Settings is Settings every time; another tab and the vault watch leave it; the side bar\'s Chat goes back to Ask (R2-10, R2-14)', async () => {
  test.setTimeout(150_000)
  const panel = await panelPage()
  const v = askView(panel)
  const st = panel.frameLocator('iframe.panel-frame-settings')
  for (let round = 0; round < 2; round++) {
    await v.getByTestId('ext-ask-key').click()
    await panel.getByTestId('key-pop').getByTestId('key-pop-settings').click()
    await expect(panel.getByTestId('panel-view-settings')).toBeVisible()
    await expect(settingsIn(st)).toBeVisible({ timeout: 30_000 })
    await expect(st.locator('.view-bar h1')).toHaveText('Settings')
    await switchTabs()
    // Still Settings: never the Passwords list.
    await expect(settingsIn(st)).toBeVisible()
    await expect(st.locator('.view-bar h1')).toHaveText('Settings')
    await expect(st.getByTestId('popup-item')).toHaveCount(0)
    if (round === 0) await shot(panel, 'r2-10-settings-after-tab-switch')
    // Its Back is the side bar's Chat (design C): Settings is marked there while it shows.
    await expect(panel.getByTestId('panel-rail-settings')).toHaveAttribute('aria-current', 'page')
    await panel.getByTestId('panel-rail-chat').click()
    await expect(panel.locator('.panel-view:not([hidden])')).toHaveCount(0)
    await expect(v.getByTestId('ext-ask-head')).toBeVisible()
  }
  await panel.close()
})

test('from the Passwords list: Settings and the generator stay through a tab switch, wear the list\'s bar, and go back to it (R2-13, R2-14)', async () => {
  test.setTimeout(150_000)
  const panel = await panelPage()
  await openView(panel, 'passwords')
  const pw = passwordsView(panel)
  await expect(pw.getByTestId('popup-item').filter({ hasText: WORK_TITLE })).toBeVisible({ timeout: 30_000 })
  const barHeight = () => pw.locator('.top-sub').first().evaluate((e) => Math.round(e.getBoundingClientRect().height))
  const listBar = await barHeight()

  // Settings from the list's gear.
  await pw.getByTestId('popup-settings').click()
  await expect(settingsIn(pw)).toBeVisible({ timeout: 15_000 })
  await switchTabs()
  await expect(settingsIn(pw)).toBeVisible()
  await expect(pw.getByTestId('popup-back')).toHaveText('Passwords')
  expect(await barHeight()).toBe(listBar)
  await pw.getByTestId('popup-back').click()
  await expect(pw.getByTestId('popup-item').filter({ hasText: WORK_TITLE })).toBeVisible({ timeout: 15_000 })

  // The generator.
  await pw.getByTestId('popup-generator').click()
  await expect(pw.getByTestId('gen-out')).not.toBeEmpty({ timeout: 15_000 })
  await expect(pw.locator('.view-bar h1')).toHaveText('Password generator')
  await expect(pw.getByTestId('popup-back')).toHaveText('Passwords')
  expect(await barHeight()).toBe(listBar)
  await shot(panel, 'r2-13-generator')
  await switchTabs()
  await expect(pw.getByTestId('gen-out')).toBeVisible()
  await pw.getByTestId('popup-back').click()
  await expect(pw.getByTestId('popup-item').filter({ hasText: WORK_TITLE })).toBeVisible({ timeout: 15_000 })
  await backToAsk(panel)
  await panel.close()
})

test('a row\'s buttons leave its name and account whole, in the side panel and the toolbar popup (R2-15)', async () => {
  test.setTimeout(120_000)
  const cut = (row: Locator) => row.evaluate((el) => [...el.querySelectorAll('.row-title, .row-sub')].map((x) => x.scrollWidth - x.clientWidth))
  const panel = await panelPage()
  await openView(panel, 'passwords')
  const row = passwordsView(panel).getByTestId('popup-item').filter({ hasText: WORK_TITLE })
  await expect(row).toBeVisible({ timeout: 30_000 })
  // The side panel at the widths Chrome gives it (it can be dragged down to 320 px): hovered, every
  // button it shows, Fill and the one-time code included, and still the name and account whole.
  // The view sits right of the side bar (68 px since 2026-11-09, so every entry's name fits), so a
  // 460 px panel gives it what 400 px gave before the bar.
  for (const width of [460, 400, 360, 320]) {
    await panel.setViewportSize({ width, height: 760 })
    await panel.mouse.move(5, 700)
    await row.hover()
    await expect(row.getByTestId('popup-fill')).toBeVisible()
    await expect(row.getByTestId('copy-totp')).toBeVisible()
    await expect(row.getByTestId('copy-password')).toBeVisible()
    // Wide enough, the row shows a password in place too; narrower, that waits in the item's view.
    if (width === 460) await expect(row.getByTestId('reveal-password')).toBeVisible()
    expect(await cut(row), `${width} px`).toEqual([0, 0])
    await shot(panel, `r2-15-row-hover-panel-${width}`, true)
  }
  await panel.close()

  // The toolbar popup's own list (popup.html), 360 px wide.
  const p = await lab.ctx.newPage()
  await p.setViewportSize({ width: 360, height: 600 })
  await p.goto(`chrome-extension://${lab.extId}/popup.html`)
  await p.getByLabel('Search Walnut').fill('Lab Shop (work)')
  const prow = p.getByTestId('popup-item').filter({ hasText: WORK_TITLE })
  await expect(prow).toBeVisible({ timeout: 30_000 })
  await prow.hover()
  await expect(prow.getByTestId('copy-password')).toBeVisible()
  expect(await cut(prow)).toEqual([0, 0])
  await shot(p, 'r2-15-row-hover-popup', true)
  await p.close()
})

test('locked, the Passwords view names the site, never the Walnut server (R2-13)', async () => {
  test.setTimeout(120_000)
  await lockExtension()
  const panel = await panelPage()
  await openView(panel, 'passwords')
  const pw = passwordsView(panel)
  await expect(pw.getByLabel('Master password')).toBeVisible({ timeout: 30_000 })
  await expect(pw.getByTestId('popup-unlock-words')).toHaveText('Unlock to fill passwords on docs.example.test.')
  await expect(pw.getByTestId('popup-unlock-words')).not.toContainText(new URL(lab.base).host)
  await shot(panel, 'r2-13-locked-words')
  await backToAsk(panel)
  await panel.close()
  await unlockExtension()
})

/** The save bar's "Never for this site" and its Undo write this list (bg-save.ts), in this browser's storage. */
async function setNever(sites: string[]): Promise<void> {
  await sw(lab).evaluate((list: string[]) => chrome.storage.local.set({ neverSave: list }), sites)
}

test('an open Settings shows the sites "Never for this site" adds and removes at once, also after Back and again (R3-5)', async () => {
  test.setTimeout(150_000)
  await setNever([])
  const panel = await panelPage()
  const v = askView(panel)
  const st = panel.frameLocator('iframe.panel-frame-settings')
  const list = st.getByTestId('never-list')
  for (const [round, host] of [[0, `first-${stamp}.example.test`], [1, `second-${stamp}.example.test`]] as const) {
    await v.getByTestId('ext-ask-key').click()
    await panel.getByTestId('key-pop').getByTestId('key-pop-settings').click()
    await expect(settingsIn(st)).toBeVisible({ timeout: 30_000 })
    await expect(list).not.toContainText(host)
    // The bar on a page adds the site while Settings is open: the list shows it, no reopen.
    const t0 = Date.now()
    await setNever(round === 0 ? [host] : [`first-${stamp}.example.test`, host])
    await expect(list).toContainText(host, { timeout: 2000 })
    expect(Date.now() - t0).toBeLessThan(2000)
    if (round === 0) await shot(panel, 'r3-5-never-live')
    // Its own remove button, and an Undo elsewhere, both take it off where it shows.
    if (round === 0) {
      await list.getByRole('button', { name: `Remove ${host}` }).click()
      await expect(list).not.toContainText(host, { timeout: 2000 })
    } else {
      await setNever([])
      await expect(list).not.toContainText(host, { timeout: 2000 })
      await expect(list).toContainText('No sites yet')
    }
    await panel.getByTestId('panel-rail-chat').click()
    await expect(v.getByTestId('ext-ask-head')).toBeVisible()
  }
  await panel.close()
})

test('Fill in the key popover fills the page and closes the popover, in the side panel and the toolbar popup (R3-9)', async () => {
  test.setTimeout(150_000)
  for (const page of ['sidepanel.html', 'popup-ask.html']) {
    await lab.doc.goto(lab.site('docs.example.test', '/login'))
    await expect(lab.doc.locator('#user')).toHaveValue('')
    const opened = lab.ctx.waitForEvent('page')
    await sw(lab).evaluate(([w, u]: [number, string]) => chrome.windows.create({ url: chrome.runtime.getURL(`${u}?window=${w}`), type: 'popup', width: 420, height: 760 }), [lab.docWindow, page] as [number, string])
    const panel = await opened
    const v = askView(panel)
    // The side panel opens on the page it was left on, the popup on the first page: both have the key.
    await expect(pageShown(panel)).toBeVisible({ timeout: 60_000 })
    await v.getByTestId('ext-ask-key').click()
    const row = panel.getByTestId('key-pop').getByTestId('key-pop-row').filter({ hasText: WORK_TITLE })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.getByTestId('key-pop-fill').click()
    await expect(lab.doc.locator('#user')).toHaveValue(WORK_USER, { timeout: 10_000 })
    await expect(panel.getByTestId('key-pop')).toHaveCount(0, { timeout: 5000 })
    if (page === 'sidepanel.html') await shot(panel, 'r3-9-filled-popover-closed')
    await panel.close()
  }
})

test('a Lock made in Walnut reaches the open panel\'s key within about a second (R3-6)', async () => {
  test.setTimeout(150_000)
  const panel = await panelPage()
  const v = askView(panel)
  await expect(v.getByTestId('ext-key-locked')).toHaveCount(0, { timeout: 20_000 })
  await panel.waitForTimeout(1500)
  const took = await vaultExclusively(async () => {
    const t0 = Date.now()
    const r = await lab.doc.request.post(`${lab.base}/api/v1/vault/lock`, { data: { everywhere: true } })
    expect(r.ok(), await r.text()).toBe(true)
    await expect(v.getByTestId('ext-key-locked')).toBeVisible({ timeout: 5000 })
    return Date.now() - t0
  })
  // About a second: the frame hears Walnut's push at once, and the panel looks every second while open.
  expect(took).toBeLessThan(1600)
  await panel.close()
  await unlockExtension()
})
