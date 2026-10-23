/**
 * A session on Cloud whose companion stays connected and stops answering (the
 * fixture's link proxy in blackhole: the tunnel is up, nothing comes back).
 * Real clicks only after the first load:
 *   1. the session's Files tab;
 *   2. the slash-command menu in that session's composer;
 *   3. the folder picker on the Cloud tab.
 * Each must answer on screen within the host-read bound (a read that goes quiet
 * for 3s asks the link once, for 3s), in the host's label and never its internal
 * alias, and no request the page made may be held longer than that. The designed
 * "Reconnecting" answer must not raise the red "This API endpoint is failing"
 * card. Before the bound, Files sat 60s on "daemon command timeout: fs.ls
 * (30000ms)" and its listing request ended in a 500.
 *
 * Then, on the same fixture (serial):
 *   - removing a cloud phone while the companion accepts TCP and never answers
 *     says how long the Mac waited, in plain words, in both engines (the
 *     browser's own deadline used to fire first: "signal timed out" in
 *     Chromium, "Fetch is aborted" in WebKit);
 *   - a long history on a slow link that answers: the column keeps what it
 *     shows, says it is still loading from Cloud, and the history arrives,
 *     never "No conversation history found" or the stale banner meanwhile;
 *   - the operator removes this Mac on the companion: the Cloud card stops
 *     saying "Connected".
 *
 * Fixture: cloud-host-server.ts with CLOUD_HOST_LINK_CONTROL=1, one per engine
 * (cloud-host-silent-link.config.ts). Screenshots are cropped to the column, the
 * palette and the picker; CLOUD_HOST_SHOTS picks their directory.
 */
import { bunRuntime } from '../../helpers/bun-runtime.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type Page, type Locator } from '@playwright/test'
import { draftComposer, draftCwdPill, draftPanel, draftSend, loadHome, openDraft, REAL_PANEL, seedColumns } from './draft-helpers'

const SHOTS = process.env.CLOUD_HOST_SHOTS ?? path.join(os.tmpdir(), 'walnut-cloud-host-shots')
const CLOUD = '__cloudbox__'
/** The quiet point plus one probe, with room for a loaded machine. */
const BOUND_MS = 9_000

test.describe.configure({ mode: 'serial' })

interface Fixture { projects: string; linkControlPort: number; boxData: string; boxHome: string; base: string }

/** The session the first test starts on Cloud (the later tests reuse it). */
let cloudSessionId: string | null = null
type LinkMode = 'pass' | 'blackhole' | 'drop-hold' | 'slow'
const setLinkOf = (fx: Fixture) => async (m: LinkMode, slow?: { ms: number; bps: number }) =>
  (await fetch(`http://127.0.0.1:${fx.linkControlPort}/mode?m=${m}${slow ? `&ms=${slow.ms}&bps=${slow.bps}` : ''}`)).json()
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

/** This engine's fixture (port-keyed file written by cloud-host-server.ts). */
async function fixture(): Promise<Fixture> {
  const port = new URL(String(test.info().project.use.baseURL)).port
  const file = path.join(os.tmpdir(), `walnut-cloudhost-pw-${port}.json`)
  for (let i = 0; i < 240 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 250))
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Fixture
}

interface Req { url: string; ms: number; status: number | string; startedAt: number }

/** Every /api request the page makes, with how long it was held. */
function trackRequests(page: Page): { done: Req[]; pending: () => Array<{ url: string; ms: number }> } {
  const start = new Map<object, { url: string; t: number }>()
  const done: Req[] = []
  const short = (u: string) => u.replace(/^https?:\/\/[^/]+/, '')
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) start.set(r, { url: r.url(), t: Date.now() }) })
  page.on('requestfinished', async (r) => {
    const s = start.get(r)
    if (!s) return
    start.delete(r)
    const resp = await r.response().catch(() => null)
    done.push({ url: short(s.url), ms: Date.now() - s.t, status: resp?.status() ?? '?', startedAt: s.t })
  })
  page.on('requestfailed', (r) => {
    const s = start.get(r)
    if (!s) return
    start.delete(r)
    done.push({ url: short(s.url), ms: Date.now() - s.t, status: `failed:${r.failure()?.errorText ?? ''}`, startedAt: s.t })
  })
  return { done, pending: () => [...start.values()].map((s) => ({ url: short(s.url), ms: Date.now() - s.t })) }
}

