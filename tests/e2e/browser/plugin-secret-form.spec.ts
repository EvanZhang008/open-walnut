import { bunRuntime } from '../../helpers/bun-runtime.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import yaml from 'js-yaml'
import { expect, test, type Locator, type Page, type Response } from '@playwright/test'

/**
 * Editing hidden secrets in Settings, through real clicks, and what lands on disk.
 *
 * What it pins:
 *   1. A plugin's list of hidden keys: deleting one of two and saving keeps the
 *      one left. It used to be dropped as "unchanged" (the one line left was the
 *      mask itself) while the page said "Saved" (gate r7 MED-A). Each entry
 *      shows its tail, so the server can tell which one is left.
 *   2. List entries no tail tells apart (two with the same last 4) show bullets
 *      only, one line each; an edit around them saves, in order; a delete among
 *      them is refused, naming the entry to
 *      type in full, and typed in full it saves (gate r8 L2, L5). A list of
 *      secrets is one value per line, so a secret with a comma in it, typed in
 *      full, stays one value (gate r9 M-1). Typed next to a hidden line, a stray
 *      space at an end is trimmed away, and anything else (a key after a comma,
 *      a trailing comma) is refused before any request: a mask never reaches
 *      disk (gate r10 H-1).
 *   3. A URL moved to another host with its password still hidden is refused:
 *      "Not saved", the reason under the Save row, the edit still in its box,
 *      nothing written. Typed in full, it saves.
 *   4. Both tunnel option forms (Open from a browser, and Walnut on a host): a
 *      refused option keeps what was typed in its box, with the reason under
 *      that option, until that option is saved or put back. Saving another
 *      option, flipping a switch or switching the provider leaves both (gate r8
 *      MED-1, gate r9 M6 and M12). Both forms keep what is typed while a save
 *      is in flight (gate r8 M14, gate r9 L-3). A space typed after a hidden
 *      token is refused, under that option (gate r10 T6, H6).
 *
 * Runs against tests/e2e/browser/plugin-secret-form-server.ts (its own
 * throwaway home, a fixture plugin, and a host entry that is turned off, so
 * nothing connects to it). Each test writes the seeded config back first.
 * Chromium and WebKit (PW_WEBKIT=1).
 */

const SCREENSHOT_DIR = '/tmp/plugin-secret-form'
const B = '\u2022'
const tail = (v: string) => B.repeat(8) + v.slice(-4)
/** What a list entry no tail tells apart is shown as. */
const BLIND = B.repeat(8)
const HOST = 'acme-box'

interface Fixture {
  port: number
  home: string
  pluginId: string
  configFile: string
  seed: unknown
  seeded: { region: string; database_url: string; api_keys: string[]; backup_keys: string[]; pair_keys: string[]; ring_keys: string[] }
  expose: { options: Record<string, string> }
  hosts: Record<string, { server: { expose: { options: Record<string, string> } } }>
}

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.setTimeout(240_000)
// Not serial: each test stands alone, so a failure in one still runs the others (a failed test
// restarts the worker, and the next one gets a fresh fixture).
test.use({ viewport: { width: 1280, height: 900 } })

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function waitForReady(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Plugin secret form fixture did not start\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      const match = /PLUGIN_SECRET_FORM_READY (\{.*\})/.exec(output)
      if (match) {
        clearInterval(timer)
        clearTimeout(deadline)
        resolve(JSON.parse(match[1]!) as Fixture)
      } else if (child?.exitCode !== null && child?.exitCode !== undefined) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`Plugin secret form fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  const port = await reservePort()
  child = spawn(bunRuntime(), ['tests/e2e/browser/plugin-secret-form-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_PLUGIN_SECRET_FORM_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await waitForReady()
})

test.afterAll(async () => {
  if (!child) return
  child.kill('SIGTERM')
  for (let waited = 0; child.exitCode === null && waited < 20_000; waited += 250) {
    await new Promise((r) => setTimeout(r, 250))
  }
  if (child.exitCode === null) child.kill('SIGKILL')
})

const diskText = () => fs.readFile(fixture!.configFile, 'utf-8')
const disk = async () => yaml.load(await diskText()) as {
  plugins: Record<string, { region: string; database_url: string; api_keys: string[]; backup_keys: string[]; pair_keys: string[]; ring_keys: string[] }>
  expose: { enabled: boolean; provider: string; options: Record<string, string> }
  hosts: Record<string, { server: { expose: { enabled: boolean; provider: string; options: Record<string, string> } } }>
}
const stored = async () => (await disk()).plugins[fixture!.pluginId]!

/** The seeded config written back: each test starts from it, whatever the one before it saved. */
const reset = () => fs.writeFile(fixture!.configFile, JSON.stringify(fixture!.seed, null, 2))

/** The next answer to a PUT under `path`. */
const putTo = (page: Page, path: string): Promise<Response> =>
  page.waitForResponse((res) => res.request().method() === 'PUT' && new URL(res.url()).pathname.startsWith(path), { timeout: 30_000 })

/** The error row right under the settings row that holds `input`. */
const rowErrorOf = (input: Locator) => input.locator('xpath=ancestor::article[1]/following-sibling::*[1]')

/** Selects line `n` of a textarea, without its line break, so what is typed next replaces it. */
async function selectLine(box: Locator, n: number): Promise<void> {
  await box.click()
  await box.evaluate((el: HTMLTextAreaElement, line: number) => {
    const lines = el.value.split('\n')
    const start = lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0)
    el.setSelectionRange(start, start + lines[line]!.length)
  }, n)
}

/** Away to Settings and back to the Apps page through its Apps link, so the list mounts again. */
async function reopenPlugins(page: Page): Promise<void> {
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
}

/** The app's entry page once; every step after it is a click. */
async function openSettings(page: Page, pane: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 90_000 })
  if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click()
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId(pane).click()
}

/** The plugin list lives on the Apps page; Settings' Apps entry links there. */
async function openPluginForm(page: Page): Promise<Locator> {
  await openSettings(page, 'settings-nav-plugin-store')
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId(`plugin-configure-${fixture!.pluginId}`).click({ timeout: 60_000 })
  const form = page.getByTestId(`plugin-config-${fixture!.pluginId}`)
  await expect(form.locator(`#plugin-${fixture!.pluginId}-api_keys`)).toBeVisible({ timeout: 60_000 })
  return form
}

