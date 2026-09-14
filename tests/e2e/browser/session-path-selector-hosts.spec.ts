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