test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })

test('a connected companion that went silent: Files, the slash menu and the folder picker answer in time, in its name', async ({ page, browserName }) => {
  test.setTimeout(420_000)
  const fx = await fixture()
  const setLink = async (m: 'pass' | 'blackhole') => (await fetch(`http://127.0.0.1:${fx.linkControlPort}/mode?m=${m}`)).json()
  await setLink('pass')
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const net = trackRequests(page)

  // ── A session on Cloud, while the companion answers ──
  await loadHome(page)
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 15_000 })
  const tab = picker.locator(`.sps-host-tab[data-host="${CLOUD}"]`)
  await expect(tab).toBeVisible({ timeout: 90_000 })
  await tab.click()
  const input = picker.locator('.sps-search-input')
  await input.fill(`${fx.projects}/`)
  const rows = picker.locator('.sps-path-item')
  await expect(rows.filter({ hasText: 'alpha' }).first()).toBeVisible({ timeout: 120_000 })
  await input.fill(`${fx.projects}/alpha`)
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  await input.press('Shift+Enter')
  await expect(picker).toBeHidden({ timeout: 15_000 })
  const reply = `silent link reply in ${browserName}`
  await draftComposer(page).fill(`snapshot-clean-turn:${reply}`)
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start', { timeout: 120_000 })
  await draftSend(draftPanel(page)).click()
  let res = await started
  if (res.status() === 409) {
    const again = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/sessions/quick-start', { timeout: 120_000 })
    await page.getByRole('button', { name: 'Start anyway' }).click()
    res = await again
  }
  expect(res.status(), await res.text()).toBe(200)
  const { sessionId } = await res.json() as { sessionId: string }
  cloudSessionId = sessionId
  const column = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(column).toBeVisible({ timeout: 60_000 })
  await expect(column.getByText(reply, { exact: true }).first()).toBeVisible({ timeout: 120_000 })
  await expect(column.getByText('Claude Code is working')).toHaveCount(0, { timeout: 60_000 })

  // ── The companion goes silent; the tunnel stays up ──
  await setLink('blackhole')
  const silentAt = Date.now()
  await page.waitForTimeout(1_500)

  // 1. The Files tab: its listing answers "Reconnecting to Cloud" in place.
  let t0 = Date.now()
  await column.locator('.session-action-chip').filter({ hasText: 'Files' }).click()
  const explorer = column.locator('.session-file-explorer')
  const filesAnswer = explorer.getByText('Reconnecting to Cloud').first()
  await expect(filesAnswer).toBeVisible({ timeout: BOUND_MS + 6_000 })
  const filesMs = Date.now() - t0
  const filesText = await explorer.innerText()
  await column.screenshot({ path: path.join(SHOTS, `silent-link-files-${browserName}.png`) })

  // 2. The slash-command menu in this session's composer.
  const composer = column.locator('.session-panel-input .chat-input-textarea')
  await composer.click()
  t0 = Date.now()
  await composer.pressSequentially('/')
  const palette = column.locator('.command-palette')
  await expect(palette.locator('.command-palette-name').first()).toBeVisible({ timeout: BOUND_MS + 6_000 })
  const slashMs = Date.now() - t0
  const slashText = await palette.innerText()
  await palette.screenshot({ path: path.join(SHOTS, `silent-link-slash-${browserName}.png`) })
  await composer.press('Escape')
  await composer.fill('')

  // 3. The folder picker on the Cloud tab. Files expanded the column to full
  // screen: collapse it the way a user would before opening a new draft.
  const collapse = column.locator('[title="Collapse back"]')
  if (await collapse.count()) await collapse.first().click()
  await expect(page.locator('.new-launcher-btn')).toBeVisible({ timeout: 15_000 })
  const draft2 = await openDraft(page)
  await draftCwdPill(draft2).click()
  await expect(picker).toBeVisible({ timeout: 15_000 })
  await expect(tab).toBeVisible({ timeout: 30_000 })
  t0 = Date.now()
  await tab.click()
  await input.fill(`${fx.projects}/`)
  const pickerAnswer = picker.locator(`.sps-host-note[data-host="${CLOUD}"], .sps-host-connecting[data-host="${CLOUD}"], .sps-host-note-failure, .sps-path-item`).first()
  await expect(pickerAnswer).toBeVisible({ timeout: BOUND_MS + 6_000 })
  const pickerMs = Date.now() - t0
  // Let any request the picker started finish or be held, then read what it says.
  await page.waitForTimeout(4_000)
  const pickerText = await picker.innerText()
  await picker.screenshot({ path: path.join(SHOTS, `silent-link-picker-${browserName}.png`) })

  // The incident pipeline posts asynchronously: give it the time it would take.
  await page.waitForTimeout(3_000)
  const incidentCards = await page.getByText('This API endpoint is failing').count()
  const silentReqs = net.done.filter((r) => r.startedAt >= silentAt)
  const held = silentReqs.filter((r) => r.ms > BOUND_MS)
  const pendingNow = net.pending().filter((r) => r.ms > BOUND_MS)
  fs.writeFileSync(path.join(SHOTS, `silent-link-${browserName}.json`), JSON.stringify({
    filesMs, slashMs, pickerMs, filesText: filesText.slice(0, 600), slashText: slashText.slice(0, 400), pickerText: pickerText.slice(0, 800),
    incidentCards, held, pendingNow, requests: silentReqs, errors,
  }, null, 2))
  await setLink('pass')

  for (const [k, t] of [['files', filesText], ['slash', slashText], ['picker', pickerText]] as const) {
    expect(t, k).not.toContain(CLOUD)
  }
  expect(filesText).toContain('Reconnecting to Cloud')
  expect(filesText).not.toMatch(/daemon command timeout/)
  expect(pickerText).toContain('Cloud')
  expect(filesMs).toBeLessThan(BOUND_MS)
  expect(slashMs).toBeLessThan(BOUND_MS)
  expect(pickerMs).toBeLessThan(BOUND_MS)
  expect(held, JSON.stringify(held)).toEqual([])
  expect(pendingNow, JSON.stringify(pendingNow)).toEqual([])
  expect(silentReqs.filter((r) => r.status === 500), 'a 500 while silent').toEqual([])
  expect(incidentCards).toBe(0)
  expect(errors).toEqual([])
})