test('deleting one of two hidden keys saves the one left, and the form shows it', async ({ page }, info) => {
  await reset()
  const [first, second] = fixture!.seeded.api_keys as [string, string]
  const form = await openPluginForm(page)
  const keys = form.locator(`#plugin-${fixture!.pluginId}-api_keys`)
  const shown = (await keys.inputValue()).split('\n')
  expect(shown).toHaveLength(2)
  expect(shown.join('')).not.toContain(first)

  // Delete the first line: select it (with its line break) and press Backspace.
  await keys.click()
  await keys.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, el.value.indexOf('\n') + 1))
  await keys.press('Backspace')
  await expect(keys).toHaveValue(shown[1]!)
  await page.getByTestId(`plugin-config-save-${fixture!.pluginId}`).click()

  await expect(page.getByTestId('settings-saved-indicator')).toContainText('Saved')
  await expect(page.getByTestId('settings-saved-indicator')).not.toContainText('Not saved')
  // The delete reached disk (gate r7 MED-A: "Saved", and the list unchanged).
  await expect.poll(async () => (await stored()).api_keys, { timeout: 15_000 }).toEqual([second])
  // Each entry shows its own tail, so the one left reads as the second key.
  expect(shown).toEqual([tail(first), tail(second)])
  await expect(keys).toHaveValue(tail(second))
  await expect(form.locator('.settings-row-error')).toHaveCount(0)
  await form.screenshot({ path: `${SCREENSHOT_DIR}/${info.project.name}-1-one-key-left.png` })

  // Opened again from the list, the form reads the stored list: one key.
  await reopenPlugins(page)
  await page.getByTestId(`plugin-configure-${fixture!.pluginId}`).click({ timeout: 60_000 })
  await expect(page.getByTestId(`plugin-config-${fixture!.pluginId}`).locator(`#plugin-${fixture!.pluginId}-api_keys`)).toHaveValue(tail(second))
})

