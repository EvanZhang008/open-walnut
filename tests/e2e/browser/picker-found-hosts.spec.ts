/**
 * The new task panel's folder picker shows every remote host that is not connected, with
 * Connect (2026-11-11, the user: "if not connect it should always show in the new task panel").
 *
 *   found   a host found in ~/.ssh/config and not added has a tab of its own; its note says so
 *           and Connect is the person's yes (one POST found-answer), after which the tab is the
 *           host's own and follows its connection; nothing lists it, starts there or dials it before
 *   idle    an added host that is not connected, with nothing failed or dialling, says so on its
 *           tab with Connect (one POST connect)
 *
 * The working-dirs answer, the host statuses and the two host actions are laid over the fixture
 * server here; nothing reaches its config or dials a host. page.goto only loads the app.
 * WebKit: `PW_WEBKIT=1 bun x playwright test picker-found-hosts --project=webkit --workers=1`.
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { draftCwdPill, openDraft } from './draft-helpers'
import { dropFakes } from './route-teardown'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR || '/tmp/wn-picker-found-hosts'

const statusOf = (host: string, label: string, over: Record<string, unknown> = {}) => ({
  host, label, hostname: `${host}.example.test`, connected: false, phase: 'idle', phaseLabel: '',
  steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: Date.now(), ...over,
})
/** Connected with Claude Code checked on this connection, so the dot reads connected, not "Checking Claude Code". */
const connected = (host: string, label: string) => {
  const at = Date.now()
  return statusOf(host, label, { connected: true, phase: 'connected', connectedAt: at, readiness: { checkedAt: at, problems: [] } })
}

interface Fake {
  hosts: Array<{ alias: string; label: string }>
  found: Array<{ alias: string; label: string }>
  statuses: Record<string, Record<string, unknown>>
  yes: string[]
  connects: string[]
  /** list-dirs asked of a host that is not added: must stay empty. */
  foundListed: string[]
}

async function serve(page: Page): Promise<Fake> {
  const fake: Fake = {
    hosts: [{ alias: 'idlebox', label: 'Idle box' }],
    found: [{ alias: 'labbox', label: 'labbox' }],
    statuses: { idlebox: statusOf('idlebox', 'Idle box') },
    yes: [], connects: [], foundListed: [],
  }
  await page.route((url) => url.pathname === '/api/sessions/working-dirs', async (route: Route) => {
    const res = await route.fetch()
    const body = await res.json() as { dirs: Array<{ host?: string | null }> }
    const dirs = [
      ...body.dirs.filter((d) => !d.host),
      { cwd: '/home/sam/lab-notes', host: 'labbox', project: '', count: 3, lastUsed: new Date().toISOString() },
    ]
    await route.fulfill({ json: { dirs, hosts: fake.hosts, found: fake.found } })
  })
  await page.route((url) => url.pathname === '/api/hosts/status', (route) =>
    route.fulfill({ json: { hosts: Object.values(fake.statuses) } }))
  await page.route((url) => url.pathname === '/api/sessions/list-dirs', async (route: Route) => {
    const host = new URL(route.request().url()).searchParams.get('host')
    if (!host) { await route.fallback(); return }
    if (fake.found.some((f) => f.alias === host)) fake.foundListed.push(host)
    await route.fulfill({ json: { dirs: ['projects'], parent: '/home/sam/', exists: true } })
  })
  await page.route('**/api/hosts/*/found-answer', async (route: Route) => {
    const host = decodeURIComponent(route.request().url().split('/api/hosts/')[1].split('/')[0])
    const { answer } = route.request().postDataJSON() as { answer: string }
    if (answer === 'yes') {
      fake.yes.push(host)
      const f = fake.found.find((x) => x.alias === host)!
      fake.found = fake.found.filter((x) => x.alias !== host)
      fake.hosts = [...fake.hosts, f]
      fake.statuses[host] = connected(host, f.label)
    }
    await route.fulfill({ json: { ok: true, host, answer, status: fake.statuses[host] } })
  })
  await page.route('**/api/hosts/*/connect', async (route: Route) => {
    const host = decodeURIComponent(route.request().url().split('/api/hosts/')[1].split('/')[0])
    fake.connects.push(host)
    const label = fake.hosts.find((h) => h.alias === host)?.label ?? host
    fake.statuses[host] = connected(host, label)
    await route.fulfill({ json: { ok: true, status: fake.statuses[host] } })
  })
  return fake
}