/** Settings › Phones & Cloud, by clicks. */
async function openDevices(page: Page): Promise<Locator> {
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-devices').click()
  const section = page.locator('#devices')
  await expect(section).toBeVisible({ timeout: 30_000 })
  return section
}

test('removing a cloud phone while the companion does not answer says how long the Mac waited, in plain words', async ({ page, browserName }) => {
  test.setTimeout(300_000)
  const fx = await fixture()
  const setLink = setLinkOf(fx)
  await setLink('pass')
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await loadHome(page)
  const section = await openDevices(page)
  const phone = section.locator('.devices-row[data-device-name="my-phone"]')
  await expect(phone).toBeVisible({ timeout: 60_000 })
  // The companion accepts TCP and never answers from now on.
  await setLink('drop-hold')
  try {
    const remove = phone.getByTestId('devices-remove')
    await remove.click()
    await expect(remove).toHaveText('Confirm remove')
    const t0 = Date.now()
    await remove.click()
    const rowError = section.locator('.devices-row[data-device-name="my-phone"] + .settings-row-error')
    await expect(rowError).toBeVisible({ timeout: 60_000 })
    const waitedMs = Date.now() - t0
    const text = await rowError.innerText()
    await section.screenshot({ path: path.join(SHOTS, `silent-link-remove-timeout-${browserName}.png`) })
    expect(text).toBe("Couldn't remove: Could not reach the cloud companion (timed out after 15s).")
    // The server's 15s deadline answered, not the browser's own.
    expect(waitedMs).toBeGreaterThan(14_000)
    expect(waitedMs).toBeLessThan(45_000)
  } finally {
    await setLink('pass')
  }
  expect(errors).toEqual([])
})

