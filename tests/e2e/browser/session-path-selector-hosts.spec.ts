/**
 * Session path selector — first-run and remote-host robustness.
 *
 * Two shipped reports from a fresh install: "typing / lists nothing" (the live
 * listing skipped one-character paths) and "my remote host shows no folders,
 * no error" (a first connect installs the daemon, ran past the 15s list-dirs
 * cap, and the failure was an 11px 0.55-opacity italic line).
 *
 * The remote host is injected through page.route: no ssh is spawned, and the
 * server contract itself is pinned in tests/web/routes/list-dirs-pending.test.ts.
 * Every interaction is a real UI action; page.goto('/') only for load.
 */
import { test, expect, type Page, type Route } from '@playwright/test'
import { openDraft } from './draft-helpers'

const HOST = 'devbox'
const HOST_LABEL = 'Big dev box'

const input = (page: Page) => page.locator('.sps-search-input')
const list = (page: Page) => page.locator('.sps-path-list')

async function openPicker(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openDraft(page)
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()
  await expect(page.locator('.session-path-selector')).toBeVisible()
  if ((await input(page).inputValue()) !== '') {
    await input(page).press('Escape')
    await expect(input(page)).toHaveValue('')
  }
}

/** Inject one configured remote host into the working-dirs answer (history untouched). */
async function injectHost(page: Page): Promise<void> {
  await page.route('**/api/sessions/working-dirs', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { dirs: unknown[]; hosts?: unknown[] }
    body.hosts = [...(body.hosts ?? []), { alias: HOST, label: HOST_LABEL }]
    await route.fulfill({ response: res, json: body })
  })
}

type ListDirsAnswer =
  | { kind: 'pending'; phase: string; label: string }
  | { kind: 'error'; message: string; hint: string; retryInMs?: number }
  | { kind: 'dirs'; dirs: string[] }

/** Script the remote host's list-dirs answers in order; the last one repeats. */
function scriptRemoteListDirs(page: Page, answers: ListDirsAnswer[]) {
  const calls: URL[] = []
  let i = 0
  const handler = async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('host') !== HOST) return route.fallback()
    const prefix = url.searchParams.get('prefix') ?? '/'
    const parent = prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1)
    // Opening the picker pre-warms every configured host with a `~/` listing;
    // that is not the user's typing, so it must not consume a scripted answer.
    if (prefix === '~/') {
      return route.fulfill({ json: { dirs: [], parent, exists: true, pending: { phase: 'ssh', label: 'prewarm', elapsedMs: 0 } } })
    }
    calls.push(url)
    const a = answers[Math.min(i, answers.length - 1)]
    i++
    if (a.kind === 'pending') {
      return route.fulfill({ json: { dirs: [], parent, exists: true, pending: { phase: a.phase, label: a.label, elapsedMs: 1200 } } })
    }
    if (a.kind === 'error') {
      return route.fulfill({ json: { dirs: [], parent, exists: true, hostError: { message: a.message, kind: 'auth', hint: a.hint, retryInMs: a.retryInMs } } })
    }
    return route.fulfill({ json: { dirs: a.dirs.map(d => parent + d), parent, exists: true } })
  }
  return { calls, install: () => page.route('**/api/sessions/list-dirs**', handler) }
}

test('a bare "/" lists the filesystem root live', async ({ page }) => {
  await openPicker(page)
  await input(page).fill('/')
  // /usr exists as a real directory on every Unix the fixture runs on.
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'usr' })).toBeVisible()
  await expect(list(page).locator('.sps-empty', { hasText: 'No matches' })).toHaveCount(0)
  // And typing on from there keeps working (the next segment lists too).
  await input(page).fill('/usr/')
  await expect(list(page).locator('.sps-path-item.sps-live').first()).toBeVisible()
})

test('remote host still connecting: the connect step is shown, then the folders land', async ({ page }) => {
  await injectHost(page)
  const remote = scriptRemoteListDirs(page, [
    { kind: 'pending', phase: 'install-runtime', label: `Installing the session daemon runtime on ${HOST_LABEL} (first connect, usually under a minute)` },
    { kind: 'pending', phase: 'start', label: `Starting the session daemon on ${HOST_LABEL}` },
    { kind: 'dirs', dirs: ['projects', 'scratch'] },
  ])
  await remote.install()
  await openPicker(page)
  await page.locator('.sps-host-tab', { hasText: HOST_LABEL }).click()
  await input(page).fill('/home/me/')

  const connecting = list(page).locator('.sps-host-connecting')
  await expect(connecting).toBeVisible()
  await expect(connecting).toContainText('Installing the session daemon runtime on Big dev box')
  // One wait, one indicator: the generic line must not stack on the host row.
  await expect(list(page).locator('.sps-empty', { hasText: 'Loading paths' })).toHaveCount(0)
  await expect(list(page).locator('.sps-host-down')).toHaveCount(0)

  // Polling advances through the phases and ends in the real listing.
  await expect(connecting).toContainText('Starting the session daemon on Big dev box')
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'projects' })).toBeVisible()
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'scratch' })).toBeVisible()
  await expect(connecting).toHaveCount(0)
  expect(remote.calls.length).toBeGreaterThanOrEqual(3)
  for (const c of remote.calls) expect(c.searchParams.get('pending')).toBe('1')
})

