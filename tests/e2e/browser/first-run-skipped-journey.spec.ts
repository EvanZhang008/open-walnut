/**
 * One person's way through, start to end: a fresh install asks about the host found in
 * ~/.ssh/config, the person says Not now, and later the new task panel still offers that host with
 * one Connect, after which a folder on it is picked and the first message typed. Nothing on the way
 * sends the person to Settings (2026-11-12, the user: "如果他 missed setup, but it's still okay ...
 * 不用去进设置 ... 它就点一下 OK ... 打开的时候就没有任何的 confusion").
 *
 * The question, the found host, its folders and the two host actions are laid over the fixture
 * server; nothing reaches its config or dials a host, and nothing is sent. `PW_VIDEO=1` records it.
 * WebKit: `PW_WEBKIT=1 bun x playwright test first-run-skipped-journey --project=webkit --workers=1`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Route } from '@playwright/test'
import { draftComposer, draftCwdPill, openDraft } from './draft-helpers'
import { dropFakes } from './route-teardown'

test.setTimeout(180_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/wn-first-run-journey'

const statusOf = (host: string, over: Record<string, unknown> = {}) => ({
  host, label: host, hostname: '10.0.0.9', connected: false, phase: 'idle', phaseLabel: '',
  steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: Date.now(), ...over,
})
const connected = (host: string) => {
  const at = Date.now()
  return statusOf(host, { connected: true, phase: 'connected', connectedAt: at, readiness: { checkedAt: at, problems: [] } })
}

test.beforeAll(() => { mkdirSync(SHOTS, { recursive: true }) })
test.afterEach(async ({ page }) => { await dropFakes(page) })

test('setup skipped: the new task panel still offers the found host, and one Connect is all it takes', async ({ page }) => {
  let pending = ['hosts']
  const answers: string[] = []
  const yes: string[] = []
  let added = false
  const statuses: Record<string, Record<string, unknown>> = {}
  const foundEntry = { hostname: '10.0.0.9', user: 'sam', label: 'labbox', discovered: true, connect: 'ask', enabled: false }

  await page.route((url) => url.pathname === '/api/first-run', (route) => route.fulfill({ json: { pending } }))
  await page.route((url) => url.pathname === '/api/first-run/answer', async (route) => {
    const { step } = route.request().postDataJSON() as { step: string }
    answers.push(step)
    pending = pending.filter((s) => s !== step)
    await route.fulfill({ json: { ok: true, pending } })
  })
  await page.route((url) => url.pathname === '/api/config', async (route: Route) => {
    if (route.request().method() !== 'GET') { await route.fulfill({ json: { ok: true } }); return }
    const res = await route.fetch()
    const body = await res.json() as { config: { hosts?: Record<string, unknown> } }
    const labbox = { ...foundEntry, connect: added ? 'yes' : 'ask', enabled: added }
    await route.fulfill({ response: res, json: { ...body, config: { ...body.config, hosts: { ...(body.config.hosts ?? {}), labbox } } } })
  })
  await page.route('**/api/hosts/*/ssh-key', (route) => route.fulfill({ json: { key: null } }))
  await page.route((url) => url.pathname === '/api/sessions/working-dirs', async (route: Route) => {
    const res = await route.fetch()
    const body = await res.json() as { dirs: Array<{ host?: string | null }> }
    await route.fulfill({ json: {
      dirs: body.dirs.filter((d) => !d.host),
      hosts: added ? [{ alias: 'labbox', label: 'labbox' }] : [],
      found: added ? [] : [{ alias: 'labbox', label: 'labbox' }],
    } })
  })
  await page.route((url) => url.pathname === '/api/hosts/status', (route) =>
    route.fulfill({ json: { hosts: Object.values(statuses) } }))
  await page.route((url) => url.pathname === '/api/sessions/list-dirs', async (route: Route) => {
    const host = new URL(route.request().url()).searchParams.get('host')
    if (!host) { await route.fallback(); return }
    await route.fulfill({ json: { dirs: ['projects', 'notes'], parent: '/home/sam/', exists: true } })
  })
  await page.route('**/api/hosts/*/found-answer', async (route: Route) => {
    const host = decodeURIComponent(route.request().url().split('/api/hosts/')[1].split('/')[0])
    const { answer } = route.request().postDataJSON() as { answer: string }
    if (answer === 'yes') { yes.push(host); added = true; statuses[host] = connected(host) }
    await route.fulfill({ json: { ok: true, host, answer, status: statuses[host] } })
  })

  // 1. First open: the setup asks about the one host it found. The person says Not now.
  await page.goto('/')
  const dialog = page.getByTestId('first-run-dialog')
  await expect(dialog).toBeVisible({ timeout: 30_000 })
  await expect(dialog.getByTestId('first-run-host-labbox')).toContainText('sam@10.0.0.9')
  await page.waitForTimeout(1_200)
  await page.screenshot({ path: `${SHOTS}/1-setup-asks.png` })
  await page.getByTestId('first-run-primary').click()
  await expect(dialog).toHaveCount(0)
  expect(answers).toEqual(['hosts'])
  expect(yes).toEqual([])

  // 2. Later, a new task: the folder picker has a tab for the host, saying what it is, with Connect.
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  const tab = picker.locator('.sps-host-tab[data-host="labbox"]')
  await expect(tab).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(800)
  await tab.click()
  const note = picker.locator('.sps-host-note[data-host="labbox"]')
  await expect(note).toHaveAttribute('data-type', 'found')
  await page.waitForTimeout(1_200)
  await page.screenshot({ path: `${SHOTS}/2-picker-offers-host.png` })

  // 3. One click: added and connected, its folders listed right there.
  await note.getByTestId('sps-note-connect').click()
  await expect.poll(() => yes).toEqual(['labbox'])
  await expect(tab.locator('.sps-host-dot')).toHaveAttribute('data-kind', 'connected', { timeout: 10_000 })
  await expect(picker.locator('.sps-host-note[data-type="found"]')).toHaveCount(0)
  await page.waitForTimeout(1_200)
  await page.screenshot({ path: `${SHOTS}/3-connected.png` })

  // 4. A folder on it, and the first message: the task is ready to start, nothing was sent.
  const input = picker.locator('.sps-search-input')
  await input.pressSequentially('/home/sam/projects', { delay: 40 })
  await input.press('Shift+Enter')
  await expect(picker).toBeHidden()
  await expect(draftCwdPill(panel)).toContainText('projects')
  await expect(draftCwdPill(panel)).toContainText('labbox')
  await draftComposer(page).click()
  await page.keyboard.type('Look at the failing build in projects', { delay: 30 })
  await page.waitForTimeout(1_500)
  await page.screenshot({ path: `${SHOTS}/4-ready-to-start.png` })
})