/** A transcript of about `bytes`, its turns chained by parentUuid as Claude Code writes them. */
function longTranscript(sid: string, cwd: string, bytes: number): { text: string; last: string } {
  const lines: string[] = []
  let size = 0
  let parent: string | null = null
  const pad = 'x'.repeat(4000)
  const t0 = Date.parse('2026-09-01T00:00:00Z')
  let i = 0
  for (; size < bytes; i++) {
    const u = `slow-u-${i}`
    const a = `slow-a-${i}`
    const user = JSON.stringify({ type: 'user', uuid: u, parentUuid: parent, sessionId: sid, cwd, timestamp: new Date(t0 + i * 2000).toISOString(), message: { role: 'user', content: `slow history ${i}: question` } })
    const asst = JSON.stringify({ type: 'assistant', uuid: a, parentUuid: u, sessionId: sid, cwd, timestamp: new Date(t0 + i * 2000 + 1000).toISOString(), message: { id: `msg_slow_${i}`, role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: `slow history ${i}: answer ${pad}` }] } })
    lines.push(user, asst)
    size += user.length + asst.length + 2
    parent = a
  }
  return { text: lines.join('\n') + '\n', last: `slow history ${i - 1}: answer` }
}

/** The box's transcript file of `sid` (the mock CLI writes it under the box's HOME). */
function boxTranscript(fx: Fixture, sid: string): string | null {
  const root = path.join(fx.boxHome, '.claude', 'projects')
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const file = path.join(root, dir, `${sid}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return null
}

test('a long history on a slow link that answers: the column keeps what it shows, says it is loading, and the history arrives', async ({ page, browserName }) => {
  test.setTimeout(420_000)
  test.skip(!cloudSessionId, 'needs the Cloud session the first test starts')
  const fx = await fixture()
  const setLink = setLinkOf(fx)
  const sid = cloudSessionId!
  const file = boxTranscript(fx, sid)
  expect(file, 'the session transcript on the box').toBeTruthy()
  const firstLine = JSON.parse(fs.readFileSync(file!, 'utf-8').split('\n')[0] || '{}') as { cwd?: string }
  // About 5MB: the cold tail (4MB) takes longer than the 60s a request may wait at 64KB/s.
  const long = longTranscript(sid, firstLine.cwd ?? fx.projects, 5 * 1024 * 1024)
  fs.writeFileSync(file!, long.text)
  // From a connected link: the test before left the companion unreachable, and
  // this one is about a slow link that answers, not about a reconnect.
  await setLink('pass')
  await page.request.post(`/api/hosts/${CLOUD}/connect`)
  await expect.poll(async () => {
    const s = await (await page.request.get('/api/hosts/status')).json() as { hosts: Array<{ host: string; connected: boolean }> }
    return s.hosts.find((h) => h.host === CLOUD)?.connected === true
  }, { timeout: 120_000, intervals: [500] }).toBe(true)
  await setLink('slow')
  const seen: string[] = []
  let sawLoadingLine = false
  let loadingAtS = -1
  let arrivedMs = -1
  try {
    await seedColumns(page, [sid])
    // Not loadHome: it waits for the network to go idle, which here happens
    // only once the history has arrived, so the watch below would start after it.
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
    const column = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
    await expect(column).toBeVisible({ timeout: 60_000 })
    const t0 = Date.now()
    while (Date.now() - t0 < 330_000) {
      const text = await column.innerText().catch(() => '')
      const at = Math.round((Date.now() - t0) / 1000)
      if (text.includes('No conversation history found')) seen.push(`empty at ${at}s`)
      if (text.includes('Showing cached history')) seen.push(`stale banner at ${at}s`)
      if (text.includes('Still loading this conversation from Cloud')) {
        if (!sawLoadingLine) await column.screenshot({ path: path.join(SHOTS, `silent-link-history-loading-${browserName}.png`) })
        if (!sawLoadingLine) loadingAtS = at
        sawLoadingLine = true
      }
      if (text.includes(long.last)) { arrivedMs = Date.now() - t0; break }
      await page.waitForTimeout(1_000)
    }
    await column.screenshot({ path: path.join(SHOTS, `silent-link-history-arrived-${browserName}.png`) })
  } finally {
    await setLink('pass')
  }
  fs.writeFileSync(path.join(SHOTS, `silent-link-history-${browserName}.json`), JSON.stringify({ seen, sawLoadingLine, loadingAtS, arrivedMs }, null, 2))
  expect(seen).toEqual([])
  expect(sawLoadingLine).toBe(true)
  expect(arrivedMs).toBeGreaterThan(0)
})

test('a file still arriving on a slow link: the viewer says it is loading from Cloud, asks again, and shows the file', async ({ page, browserName }) => {
  test.setTimeout(420_000)
  test.skip(!cloudSessionId, 'needs the Cloud session the first test starts')
  const fx = await fixture()
  const setLink = setLinkOf(fx)
  const sid = cloudSessionId!
  await setLink('pass')
  // In the session's folder on the box: its first 512KB take longer than 60s at 8KB/s.
  const name = `slow-600k-${browserName}.log`
  const line = 'slow file line 0123456789 abcdefghijklmnopqrstuvwxyz\n'
  fs.writeFileSync(path.join(fx.projects, 'alpha', name), line.repeat(Math.ceil((600 * 1024) / line.length)))
  await seedColumns(page, [sid])
  await loadHome(page)
  const column = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(column).toBeVisible({ timeout: 60_000 })
  await column.locator('.session-action-chip').filter({ hasText: 'Files' }).click()
  const explorer = column.locator('.session-file-explorer')
  const row = explorer.locator('.sfe-name', { hasText: name })
  await expect(row).toBeVisible({ timeout: 60_000 })
  await setLink('slow', { ms: 50, bps: 8 * 1024 })
  const seen: string[] = []
  let sawLoading = false
  let arrivedMs = -1
  try {
    await row.click()
    const t0 = Date.now()
    while (Date.now() - t0 < 300_000) {
      const text = await explorer.innerText().catch(() => '')
      const at = Math.round((Date.now() - t0) / 1000)
      if (text.includes('Try again in a moment')) seen.push(`the payload's error shown at ${at}s`)
      if (text.includes('Still loading from Cloud…')) {
        if (!sawLoading) await column.screenshot({ path: path.join(SHOTS, `silent-link-file-loading-${browserName}.png`) })
        sawLoading = true
      }
      if (text.includes('slow file line 0123456789')) { arrivedMs = Date.now() - t0; break }
      await page.waitForTimeout(1_000)
    }
    await column.screenshot({ path: path.join(SHOTS, `silent-link-file-arrived-${browserName}.png`) })
  } finally {
    await setLink('pass')
  }
  fs.writeFileSync(path.join(SHOTS, `silent-link-file-${browserName}.json`), JSON.stringify({ seen, sawLoading, arrivedMs }, null, 2))
  expect(seen).toEqual([])
  expect(sawLoading).toBe(true)
  expect(arrivedMs).toBeGreaterThan(55_000)
})