test('remote host connect failed: cause + next step are readable, Retry clears the failure cache and re-lists', async ({ page }) => {
  await injectHost(page)
  const retries: string[] = []
  await page.route('**/api/sessions/host-retry', async (route) => {
    retries.push(route.request().postDataJSON()?.host)
    await route.fulfill({ json: { ok: true } })
  })
  const remote = scriptRemoteListDirs(page, [
    { kind: 'error', message: 'Permission denied (publickey).', hint: 'Walnut runs `ssh me@devbox.example.test` without a password prompt. Make sure that command works from this machine on its own, then retry.', retryInMs: 58_000 },
    { kind: 'dirs', dirs: ['work'] },
  ])
  await remote.install()
  await openPicker(page)
  await page.locator('.sps-host-tab', { hasText: HOST_LABEL }).click()
  await input(page).fill('/home/me/')

  const down = list(page).locator('.sps-host-down')
  await expect(down).toBeVisible()
  await expect(down).toContainText('Could not connect to Big dev box')
  await expect(down).toContainText('Permission denied (publickey).')
  await expect(down).toContainText('ssh me@devbox.example.test')
  // Readable, not the old 0.55-opacity whisper.
  expect(await down.evaluate(el => parseFloat(getComputedStyle(el).opacity))).toBe(1)
  expect(await down.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12)

  const callsBefore = remote.calls.length
  await down.getByRole('button', { name: 'Retry' }).click()
  await expect.poll(() => retries).toEqual([HOST])
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'work' })).toBeVisible()
  await expect(down).toHaveCount(0)
  expect(remote.calls.length).toBeGreaterThan(callsBefore)
})

test('All tab: local folders show at once while the remote host is still connecting', async ({ page }) => {
  await injectHost(page)
  const remote = scriptRemoteListDirs(page, [
    { kind: 'pending', phase: 'ssh', label: `Opening an SSH connection to ${HOST_LABEL}` },
  ])
  await remote.install()
  await openPicker(page)
  await page.locator('.sps-host-tab', { hasText: 'All' }).click()
  await input(page).fill('/')

  // Local answers land and render while the remote host keeps connecting.
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'usr' })).toBeVisible()
  await expect(list(page).locator('.sps-host-connecting')).toContainText('Opening an SSH connection to Big dev box')
})

test('the connect step survives typing: no flash back to the generic spinner, follow-up polls wait less', async ({ page }) => {
  await injectHost(page)
  const remote = scriptRemoteListDirs(page, [
    { kind: 'pending', phase: 'install-runtime', label: `Installing the session daemon runtime on ${HOST_LABEL} (first connect, usually under a minute)` },
  ])
  await remote.install()
  await openPicker(page)
  await page.locator('.sps-host-tab', { hasText: HOST_LABEL }).click()
  await input(page).fill('/home/')
  const connecting = list(page).locator('.sps-host-connecting')
  await expect(connecting).toContainText('Installing the session daemon runtime')

  // Watch the list across the next keystrokes: the host row must stay, and the
  // generic "Loading paths..." must never take its place.
  await page.evaluate(() => {
    const w = window as unknown as { __flash: number; __mo?: MutationObserver }
    w.__flash = 0
    const root = document.querySelector('.sps-path-list')!
    w.__mo = new MutationObserver(() => {
      if (root.textContent?.includes('Loading paths')) w.__flash++
    })
    w.__mo.observe(root, { childList: true, subtree: true, characterData: true })
  })
  await input(page).pressSequentially('me/', { delay: 120 })
  await expect.poll(() => remote.calls.some(c => c.searchParams.get('prefix') === '/home/me/')).toBe(true)
  await expect(connecting).toContainText('Installing the session daemon runtime')
  expect(await page.evaluate(() => (window as unknown as { __flash: number }).__flash)).toBe(0)

  // The first request for a host waits the server default; once the host is
  // known to be connecting every poll asks for the short wait.
  const waits = remote.calls.map(c => c.searchParams.get('wait'))
  expect(waits[0]).toBe('3000')
  expect(waits.slice(1)).toContain('500')
  expect(waits.slice(1)).not.toContain('3000')
})