const picker = (page: Page): Locator => page.locator('.session-path-selector')
const hostTab = (page: Page, host: string): Locator => picker(page).locator(`.sps-host-tab[data-host="${host}"]`)

async function openPicker(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  await expect(picker(page)).toBeVisible({ timeout: 10_000 })
}

test.beforeAll(() => { mkdirSync(SHOTS, { recursive: true }) })
test.afterEach(async ({ page }) => { await dropFakes(page) })

test('a host found in ~/.ssh/config has its own tab in the new task panel, and Connect adds it', async ({ page }) => {
  const fake = await serve(page)
  await openPicker(page)

  const tab = hostTab(page, 'labbox')
  await expect(tab).toBeVisible({ timeout: 20_000 })
  await expect(tab).toHaveAttribute('data-found', '')
  expect(await tab.getAttribute('title')).toBe('labbox: Found in your SSH config, not added yet')
  // Its folders wait for the yes: not under All either.
  await expect(picker(page).locator('.sps-path-item', { hasText: 'lab-notes' })).toHaveCount(0)

  await tab.click()
  await expect(tab).toHaveClass(/active/)
  const note = picker(page).locator('.sps-host-note[data-host="labbox"]')
  await expect(note).toHaveAttribute('data-type', 'found')
  await expect(note.locator('.sps-host-note-text')).toHaveText(
    'Walnut found labbox in your SSH config. It is not added yet; Connect adds it and connects now.')
  await expect(picker(page).locator('.sps-path-item')).toHaveCount(0)
  // Shift+Enter on a typed path starts nothing on a host that is not added.
  const input = picker(page).locator('.sps-search-input')
  await input.fill('/home/sam/lab-notes')
  await input.press('Shift+Enter')
  await expect(picker(page)).toBeVisible()
  await input.fill('')
  expect(fake.foundListed).toEqual([])
  await page.screenshot({ path: `${SHOTS}/found-tab.png`, clip: await picker(page).boundingBox() ?? undefined })

  await note.getByTestId('sps-note-connect').click()
  await expect.poll(() => fake.yes).toEqual(['labbox'])
  // Now an added host: the tab is its own, the found note is gone, and it reads Connected.
  await expect(tab).not.toHaveAttribute('data-found', '', { timeout: 10_000 })
  await expect(tab).toHaveClass(/active/)
  await expect(picker(page).locator('.sps-host-note[data-type="found"]')).toHaveCount(0)
  await expect(tab.locator('.sps-host-dot')).toHaveAttribute('data-kind', 'connected', { timeout: 10_000 })
  expect(fake.yes).toEqual(['labbox'])
  await page.screenshot({ path: `${SHOTS}/found-added.png`, clip: await picker(page).boundingBox() ?? undefined })
})

test('an added host that is not connected says so on its tab, with Connect', async ({ page }) => {
  const fake = await serve(page)
  await openPicker(page)

  const tab = hostTab(page, 'idlebox')
  await expect(tab).toBeVisible({ timeout: 20_000 })
  await tab.click()
  await expect(tab).toHaveClass(/active/)
  const note = picker(page).locator('.sps-host-note[data-host="idlebox"]')
  await expect(note).toHaveAttribute('data-type', 'idle', { timeout: 10_000 })
  await expect(note.locator('.sps-host-note-text')).toHaveText('Idle box is not connected.')
  await page.screenshot({ path: `${SHOTS}/idle-tab.png`, clip: await picker(page).boundingBox() ?? undefined })

  await note.getByTestId('sps-note-connect').click()
  await expect.poll(() => fake.connects).toEqual(['idlebox'])
  await expect(picker(page).locator('.sps-host-note[data-type="idle"]')).toHaveCount(0, { timeout: 10_000 })
  await expect(tab.locator('.sps-host-dot')).toHaveAttribute('data-kind', 'connected', { timeout: 10_000 })
  expect(fake.connects).toEqual(['idlebox'])
  await page.screenshot({ path: `${SHOTS}/idle-connected.png`, clip: await picker(page).boundingBox() ?? undefined })
})
