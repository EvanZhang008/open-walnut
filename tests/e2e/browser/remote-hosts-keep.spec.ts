/**
 * Settings › Remote Hosts › Edit: what a host keeps a read copy of (hosts.<alias>.keep).
 *
 *   locked      "Its own work" reads Always kept and has no switch
 *   defaults    notes, their pictures and files, memory and skills on; nothing
 *               written for them (the same defaults as every replica)
 *   left out    "Leave out folders or notes" saves as a list (a folder, or one
 *               note with or without .md), and a comma typed before the save
 *               comes back still typed (the save's own config echo must not
 *               rebuild the field)
 *   off         a kind turned off is written as false; notes off hides the
 *               folder field and the pictures switch, and keeps both for when
 *               notes come back
 *   reload      the saved choice is what the editor opens with
 *   alias       a host may not take the alias "companion" (the cloud companion's
 *               own): the row says why in plain words and nothing saves
 *
 * The config writes are real, on the fixture server; the host is off so the
 * fixture never dials it. page.goto only loads the app; the rest is clicks and keys.
 * Run in both engines: Chromium by default, WebKit (the Mac app is a WKWebView)
 * with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'

test.setTimeout(120_000)
test.describe.configure({ mode: 'serial' })

const SHOTS = '/tmp/g8-keep'
const ALIAS = 'keepbox'

async function readHosts(page: Page): Promise<Record<string, Record<string, unknown>>> {
  const res = await page.request.get('/api/config')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { config?: Record<string, unknown> } & Record<string, unknown>
  return ((body.config ?? body).hosts ?? {}) as Record<string, Record<string, unknown>>
}

const keepOf = async (page: Page) => (await readHosts(page))[ALIAS]?.keep

async function openEditor(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('sidebar-core-app-settings').click()
  await page.getByTestId('settings-nav-remote-hosts').click()
  const section = page.locator('#remote-hosts')
  await expect(section).toBeVisible({ timeout: 30_000 })
  const row = section.locator(`#rh-host-${ALIAS}`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.getByRole('button', { name: 'Edit' }).click()
  await expect(section.locator('#rh-keep-notes-0')).toBeVisible()
  return section
}

let saved: Record<string, unknown> | undefined

test.beforeAll(async ({ request }) => {
  const res = await request.get('/api/config')
  const body = await res.json() as { config?: Record<string, unknown> } & Record<string, unknown>
  saved = (body.config ?? body).hosts as Record<string, unknown> | undefined
  const put = await request.put('/api/config', { data: { hosts: { [ALIAS]: { hostname: 'keepbox.example.com', enabled: false } } } })
  expect(put.ok()).toBe(true)
})

test.afterAll(async ({ request }) => {
  await request.put('/api/config', { data: { hosts: saved ?? {} } })
})

test('the host keeps its own work always, and the user picks the rest', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const section = await openEditor(page)

  // Locked: a tag, no switch.
  const own = section.locator('.settings-row', { hasText: 'Its own work' })
  await expect(own).toContainText('Always kept')
  await expect(own.getByRole('switch')).toHaveCount(0)

  // Defaults: everything on, nothing written.
  for (const kind of ['notes', 'attachments', 'memory', 'skills']) await expect(section.getByRole('switch', { name: `Keep ${kind} on ${ALIAS}` })).toBeChecked()
  await expect(section.locator('.settings-row', { hasText: 'Pictures and files' })).toContainText('The pictures and files the notes embed.')
  await expect(section.locator('.settings-row', { hasText: 'Notes' }).first()).not.toContainText('no attachments')
  expect(await keepOf(page)).toBeUndefined()

  // Left out: one row for folders and single notes, its one sentence and example.
  const leaveOut = section.locator('.settings-row', { hasText: 'Leave out folders or notes' })
  await expect(leaveOut).toContainText('Folders or single notes that stay only on this Mac, separated by commas.')
  const folders = section.locator('#rh-keep-exclude-0')
  await expect(folders).toHaveAttribute('placeholder', 'health, finance/taxes.md')
  // A list in config, the typed comma stays in the field.
  await folders.click()
  await page.keyboard.type('health,')
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health'] })
  await page.waitForTimeout(1_500)
  await expect(folders).toHaveValue('health,')
  await page.keyboard.type(' finance')
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance'] })
  await expect(folders).toHaveValue('health, finance')
  // A single note, with its .md, beside the folders.
  await page.keyboard.type(', work/review.md')
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance', 'work/review.md'] })
  await leaveOut.screenshot({ path: `${SHOTS}/host-keep-left-out-${test.info().project.name}.png`, scale: 'css' })
  // Back to the two folders for the rest of the run.
  await folders.fill('health, finance')
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance'] })

  // Off: written as false.
  await section.getByRole('switch', { name: `Keep memory on ${ALIAS}` }).click()
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance'], memory: false })
  const pictures = section.getByRole('switch', { name: `Keep attachments on ${ALIAS}` })
  await pictures.click()
  await expect(pictures).not.toBeChecked()
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance'], memory: false, attachments: false })
  await section.getByRole('switch', { name: `Keep notes on ${ALIAS}` }).click()
  await expect(section.locator('#rh-keep-exclude-0')).toHaveCount(0)
  await expect(section.locator('#rh-keep-attachments-0')).toHaveCount(0)
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes: false, notes_exclude: ['health', 'finance'], memory: false, attachments: false })
  // Notes back on: the folders and the pictures choice are still there.
  await section.getByRole('switch', { name: `Keep notes on ${ALIAS}` }).click()
  await expect(section.locator('#rh-keep-exclude-0')).toHaveValue('health, finance')
  await expect(pictures).not.toBeChecked()
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance'], memory: false, attachments: false })
  // Pictures back on: nothing written for them again.
  await pictures.click()
  await expect(pictures).toBeChecked()
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ notes_exclude: ['health', 'finance'], memory: false })

  // The rest of the host survived every keep write.
  const host = (await readHosts(page))[ALIAS]
  expect(host).toMatchObject({ hostname: 'keepbox.example.com', enabled: false })

  await section.locator('#rh-keep-notes-0').scrollIntoViewIfNeeded()
  const box = await section.boundingBox()
  await page.screenshot({ path: `${SHOTS}/host-keep-rows-${test.info().project.name}.png`, scale: 'css', clip: box ? { x: box.x, y: Math.max(0, box.y), width: Math.min(box.width, 1280), height: Math.min(box.height, 900) } : undefined })
  expect(errors).toEqual([])
})

test('a reload opens with the saved choice', async ({ page }) => {
  expect(await keepOf(page)).toEqual({ notes_exclude: ['health', 'finance'], memory: false })
  const section = await openEditor(page)
  await expect(section.getByRole('switch', { name: `Keep notes on ${ALIAS}` })).toBeChecked()
  await expect(section.getByRole('switch', { name: `Keep memory on ${ALIAS}` })).not.toBeChecked()
  await expect(section.getByRole('switch', { name: `Keep skills on ${ALIAS}` })).toBeChecked()
  await expect(section.getByRole('switch', { name: `Keep attachments on ${ALIAS}` })).toBeChecked()
  await expect(section.locator('#rh-keep-exclude-0')).toHaveValue('health, finance')
  // Clearing the folders and turning memory back on writes no keep at all.
  await section.locator('#rh-keep-exclude-0').fill('')
  await section.getByRole('switch', { name: `Keep memory on ${ALIAS}` }).click()
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toBeUndefined()
})

test('a pictures choice survives a reload, and a save of another field keeps it', async ({ page }) => {
  let section = await openEditor(page)
  await section.getByRole('switch', { name: `Keep attachments on ${ALIAS}` }).click()
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ attachments: false })
  // Another kind's save writes the whole host again: the pictures choice stays.
  await section.getByRole('switch', { name: `Keep skills on ${ALIAS}` }).click()
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toEqual({ skills: false, attachments: false })
  section = await openEditor(page)
  await expect(section.getByRole('switch', { name: `Keep attachments on ${ALIAS}` })).not.toBeChecked()
  await expect(section.getByRole('switch', { name: `Keep skills on ${ALIAS}` })).not.toBeChecked()
  await section.getByRole('switch', { name: `Keep attachments on ${ALIAS}` }).click()
  await section.getByRole('switch', { name: `Keep skills on ${ALIAS}` }).click()
  await expect.poll(() => keepOf(page), { timeout: 15_000 }).toBeUndefined()
})

test('a host may not take the alias companion: the row says why, nothing saves', async ({ page }) => {
  const section = await openEditor(page)
  // The page itself sends no save that names the host companion (the server would refuse it too).
  const sent: string[] = []
  page.on('request', (r) => { if (r.method() === 'PUT' && new URL(r.url()).pathname === '/api/config') sent.push(r.postData() ?? '') })
  const alias = section.locator('#rh-alias-0')
  await alias.fill('companion')
  const refusal = section.getByRole('alert').filter({ hasText: 'The name "companion" is taken by the cloud companion. Give this host another alias.' })
  await expect(refusal).toBeVisible()
  await page.waitForTimeout(1_500)
  expect(sent.filter((b) => b.includes('"companion"'))).toEqual([])
  const hosts = await readHosts(page)
  expect(hosts.companion).toBeUndefined()
  expect(hosts[ALIAS]).toMatchObject({ hostname: 'keepbox.example.com' })
  const row = section.locator('.settings-row:has(#rh-alias-0)')
  await row.scrollIntoViewIfNeeded()
  const box = await row.boundingBox()
  await page.screenshot({ path: `${SHOTS}/host-alias-companion-${test.info().project.name}.png`, scale: 'css', clip: box ? { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(box.width + 16, 1280), height: box.height + 64 } : undefined })
  // Any other name saves again.
  await alias.fill(ALIAS)
  await expect(refusal).toHaveCount(0)
  await expect.poll(async () => Object.keys(await readHosts(page)).filter((k) => k !== '__cloudbox__').sort(), { timeout: 15_000 }).toContain(ALIAS)
})