test('All tab, two hosts: Retry on one host re-lists only that host', async ({ page }) => {
  const OTHER = 'otherbox'
  await page.route('**/api/sessions/working-dirs', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { dirs: unknown[]; hosts?: unknown[] }
    body.hosts = [...(body.hosts ?? []), { alias: HOST, label: HOST_LABEL }, { alias: OTHER, label: 'Other box' }]
    await route.fulfill({ response: res, json: body })
  })
  await page.route('**/api/sessions/host-retry', (route) => route.fulfill({ json: { ok: true } }))
  const calls: Array<{ host: string; prefix: string }> = []
  let devboxFailed = false
  await page.route('**/api/sessions/list-dirs**', async (route) => {
    const url = new URL(route.request().url())
    const host = url.searchParams.get('host')
    const prefix = url.searchParams.get('prefix') ?? '/'
    // Local and the fixture's own remote host keep their real answers.
    if (host !== HOST && host !== OTHER) return route.fallback()
    // The picker pre-warms `~/` per host on open; that is not the user's typing.
    if (prefix === '~/') {
      return route.fulfill({ json: { dirs: [], parent: prefix, exists: true, pending: { phase: 'ssh', label: 'prewarm', elapsedMs: 0 } } })
    }
    calls.push({ host, prefix })
    if (host === OTHER) {
      return route.fulfill({ json: { dirs: [prefix + 'shared'], parent: prefix, exists: true } })
    }
    if (!devboxFailed) {
      devboxFailed = true
      return route.fulfill({ json: { dirs: [], parent: prefix, exists: true, hostError: { message: 'Connection refused', kind: 'refused', hint: 'Check sshd.' } } })
    }
    return route.fulfill({ json: { dirs: [prefix + 'recovered'], parent: prefix, exists: true } })
  })
  await openPicker(page)
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await input(page).fill('/srv/')
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'shared' })).toBeVisible()
  const down = list(page).locator('.sps-host-down')
  await expect(down).toContainText('Could not connect to Big dev box')

  const otherBefore = calls.filter(c => c.host === OTHER).length
  await down.getByRole('button', { name: 'Retry' }).click()
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'recovered' })).toBeVisible()
  await expect(down).toHaveCount(0)
  // The other host's rows never left, and it was not asked again.
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'shared' })).toBeVisible()
  expect(calls.filter(c => c.host === OTHER).length).toBe(otherBefore)
})

test('typing on while a host is pending stops the old poll: no request for the stale prefix', async ({ page }) => {
  await injectHost(page)
  const remote = scriptRemoteListDirs(page, [
    { kind: 'pending', phase: 'ssh', label: `Opening an SSH connection to ${HOST_LABEL}` },
  ])
  await remote.install()
  await openPicker(page)
  await page.locator('.sps-host-tab', { hasText: HOST_LABEL }).click()
  await input(page).fill('/old/')
  await expect(list(page).locator('.sps-host-connecting')).toBeVisible()
  await input(page).fill('/new/')
  await expect.poll(() => remote.calls.some(c => c.searchParams.get('prefix') === '/new/')).toBe(true)
  const mark = remote.calls.length
  // Two poll intervals later, every new request is for the new prefix.
  await page.waitForTimeout(3500)
  const late = remote.calls.slice(mark)
  expect(late.length).toBeGreaterThan(0)
  for (const c of late) expect(c.searchParams.get('prefix')).toBe('/new/')
})

/**
 * The remote home of a fresh host as the list-dirs route answers it. `~/workplace`
 * is a symlink to `/workplace` (common on Linux dev boxes): the daemon tags it
 * `symlink: true` with its resolvedPath, and the server walker (dir-listing.ts)
 * lists it UNDER THE HOME and never walks into it, so over HTTP it is a depth-1
 * entry with no preloaded children, while the real `~/workspace` has one.
 */
function aliceHomeListing(prefix: string): { dirs: string[]; parent: string; exists: boolean } {
  const raw = prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1)
  const parent = raw.startsWith('~/') ? `/home/alice/${raw.slice(2)}` : raw
  if (parent === '/home/alice/') {
    return { dirs: ['/home/alice/workplace', '/home/alice/workspace', '/home/alice/workspace/api', '/home/alice/notes'], parent, exists: true }
  }
  // Listing the link itself follows it: /workplace's children, under the link path.
  if (parent === '/home/alice/workplace/') return { dirs: ['/home/alice/workplace/walnut'], parent, exists: true }
  return { dirs: [], parent, exists: true }
}