/** The browser's own words for a request it gave up on (WebKit says "Fetch is aborted"). */
const BROWSER_ABORT_WORDS = /abort|signal|DOMException|TimeoutError|AbortError/i

test('a Save and a new folder nobody answers: plain words when the browser gives up, in every engine', async ({ page, browserName }) => {
  // The client deadlines (120s for a save, 45s for a new folder) are the timing
  // under test, so they run in full. WebKit rejects a fetch whose deadline fired
  // with AbortError "Fetch is aborted"; the editor and the tree showed exactly
  // that (gate review, 2026-10-05), while Chromium said the designed sentence.
  test.setTimeout(420_000)
  test.skip(!cloudSessionId, 'needs the Cloud session the first test starts')
  const fx = await fixture()
  await setLinkOf(fx)('pass')
  await page.request.post(`/api/hosts/${CLOUD}/connect`)
  await expect.poll(async () => {
    const st = await (await page.request.get('/api/hosts/status')).json() as { hosts: Array<{ host: string; connected: boolean }> }
    return st.hosts.find((h) => h.host === CLOUD)?.connected === true
  }, { timeout: 120_000, intervals: [500] }).toBe(true)
  const name = `held-save-${browserName}.txt`
  fs.writeFileSync(path.join(fx.projects, 'alpha', name), 'held save\n')
  await seedColumns(page, [cloudSessionId!])
  await loadHome(page)
  const column = page.locator(`${REAL_PANEL}[data-session-id="${cloudSessionId}"]`)
  await expect(column).toBeVisible({ timeout: 90_000 })
  await column.locator('.session-action-chip').filter({ hasText: 'Files' }).click({ timeout: 15_000 })
  const row = column.locator('.sfe-name').filter({ hasText: name }).first()
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.click()
  const editor = page.locator('.cm-content').first()
  await expect(editor).toBeVisible({ timeout: 90_000 })
  // A save by hand: Live edit retries its own writes quietly.
  const live = page.locator('.fv-live-toggle').first()
  await expect(live).toBeVisible({ timeout: 30_000 })
  if ((await live.getAttribute('aria-pressed')) === 'true') await live.click()
  await expect(live).toHaveAttribute('aria-pressed', 'false')
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' edited')
  const save = page.locator('.fv-save-btn').first()
  await expect(save).toBeEnabled({ timeout: 15_000 })

  // 1. The save reaches nobody: held until the browser's deadline fires.
  await page.route('**/api/file-content', (route) => { if (route.request().method() !== 'PUT') return route.continue() })
  let t0 = Date.now()
  await save.click()
  const saveError = page.locator('.fv-save-error').first()
  await expect(saveError).toBeVisible({ timeout: 200_000 })
  const saveText = await saveError.innerText()
  const saveMs = Date.now() - t0
  await page.screenshot({ path: path.join(SHOTS, `silent-link-save-held-${browserName}.png`), clip: { x: 0, y: 0, width: 1280, height: 800 } })
  await page.unroute('**/api/file-content')
  expect(saveText).not.toMatch(BROWSER_ABORT_WORDS)
  expect(saveText).toMatch(/^The save got no answer in time\. Your text is still in the editor: press Save again\./)
  expect(saveMs).toBeGreaterThan(100_000)

  // 2. A new folder reaches nobody: the tree says it is still waiting, not an error.
  await page.route('**/api/files/mkdir', () => { /* held: nobody answers */ })
  await column.locator('.session-file-explorer-tree').first().click({ button: 'right', position: { x: 60, y: 300 } })
  await page.getByRole('menuitem', { name: 'New Folder…' }).click({ timeout: 10_000 })
  const input = page.locator('input.sfe-edit-input').first()
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.fill(`held-folder-${browserName}`)
  t0 = Date.now()
  await input.press('Enter')
  const said = page.locator('.sfe-edit-error, .sfe-notice-pending').first()
  await expect(said).toBeVisible({ timeout: 120_000 })
  const folderText = await said.innerText()
  const folderCls = await said.getAttribute('class')
  const folderMs = Date.now() - t0
  await column.screenshot({ path: path.join(SHOTS, `silent-link-mkdir-held-${browserName}.png`) })
  await page.unroute('**/api/files/mkdir')
  fs.writeFileSync(path.join(SHOTS, `silent-link-held-${browserName}.json`), JSON.stringify({ saveText, saveMs, folderText, folderCls, folderMs }, null, 2))
  expect(folderText).not.toMatch(BROWSER_ABORT_WORDS)
  expect(folderCls).toContain('sfe-notice-pending')
  expect(folderMs).toBeGreaterThan(40_000)
})