test('list entries no tail tells apart show bullets only; a delete among them is refused, and saves once the named entry is typed in full', async ({ page }, info) => {
  await reset()
  const id = fixture!.pluginId
  const [, dupB, comma, solo] = fixture!.seeded.backup_keys as [string, string, string, string]
  const form = await openPluginForm(page)
  const keys = form.locator(`#plugin-${id}-backup_keys`)
  const save = page.getByTestId(`plugin-config-save-${id}`)
  const indicator = page.getByTestId('settings-saved-indicator')
  // Two that end alike show bullets only. The comma in the third one's last 4 is an ordinary character:
  // a list of secrets is one value per line, so its tail shows and its line stays one line.
  await expect(keys).toHaveValue([BLIND, BLIND, tail(comma), tail(solo)].join('\n'))

  // Delete the first line: the bullets-only line left could be either of the two. Refused, naming it.
  const before = await diskText()
  await keys.click()
  await keys.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, el.value.indexOf('\n') + 1))
  await keys.press('Backspace')
  await expect(keys).toHaveValue([BLIND, tail(comma), tail(solo)].join('\n'))
  await save.click()
  await expect(indicator).toContainText('Not saved')
  const error = form.locator('.settings-row-error')
  await expect(error).toContainText(`Type the full value of plugins.${id}.backup_keys[0].`)
  await expect(error).not.toContainText('Reload')
  expect(await diskText()).toBe(before)
  await form.screenshot({ path: `${SCREENSHOT_DIR}/${info.project.name}-1b-blind-delete-refused.png` })

  // Typed in full over that line, as the message asks: saved, and the others keep their own values.
  await selectLine(keys, 0)
  await page.keyboard.type(dupB)
  await save.click()
  await expect(indicator).toContainText('Saved')
  await expect(indicator).not.toContainText('Not saved')
  await expect.poll(async () => (await stored()).backup_keys, { timeout: 15_000 }).toEqual([dupB, comma, solo])
  expect(await diskText()).not.toContain(B)
  await expect(form.locator('.settings-row-error')).toHaveCount(0)
  // The box holds what was saved: the line typed, and the others as they were read.
  await expect(keys).toHaveValue([dupB, tail(comma), tail(solo)].join('\n'))

  // A new secret with a comma in it, typed on a line of its own: saved as one value.
  const typed = 'bk-form-typed-x,y-0001'
  await keys.click()
  await keys.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length))
  await page.keyboard.type(`\n${typed}`)
  await save.click()
  await expect.poll(async () => (await stored()).backup_keys, { timeout: 15_000 }).toEqual([dupB, comma, solo, typed])
  expect(await diskText()).not.toContain(B)
  await expect(keys).toHaveValue([dupB, tail(comma), tail(solo), typed].join('\n'))

  // Opened again from the list, the form reads the stored list: four lines, each with its own tail
  // (the one left of the two that ended alike now ends like no other).
  await reopenPlugins(page)
  await page.getByTestId(`plugin-configure-${id}`).click({ timeout: 60_000 })
  await expect(page.getByTestId(`plugin-config-${id}`).locator(`#plugin-${id}-backup_keys`))
    .toHaveValue([tail(dupB), tail(comma), tail(solo), tail(typed)].join('\n'))
})

test('an edit around bullets-only entries saves, and they keep their order', async ({ page }) => {
  await reset()
  const id = fixture!.pluginId
  const [dupA, dupB, comma, solo] = fixture!.seeded.backup_keys as [string, string, string, string]
  const form = await openPluginForm(page)
  const keys = form.locator(`#plugin-${id}-backup_keys`)
  await expect(keys).toHaveValue([BLIND, BLIND, tail(comma), tail(solo)].join('\n'))
  // Delete the last line (with the break before it): the two bullets-only lines pair with the two
  // entries shown that way, in order, and the one with a comma in its tail pairs by its tail.
  await keys.click()
  await keys.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.lastIndexOf('\n'), el.value.length))
  await keys.press('Backspace')
  await expect(keys).toHaveValue([BLIND, BLIND, tail(comma)].join('\n'))
  await page.getByTestId(`plugin-config-save-${id}`).click()
  await expect(page.getByTestId('settings-saved-indicator')).toContainText('Saved')
  await expect(page.getByTestId('settings-saved-indicator')).not.toContainText('Not saved')
  await expect.poll(async () => (await stored()).backup_keys, { timeout: 15_000 }).toEqual([dupA, dupB, comma])
  expect(await diskText()).not.toContain(B)
  await expect(form.locator('.settings-row-error')).toHaveCount(0)
  await expect(keys).toHaveValue([BLIND, BLIND, tail(comma)].join('\n'))
})

test('a secret with a comma in it, typed in full as a refusal asks, is saved as one value', async ({ page }, info) => {
  await reset()
  const id = fixture!.pluginId
  const [withComma] = fixture!.seeded.pair_keys as [string, string]
  const form = await openPluginForm(page)
  const pair = form.locator(`#plugin-${id}-pair_keys`)
  const save = page.getByTestId(`plugin-config-save-${id}`)
  const indicator = page.getByTestId('settings-saved-indicator')
  // The same last 4: both bullets only.
  await expect(pair).toHaveValue([BLIND, BLIND].join('\n'))

  // Delete the second line: the one left could be either. Refused, naming it.
  const before = await diskText()
  await pair.click()
  await pair.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.lastIndexOf('\n'), el.value.length))
  await pair.press('Backspace')
  await expect(pair).toHaveValue(BLIND)
  await save.click()
  await expect(indicator).toContainText('Not saved')
  await expect(form.locator('.settings-row-error')).toContainText(`Type the full value of plugins.${id}.pair_keys[0].`)
  expect(await diskText()).toBe(before)

  // Typed in full, comma and all, as the message asks: one value on disk (gate r9 M-1 wrote two pieces).
  await selectLine(pair, 0)
  await page.keyboard.type(withComma)
  await save.click()
  await expect(indicator).toContainText('Saved')
  await expect(indicator).not.toContainText('Not saved')
  await expect.poll(async () => (await stored()).pair_keys, { timeout: 15_000 }).toEqual([withComma])
  expect(await diskText()).not.toContain(B)
  // One line: the value as typed.
  await expect(pair).toHaveValue(withComma)
  await form.screenshot({ path: `${SCREENSHOT_DIR}/${info.project.name}-1c-comma-typed-in-full.png` })

  // Opened again from the list, the form reads the stored list: one line.
  await reopenPlugins(page)
  await page.getByTestId(`plugin-configure-${id}`).click({ timeout: 60_000 })
  await expect(page.getByTestId(`plugin-config-${id}`).locator(`#plugin-${id}-pair_keys`)).toHaveValue(tail(withComma))
})