test('fresh remote host: a bare word lists the matching home folders, picking one fills the real path', async ({ page }) => {
  await injectHost(page)
  const requests: Array<{ host: string | null; prefix: string }> = []
  await page.route('**/api/sessions/list-dirs**', async (route) => {
    const url = new URL(route.request().url())
    const host = url.searchParams.get('host')
    const prefix = url.searchParams.get('prefix') ?? '/'
    requests.push({ host, prefix })
    if (host !== HOST) return route.fallback()
    return route.fulfill({ json: aliceHomeListing(prefix) })
  })
  await openPicker(page)
  await page.locator('.sps-host-tab', { hasText: HOST_LABEL }).click()
  // No history on this host: the picker opens on its home (~/ resolved remotely).
  await expect(input(page)).toHaveValue('/home/alice/')
  const mark = requests.length

  await input(page).fill('work')
  const home = list(page).locator('[data-section-id="home:devbox"]')
  const label = home.locator('.sps-section-label')
  await expect(label).toBeVisible()
  expect(await label.innerText()).toContain('HOME FOLDERS')
  const rows = home.locator('.sps-path-item')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('~/workplace')
  await expect(rows.nth(1)).toContainText('~/workspace')
  await expect(home).not.toContainText('notes')
  await expect(list(page).locator('.sps-empty')).toHaveCount(0)
  // A single host tab lists only that host: no fan-out to Local for the word.
  for (const r of requests.slice(mark)) expect(r.host).toBe(HOST)

  await rows.first().click()
  await expect(input(page)).toHaveValue('/home/alice/workplace/')
  // And it keeps drilling through the symlinked folder like any subdirectory.
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'walnut' })).toBeVisible()
})

test('a bare word with nothing to match says so; an empty input shows no home folders', async ({ page }) => {
  await injectHost(page)
  await page.route('**/api/sessions/list-dirs**', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('host') !== HOST) return route.fallback()
    return route.fulfill({ json: aliceHomeListing(url.searchParams.get('prefix') ?? '/') })
  })
  await openPicker(page)
  await page.locator('.sps-host-tab', { hasText: HOST_LABEL }).click()
  await expect(input(page)).toHaveValue('/home/alice/')
  await input(page).fill('zzqx')
  await expect(list(page).locator('.sps-empty')).toContainText('No history or home folder matches "zzqx"')
  await expect(list(page).locator('[data-section-id^="home:"]')).toHaveCount(0)
  await input(page).fill('')
  await expect(list(page).locator('[data-section-id^="home:"]')).toHaveCount(0)
})

test('a host added after the picker first opened gets a tab on the next open, without a reload', async ({ page }) => {
  // Stands in for the user adding the host in Settings while this page stays open.
  let hostAdded = false
  let served = 0
  await page.route('**/api/sessions/working-dirs', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { dirs: unknown[]; hosts?: unknown[] }
    if (hostAdded) body.hosts = [...(body.hosts ?? []), { alias: HOST, label: HOST_LABEL }]
    served++ // the body is decided: counting it before the send cannot race the page
    await route.fulfill({ response: res, json: body })
  })
  const devboxPrefixes: string[] = []
  await page.route('**/api/sessions/list-dirs**', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('host') !== HOST) return route.fallback()
    const prefix = url.searchParams.get('prefix') ?? '/'
    devboxPrefixes.push(prefix)
    const parent = prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1)
    return route.fulfill({ json: { dirs: [parent + 'from-devbox'], parent, exists: true } })
  })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => { (window as unknown as { __samePage?: boolean }).__samePage = true })
  const panel = await openDraft(page)
  const chip = panel.locator('.draft-composer-bar .session-action-chip').first()
  const picker = page.locator('.session-path-selector')
  const devboxTab = page.locator('.sps-host-tab', { hasText: HOST_LABEL })

  await chip.click()
  await expect(picker).toBeVisible()
  // The page's warm-up and this open's revalidation have both been answered.
  await expect.poll(() => served).toBeGreaterThanOrEqual(2)
  await expect(devboxTab).toHaveCount(0)
  if ((await input(page).inputValue()) !== '') await input(page).press('Escape')
  await input(page).press('Escape')
  await expect(picker).toHaveCount(0)

  hostAdded = true
  const servedBefore = served
  await chip.click()
  await expect(picker).toBeVisible()
  await expect(devboxTab).toBeVisible()
  expect(served).toBeGreaterThan(servedBefore)
  expect(await page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage)).toBe(true)
  // The new host is pre-warmed on this open, and the All tab lists it.
  await expect.poll(() => devboxPrefixes.length).toBeGreaterThan(0)
  await page.locator('.sps-host-tab').filter({ hasText: /^All$/ }).click()
  await input(page).fill('/srv/')
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'from-devbox' })).toBeVisible()
})