test('the operator removes this Mac on the companion: the Cloud card stops saying "Connected"', async ({ page, browserName }) => {
  test.setTimeout(300_000)
  const fx = await fixture()
  await setLinkOf(fx)('pass')
  await loadHome(page)
  let section = await openDevices(page)
  const cloudCard = page.locator('#cloud')
  await expect(cloudCard.getByText('Connected', { exact: true })).toBeVisible({ timeout: 60_000 })
  // On the box, as its operator runs it (its own data dir, a local caller).
  const out = execFileSync(bunRuntime(), [path.join(REPO, 'src', 'cli.ts'), 'device', 'revoke', 'mac-primary'], {
    cwd: REPO, encoding: 'utf-8', timeout: 120_000,
    env: {
      ...process.env,
      OPEN_WALNUT_HOME: fx.boxData, HOME: fx.boxHome, USERPROFILE: fx.boxHome,
      WALNUT_CLOUD_MODE: '1', WALNUT_DAEMON_DIR: path.join(fx.base, 'box-cli-logs'), NO_COLOR: '1', FORCE_COLOR: '0',
    },
  })
  expect(out).toContain('revoked')
  // Away and back by clicks: the page reads the list again.
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
  section = await openDevices(page)
  await expect(cloudCard.getByText('Not accepted', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(cloudCard.getByText('Connected', { exact: true })).toHaveCount(0)
  await expect(cloudCard).toContainText("The cloud companion no longer accepts this Mac's token")
  await cloudCard.scrollIntoViewIfNeeded()
  await cloudCard.screenshot({ path: path.join(SHOTS, `silent-link-revoked-card-${browserName}.png`) })
  expect(section).toBeTruthy()
})