/** Every PUT /api/config the page sends from now on. */
function configWrites(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (req) => { if (req.method() === 'PUT' && new URL(req.url()).pathname === '/api/config') seen.push(req.postData() ?? '') })
  return seen
}

test('typed next to a hidden line: a stray space is trimmed away, anything else is refused before any request', async ({ page }, info) => {
  await reset()
  const id = fixture!.pluginId
  const ring = fixture!.seeded.ring_keys as [string, string, string]
  const shown = ring.map(tail)
  const form = await openPluginForm(page)
  const keys = form.locator(`#plugin-${id}-ring_keys`)
  const save = page.getByTestId(`plugin-config-save-${id}`)
  const indicator = page.getByTestId('settings-saved-indicator')
  const error = form.locator('.settings-row-error')
  await expect(keys).toHaveValue(shown.join('\n'))
  // The hint under the box says how to type it.
  await expect(keys.locator('xpath=ancestor::article[1]')).toContainText('One per line.')
  const writes = configWrites(page)
  const before = await diskText()
  const endOfLine = async (n: number) => {
    await keys.click()
    await keys.evaluate((el: HTMLTextAreaElement, line: number) => {
      const lines = el.value.split('\n')
      const end = lines.slice(0, line + 1).reduce((sum, l) => sum + l.length + 1, 0) - 1
      el.setSelectionRange(end, end)
    }, n)
  }
  const startOfLine = async (n: number) => {
    await keys.click()
    await keys.evaluate((el: HTMLTextAreaElement, line: number) => {
      const start = el.value.split('\n').slice(0, line).reduce((sum, l) => sum + l.length + 1, 0)
      el.setSelectionRange(start, start)
    }, n)
  }
  const refusedAt = async (label: string, n: number, shot?: string) => {
    await save.click()
    await expect(indicator, label).toContainText('Not saved')
    const field = `plugins.${id}.ring_keys[${n}]`
    await expect(error, label).toContainText(`${field} was sent back hidden, with other text added to it. Keep the hidden value exactly as it was shown, or replace it with the full value of ${field}.`)
    expect(writes, label).toEqual([])
    expect(await diskText(), label).toBe(before)
    if (shot) {
      await error.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${SCREENSHOT_DIR}/${info.project.name}-${shot}.png` })
    }
    // Back as it was read, for the next step.
    await keys.fill(shown.join('\n'))
  }

  // Gate r10 P5d: a key typed after the last hidden line, on the same line.
  await endOfLine(2)
  await page.keyboard.type(', rk-form-golf-7777')
  await refusedAt('P5d', 2, '1d-edited-mask-refused')
  // P5g: a comma typed after the first line.
  await endOfLine(0)
  await page.keyboard.type(',')
  await refusedAt('P5g', 0)
  // P5h: a space and a key after the last line.
  await endOfLine(2)
  await page.keyboard.type(' rk-form-hotel-8888')
  await refusedAt('P5h', 2)
  // P5c: comma-separated text over the whole list.
  await keys.fill(`${shown[1]}, ${shown[0]}, rk-form-fox-6666`)
  await refusedAt('P5c', 0)

  // P5e and P5f: a space after the first line and one before the second: the hidden lines themselves.
  await endOfLine(0)
  await page.keyboard.type(' ')
  await startOfLine(1)
  await page.keyboard.type(' ')
  await save.click()
  await expect(indicator).toContainText('Saved')
  await expect(indicator).not.toContainText('Not saved')
  await expect.poll(() => writes.length, { timeout: 15_000 }).toBe(1)
  await expect.poll(async () => (await stored()).ring_keys, { timeout: 15_000 }).toEqual(ring)
  expect(await diskText()).not.toContain(B)

  // The new key on a line of its own saves, and nothing on disk holds a bullet.
  await endOfLine(2)
  await page.keyboard.type('\nrk-form-golf-7777')
  await save.click()
  await expect.poll(async () => (await stored()).ring_keys, { timeout: 15_000 }).toEqual([...ring, 'rk-form-golf-7777'])
  expect(await diskText()).not.toContain(B)
  await expect(form.locator('.settings-row-error')).toHaveCount(0)
  // Opened again from the list: four lines, each with its own tail.
  await reopenPlugins(page)
  await page.getByTestId(`plugin-configure-${id}`).click({ timeout: 60_000 })
  await expect(page.getByTestId(`plugin-config-${id}`).locator(`#plugin-${id}-ring_keys`))
    .toHaveValue([...shown, tail('rk-form-golf-7777')].join('\n'))
})

test('a URL moved to another host with its password hidden is refused, and the edit stays on screen', async ({ page }, info) => {
  await reset()
  const form = await openPluginForm(page)
  const db = form.locator(`#plugin-${fixture!.pluginId}-database_url`)
  const shown = await db.inputValue()
  expect(shown).toBe(`postgres://acme:${B.repeat(8)}@db1.acme.invalid:5432/acme`)
  const before = await stored()

  await db.fill(shown.replace('db1.', 'db2.'))
  await form.locator(`#plugin-${fixture!.pluginId}-region`).fill('eu-west-1')
  await page.getByTestId(`plugin-config-save-${fixture!.pluginId}`).click()

  await expect(page.getByTestId('settings-saved-indicator')).toContainText('Not saved')
  const error = form.locator('.settings-row-error')
  await expect(error).toContainText(`plugins.${fixture!.pluginId}.database_url`)
  // A reload would not help (the stored address is still the old one): the message says what does.
  await expect(error).toContainText(`Type the full value of plugins.${fixture!.pluginId}.database_url.`)
  await expect(error).not.toContainText('Reload')
  // Nothing written, the region beside it included, and both edits still in their boxes.
  expect(await stored()).toEqual(before)
  await expect(db).toHaveValue(shown.replace('db1.', 'db2.'))
  await expect(form.locator(`#plugin-${fixture!.pluginId}-region`)).toHaveValue('eu-west-1')
  await form.screenshot({ path: `${SCREENSHOT_DIR}/${info.project.name}-2-url-refused.png` })

  // Typed in full, the same edit saves.
  await db.fill('postgres://acme:typed-db-pw@db2.acme.invalid:5432/acme')
  await page.getByTestId(`plugin-config-save-${fixture!.pluginId}`).click()
  await expect.poll(async () => (await stored()).database_url, { timeout: 15_000 }).toBe('postgres://acme:typed-db-pw@db2.acme.invalid:5432/acme')
  await expect(form.locator('.settings-row-error')).toHaveCount(0)
})

test('the tunnel form keeps a refused option in its box, with the reason under it', async ({ page }, info) => {
  await reset()
  await openSettings(page, 'settings-nav-devices')
  const group = page.getByTestId('browser-access')
  const endpoint = group.getByTestId('browser-access-option-endpoint')
  await expect(endpoint).toBeVisible({ timeout: 60_000 })
  const shown = await endpoint.inputValue()
  expect(shown).toBe(`https://acme:${B.repeat(8)}@t1.acme.invalid/`)
  const before = (await disk()).expose.options

  const answered = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/api/expose'))
  await endpoint.fill(shown.replace('t1.', 't2.'))
  await endpoint.press('Enter')
  expect((await answered).status()).toBe(400)

  // Past the reload that follows a refused write, and a poll: still what was typed (gate r7 L5).
  await page.waitForTimeout(1500)
  await expect(endpoint).toHaveValue(shown.replace('t1.', 't2.'))
  expect((await disk()).expose.options).toEqual(before)
  // The reason sits right under the endpoint's row, not at the top of the group.
  const rowError = rowErrorOf(endpoint)
  await expect(rowError).toHaveClass(/settings-row-error/)
  await expect(rowError).toContainText('Type the full value of expose.options.endpoint.')
  await expect(rowError).not.toContainText('Reload')
  await endpoint.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${info.project.name}-3-tunnel-refused.png` })

  // Fixed in its box (the password typed in full), it saves and the reason goes away.
  const saved = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/api/expose'))
  await endpoint.fill('https://acme:typed-tunnel-pw@t2.acme.invalid/')
  await endpoint.press('Enter')
  expect((await saved).status()).toBe(200)
  await expect.poll(async () => (await disk()).expose.options.endpoint, { timeout: 15_000 }).toBe('https://acme:typed-tunnel-pw@t2.acme.invalid/')
  await expect(page.locator('.settings-row-error', { hasText: 'expose.options.endpoint' })).toHaveCount(0)
  // Saved, the box reads the stored value again, its password hidden.
  await expect(endpoint).toHaveValue(`https://acme:${B.repeat(8)}@t2.acme.invalid/`)
})

/** Flips a switch on, then off; each flip is a write with no option in it, and each succeeds. */
async function flipOnAndOff(page: Page, toggle: Locator, path: string, enabledOf: (body: any) => unknown): Promise<void> {
  for (const want of [true, false]) {
    const flipped = putTo(page, path)
    await toggle.click()
    const res = await flipped
    expect(res.status(), `switch ${want}`).toBe(200)
    expect(enabledOf(JSON.parse(res.request().postData() ?? '{}')), `switch ${want}`).toBe(want)
    await expect(toggle).toHaveAttribute('aria-checked', String(want))
  }
}

/** Switches the tunnel provider to B and back; each switch is a write with no option in it, and each succeeds. */
async function switchProviderAndBack(page: Page, testIdOf: (provider: string) => string, path: string, providerOf: (body: any) => unknown, keep: () => Promise<void>): Promise<void> {
  for (const provider of ['acme-tunnel-b', 'acme-tunnel']) {
    const switched = putTo(page, path)
    await page.getByTestId(testIdOf(provider)).click()
    const res = await switched
    expect(res.status(), `provider ${provider}`).toBe(200)
    expect(providerOf(JSON.parse(res.request().postData() ?? '{}')), `provider ${provider}`).toBe(provider)
    // Past the reload the write sets off: the refused option still holds what was typed, with its reason.
    await page.waitForTimeout(800)
    await keep()
  }
}

test('Open from a browser: a refused option keeps its value and reason while another option saves and the switch flips, until it is put back', async ({ page }, info) => {
  await reset()
  await openSettings(page, 'settings-nav-devices')
  const group = page.getByTestId('browser-access')
  const endpoint = group.getByTestId('browser-access-option-endpoint')
  const token = group.getByTestId('browser-access-option-token')
  await expect(endpoint).toBeVisible({ timeout: 60_000 })
  const shown = await endpoint.inputValue()
  const moved = shown.replace('t1.', 't2.')
  const seeded = fixture!.expose.options

  const refused = putTo(page, '/api/expose')
  await endpoint.fill(moved)
  await endpoint.press('Enter')
  expect((await refused).status()).toBe(400)
  await page.waitForTimeout(1000)
  // Over to the token box (the endpoint's blur sends it again: refused again), the switch on and off,
  // then the token typed in full and saved (gate r8 S12b).
  await token.click()
  await page.waitForTimeout(1500)
  await flipOnAndOff(page, group.getByTestId('browser-access-enabled'), '/api/expose', (body) => body.enabled)
  await switchProviderAndBack(page, (provider) => `browser-access-provider-${provider}`, '/api/expose', (body) => body.provider, async () => {
    await expect(endpoint).toHaveValue(moved)
    await expect(rowErrorOf(endpoint)).toContainText('Type the full value of expose.options.endpoint.')
  })
  const saved = putTo(page, '/api/expose')
  await token.fill('tok-form-typed-4545')
  await token.press('Enter')
  expect((await saved).status()).toBe(200)
  // Past the reload each write sets off, and a poll.
  await page.waitForTimeout(4000)
  const opts = (await disk()).expose.options
  expect(opts.endpoint).toBe(seeded.endpoint)
  expect(opts.token).toBe('tok-form-typed-4545')
  expect((await disk()).expose.enabled).toBe(false)
  expect((await disk()).expose.provider).toBe('acme-tunnel')
  expect(await diskText()).not.toContain(B)
  // The endpoint is not saved, and the screen still says so, under its row (gate r8 MED-1).
  await expect(endpoint).toHaveValue(moved)
  await expect(rowErrorOf(endpoint)).toHaveClass(/settings-row-error/)
  await expect(rowErrorOf(endpoint)).toContainText('Type the full value of expose.options.endpoint.')
  await expect(group.locator('.settings-row-error')).toHaveCount(1)
  await endpoint.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${info.project.name}-4-tunnel-refused-kept.png` })

  // Put back as it was read: nothing to write, and nothing refused any more.
  await endpoint.fill(shown)
  await endpoint.press('Enter')
  await expect(group.locator('.settings-row-error')).toHaveCount(0)
  await expect(endpoint).toHaveValue(shown)
  expect((await disk()).expose.options).toEqual({ ...seeded, token: 'tok-form-typed-4545' })
})

test('Walnut on a host: a refused tunnel option keeps its value and reason through other writes, until it is put back or saved', async ({ page }, info) => {
  await reset()
  await openSettings(page, 'settings-nav-remote-hosts')
  const group = page.getByTestId('host-servers')
  const endpoint = group.getByTestId(`host-server-option-${HOST}-endpoint`)
  const token = group.getByTestId(`host-server-option-${HOST}-token`)
  await expect(endpoint).toBeVisible({ timeout: 60_000 })
  const shown = await endpoint.inputValue()
  expect(shown).toBe(`https://acme:${B.repeat(8)}@ht1.acme.invalid/`)
  const moved = shown.replace('ht1.', 'ht2.')
  const seeded = fixture!.hosts[HOST]!.server.expose.options
  const field = `hosts.${HOST}.server.expose.options.endpoint`
  const before = await diskText()

  const refused = putTo(page, '/api/host-servers/')
  await endpoint.fill(moved)
  await endpoint.press('Enter')
  const first = await refused
  expect(first.status()).toBe(400)
  expect(await first.json()).toMatchObject({ field, reason: 'missing' })
  // Past the reload a refusal sets off, and a poll: still what was typed (gate r8 M13).
  await page.waitForTimeout(1500)
  await expect(endpoint).toHaveValue(moved)
  expect(await diskText()).toBe(before)
  // The reason sits under the endpoint's row, not the host's.
  await expect(rowErrorOf(endpoint)).toHaveClass(/settings-row-error/)
  await expect(rowErrorOf(endpoint)).toContainText(`Type the full value of ${field}.`)
  await expect(rowErrorOf(endpoint)).not.toContainText('Reload')
  await expect(group.locator('.settings-row-error')).toHaveCount(1)

  // Over to the token box (the endpoint's blur sends it again), the tunnel switch on and off, then
  // the token typed in full and saved (gate r8 S13b).
  await token.click()
  await page.waitForTimeout(1500)
  await flipOnAndOff(page, group.getByTestId(`host-server-expose-${HOST}`), '/api/host-servers/', (body) => body.expose?.enabled)
  await switchProviderAndBack(page, (provider) => `host-server-provider-${HOST}-${provider}`, '/api/host-servers/', (body) => body.expose?.provider, async () => {
    await expect(endpoint).toHaveValue(moved)
    await expect(rowErrorOf(endpoint)).toContainText(`Type the full value of ${field}.`)
  })
  const saved = putTo(page, '/api/host-servers/')
  await token.fill('tok-form-hosttyped-5656')
  await token.press('Enter')
  expect((await saved).status()).toBe(200)
  await page.waitForTimeout(4000)
  const after = (await disk()).hosts[HOST]!.server.expose
  expect(after.options.endpoint).toBe(seeded.endpoint)
  expect(after.options.token).toBe('tok-form-hosttyped-5656')
  expect(after.enabled).toBe(false)
  expect(after.provider).toBe('acme-tunnel')
  expect(await diskText()).not.toContain(B)
  // The endpoint is not saved, and the screen still says so (gate r8 MED-1).
  await expect(endpoint).toHaveValue(moved)
  await expect(rowErrorOf(endpoint)).toContainText(`Type the full value of ${field}.`)
  await expect(group.locator('.settings-row-error')).toHaveCount(1)
  await endpoint.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${info.project.name}-5-host-refused-kept.png` })

  // Put back as it was read: nothing to write, and nothing refused any more.
  await endpoint.fill(shown)
  await endpoint.press('Enter')
  await expect(group.locator('.settings-row-error')).toHaveCount(0)
  await expect(endpoint).toHaveValue(shown)

  // Moved again: refused again. Then typed in full: it saves, its reason goes, and the box shows it hidden.
  const again = putTo(page, '/api/host-servers/')
  await endpoint.fill(moved)
  await endpoint.press('Enter')
  expect((await again).status()).toBe(400)
  await expect(rowErrorOf(endpoint)).toContainText(`Type the full value of ${field}.`)
  const fixed = putTo(page, '/api/host-servers/')
  await endpoint.fill('https://acme:typed-host-pw@ht2.acme.invalid/')
  await endpoint.press('Enter')
  expect((await fixed).status()).toBe(200)
  await expect.poll(async () => (await disk()).hosts[HOST]!.server.expose.options.endpoint, { timeout: 15_000 })
    .toBe('https://acme:typed-host-pw@ht2.acme.invalid/')
  await expect(endpoint).toHaveValue(moved)
  await expect(group.locator('.settings-row-error')).toHaveCount(0)
  expect(await diskText()).not.toContain(B)
})

test('Walnut on a host: text typed while an option is being saved stays in its box', async ({ page }) => {
  await reset()
  await openSettings(page, 'settings-nav-remote-hosts')
  const group = page.getByTestId('host-servers')
  const name = group.getByTestId(`host-server-option-${HOST}-name`)
  await expect(name).toHaveValue(fixture!.hosts[HOST]!.server.expose.options.name!, { timeout: 60_000 })

  // Hold the save until the person has typed on (gate r8 M14).
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/host-servers/**', async (route) => {
    if (route.request().method() === 'PUT') await held
    await route.continue()
  })
  const first = putTo(page, '/api/host-servers/')
  await name.fill('hostbeta')
  await name.press('Enter')
  await page.waitForTimeout(300)
  await name.fill('hostbeta-two')
  release()
  expect((await first).status()).toBe(200)
  await page.unroute('**/api/host-servers/**')
  await expect.poll(async () => (await disk()).hosts[HOST]!.server.expose.options.name, { timeout: 15_000 }).toBe('hostbeta')
  // Past the write's answer, a reload and a poll: the newer text is still there, unsaved.
  await page.waitForTimeout(1500)
  await expect(name).toHaveValue('hostbeta-two')

  // Saved in its turn, it lands too.
  const second = putTo(page, '/api/host-servers/')
  await name.press('Enter')
  expect((await second).status()).toBe(200)
  await expect.poll(async () => (await disk()).hosts[HOST]!.server.expose.options.name, { timeout: 15_000 }).toBe('hostbeta-two')
  await expect(name).toHaveValue('hostbeta-two')
})

test('a space typed after a hidden token is refused under that option in both tunnel forms, and nothing is written', async ({ page }) => {
  await reset()
  const before = await diskText()
  const message = (field: string) => `${field} was sent back hidden, with other text added to it. Keep the hidden value exactly as it was shown, or replace it with the full value of ${field}.`
  // Gate r10 T6, Open from a browser.
  await openSettings(page, 'settings-nav-devices')
  const token = page.getByTestId('browser-access').getByTestId('browser-access-option-token')
  await expect(token).toHaveValue(tail(fixture!.expose.options.token!), { timeout: 60_000 })
  const refused = putTo(page, '/api/expose')
  await token.click()
  await token.press('End')
  await page.keyboard.type(' ')
  await token.press('Enter')
  const answer = await refused
  expect(answer.status()).toBe(400)
  expect(await answer.json()).toMatchObject({ field: 'expose.options.token', reason: 'edited_mask' })
  await expect(rowErrorOf(token)).toContainText(message('expose.options.token'))
  await expect(token).toHaveValue(`${tail(fixture!.expose.options.token!)} `)
  expect(await diskText()).toBe(before)
  // Put back as it was read: nothing to write, and nothing refused any more.
  await token.fill(tail(fixture!.expose.options.token!))
  await token.press('Enter')
  await expect(page.getByTestId('browser-access').locator('.settings-row-error')).toHaveCount(0)

  // H6, Walnut on a host.
  await page.getByTestId('settings-nav-remote-hosts').click()
  const hostToken = page.getByTestId('host-servers').getByTestId(`host-server-option-${HOST}-token`)
  const hostStored = fixture!.hosts[HOST]!.server.expose.options.token!
  await expect(hostToken).toHaveValue(tail(hostStored), { timeout: 60_000 })
  const hostRefused = putTo(page, '/api/host-servers/')
  await hostToken.click()
  await hostToken.press('End')
  await page.keyboard.type(' ')
  await hostToken.press('Enter')
  const hostAnswer = await hostRefused
  expect(hostAnswer.status()).toBe(400)
  expect(await hostAnswer.json()).toMatchObject({ field: `hosts.${HOST}.server.expose.options.token`, reason: 'edited_mask' })
  await expect(rowErrorOf(hostToken)).toContainText(message(`hosts.${HOST}.server.expose.options.token`))
  expect(await diskText()).toBe(before)
  expect(before).not.toContain(B)
})

test('Open from a browser: text typed while an option is being saved stays in its box', async ({ page }) => {
  await reset()
  await openSettings(page, 'settings-nav-devices')
  const group = page.getByTestId('browser-access')
  const name = group.getByTestId('browser-access-option-name')
  await expect(name).toHaveValue(fixture!.expose.options.name!, { timeout: 60_000 })

  // Hold the save until the person has typed on (gate r9 L-3; base kept the newer text, r3b9 lost it).
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/expose', async (route) => {
    if (route.request().method() === 'PUT') await held
    await route.continue()
  })
  const first = putTo(page, '/api/expose')
  await name.fill('mac-gamma')
  await name.press('Enter')
  await page.waitForTimeout(300)
  await name.fill('mac-gamma-two')
  release()
  expect((await first).status()).toBe(200)
  await page.unroute('**/api/expose')
  await expect.poll(async () => (await disk()).expose.options.name, { timeout: 15_000 }).toBe('mac-gamma')
  // Past the write's answer, a reload and a poll: the newer text is still there, unsaved.
  await page.waitForTimeout(1500)
  await expect(name).toHaveValue('mac-gamma-two')

  // Saved in its turn, it lands too.
  const second = putTo(page, '/api/expose')
  await name.press('Enter')
  expect((await second).status()).toBe(200)
  await expect.poll(async () => (await disk()).expose.options.name, { timeout: 15_000 }).toBe('mac-gamma-two')
  await expect(name).toHaveValue('mac-gamma-two')
})
