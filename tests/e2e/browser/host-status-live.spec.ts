/**
 * Live remote-host status: the picker, Settings and the System pane show each
 * host's connect progress as it happens, driven by `host:status` WS events
 * rather than by polling list-dirs.
 *
 * The remote host is injected through page.route and the status events are
 * dispatched on the app's real socket (no ssh is spawned). The server side of
 * the contract is pinned in tests/web/routes/hosts-status.test.ts and
 * tests/web/ws/host-status-event.test.ts. Every interaction is a real UI
 * action; page.goto is used only to load the app.
 */
import { test, expect, type Page, type Route } from '@playwright/test'
import { openDraft } from './draft-helpers'

const HOST = 'devbox'
const HOST_LABEL = 'Big dev box'
const HOSTNAME = 'devbox.example.test'

type Phase = 'idle' | 'ssh' | 'probe' | 'install-runtime' | 'upload' | 'start' | 'tunnel' | 'handshake' | 'connected' | 'reconnecting' | 'failed' | 'queued'
const STEPS: Array<{ phase: Phase; label: string }> = [
  { phase: 'ssh', label: 'SSH' },
  { phase: 'probe', label: 'Probe' },
  { phase: 'install-runtime', label: 'Install runtime' },
  { phase: 'upload', label: 'Upload daemon' },
  { phase: 'start', label: 'Start daemon' },
  { phase: 'tunnel', label: 'Tunnel' },
  { phase: 'handshake', label: 'Handshake' },
]

interface HostStatus {
  host: string; label: string; hostname: string; user?: string
  connected: boolean; phase: Phase; phaseLabel: string
  steps: Array<{ phase: Phase; label: string; status: 'done' | 'active' | 'todo' }>
  note?: string; phaseElapsedMs: number; connectElapsedMs: number
  error?: string; kind?: string; hint?: string; retryInMs?: number
  warmup?: string; at: number
}

/** Mirrors describeConnectPhase() in src/core/sessions/host-connect-hint.ts. */
const PHASE_LABEL: Record<Phase, string> = {
  idle: `Connecting to ${HOST_LABEL}`,
  ssh: `Opening an SSH connection to ${HOST_LABEL}`,
  probe: `Checking whether the session daemon is running on ${HOST_LABEL}`,
  'install-runtime': `Installing the session daemon runtime on ${HOST_LABEL} (first connect, usually under a minute)`,
  upload: `Uploading the session daemon to ${HOST_LABEL}`,
  start: `Starting the session daemon on ${HOST_LABEL}`,
  tunnel: `Opening the tunnel to ${HOST_LABEL}`,
  handshake: `Handshaking with the session daemon on ${HOST_LABEL}`,
  connected: `Connected to ${HOST_LABEL}`,
  reconnecting: `Reconnecting to ${HOST_LABEL}`,
  failed: `Could not connect to ${HOST_LABEL}`,
  queued: `Waiting for another host to finish connecting, then ${HOST_LABEL}`,
}

/** Build one status payload the way the server's buildHostStatus() shapes it. */
function status(phase: Phase, extra: Partial<HostStatus> = {}): HostStatus {
  const idx = STEPS.findIndex(s => s.phase === phase)
  const steps = STEPS.map((s, i) => ({
    ...s,
    status: phase === 'connected' ? 'done' as const
      : idx < 0 ? 'todo' as const
      : i < idx ? 'done' as const : i === idx ? 'active' as const : 'todo' as const,
  }))
  return {
    host: HOST, label: HOST_LABEL, hostname: HOSTNAME, user: 'me',
    connected: phase === 'connected', phase, phaseLabel: PHASE_LABEL[phase], steps,
    note: phase === 'install-runtime' || phase === 'upload'
      ? `First connect installs the session daemon on ${HOST_LABEL}; this can take a minute or two.` : undefined,
    phaseElapsedMs: 12_000, connectElapsedMs: 40_000, at: Date.now(), ...extra,
  }
}

const input = (page: Page) => page.locator('.sps-search-input')
const list = (page: Page) => page.locator('.sps-path-list')
const hostTab = (page: Page) => page.locator('.sps-host-tab', { hasText: HOST_LABEL })

/** Capture the app's own socket so server frames can be injected verbatim. */
async function captureWs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.WebSocket
    window.WebSocket = class HostStatusTestWebSocket extends original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const socketUrl = new URL(String(url), window.location.href)
        const holder = window as unknown as { __hsWs?: WebSocket }
        if (socketUrl.pathname === '/ws' && !holder.__hsWs) holder.__hsWs = this
      }
    } as typeof WebSocket
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try {
        ;(window.WebSocket as unknown as Record<string, unknown>)[key] =
          (original as unknown as Record<string, unknown>)[key]
      } catch {
        // Read-only browser constants already exist on the subclass.
      }
    }
  })
}

async function waitForWs(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const ws = (window as unknown as { __hsWs?: WebSocket }).__hsWs
    return !!ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 20_000 })
}

/** Dispatch one `host:status` server frame on the captured socket. */
async function pushStatus(page: Page, s: HostStatus): Promise<void> {
  await page.evaluate((data) => {
    const ws = (window as unknown as { __hsWs?: WebSocket }).__hsWs
    if (!ws) throw new Error('the app WebSocket was never captured')
    ws.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: 'host:status', data, seq: Date.now() }),
    }))
  }, s)
}

/** The host list the picker reads (history untouched) + the status hydrate answer. */
async function injectHost(page: Page, initial: HostStatus): Promise<{ statusCalls: () => number }> {
  let statusCalls = 0
  await page.route('**/api/sessions/working-dirs', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { dirs: unknown[]; hosts?: unknown[] }
    body.hosts = [...(body.hosts ?? []), { alias: HOST, label: HOST_LABEL }]
    await route.fulfill({ response: res, json: body })
  })
  await page.route('**/api/hosts/status', async (route) => {
    statusCalls++
    await route.fulfill({ json: { hosts: [initial] } })
  })
  return { statusCalls: () => statusCalls }
}

/**
 * The remote host's list-dirs answers: `pending` while `mode.value` is
 * 'pending', folders once it is 'dirs', a hostError once it is 'error'. `~/`
 * (the picker's open-time prewarm) never counts as one of the user's requests.
 */
function scriptRemoteListDirs(page: Page, mode: { value: 'pending' | 'dirs' | 'error'; dirs: string[] }) {
  const calls: URL[] = []
  /** Wall-clock of each user-driven call, to measure the fallback poll's cadence. */
  const times: number[] = []
  const handler = async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('host') !== HOST) return route.fallback()
    const prefix = url.searchParams.get('prefix') ?? '/'
    const parent = prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1)
    if (prefix === '~/') {
      return route.fulfill({ json: { dirs: [], parent, exists: true, pending: { phase: 'ssh', label: 'prewarm', elapsedMs: 0 } } })
    }
    calls.push(url)
    times.push(Date.now())
    if (mode.value === 'pending') {
      return route.fulfill({ json: { dirs: [], parent, exists: true, pending: { phase: 'install-runtime', label: PHASE_LABEL['install-runtime'], elapsedMs: 1200 } } })
    }
    if (mode.value === 'error') {
      return route.fulfill({ json: { dirs: [], parent, exists: true, hostError: { message: 'Permission denied (publickey).', kind: 'auth', hint: 'Check the key.' } } })
    }
    return route.fulfill({ json: { dirs: mode.dirs.map(d => parent + d), parent, exists: true } })
  }
  return { calls, times, install: () => page.route('**/api/sessions/list-dirs**', handler) }
}

async function openPicker(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await waitForWs(page)
  const panel = await openDraft(page)
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()
  await expect(page.locator('.session-path-selector')).toBeVisible()
  if ((await input(page).inputValue()) !== '') {
    await input(page).press('Escape')
    await expect(input(page)).toHaveValue('')
  }
}

test.beforeEach(async ({ page }) => {
  await captureWs(page)
})

test('host tab carries a live status dot: connecting → connected → failed, each from one WS frame', async ({ page }) => {
  await injectHost(page, status('ssh'))
  await openPicker(page)

  const dot = hostTab(page).locator('.sps-host-dot')
  await expect(dot).toHaveClass(/sps-host-dot-connecting/)
  await expect(dot).toHaveAttribute('title', PHASE_LABEL.ssh)
  // Local and All never get a dot: there is nothing to connect to.
  await expect(page.locator('.sps-host-tab', { hasText: 'Local' }).locator('.sps-host-dot')).toHaveCount(0)
  await expect(page.locator('.sps-host-tab', { hasText: 'All' }).locator('.sps-host-dot')).toHaveCount(0)

  await pushStatus(page, status('connected'))
  await expect(dot).toHaveClass(/sps-host-dot-connected/)

  await pushStatus(page, status('failed', { error: 'Permission denied (publickey).', kind: 'auth', hint: 'Check the key.', retryInMs: 58_000 }))
  await expect(dot).toHaveClass(/sps-host-dot-failed/)
  await expect(dot).toHaveAttribute('title', /Permission denied/)
})

test('the app reads host status once at load, so the picker opens with the dots already known', async ({ page }) => {
  const hydrate = await injectHost(page, status('connected'))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await waitForWs(page)
  // One read shortly after the first paint, before anyone opened anything.
  await expect.poll(() => hydrate.statusCalls(), { timeout: 8_000 }).toBe(1)

  const panel = await openDraft(page)
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()
  await expect(page.locator('.session-path-selector')).toBeVisible()
  const dot = hostTab(page).locator('.sps-host-dot')
  await expect(dot).toHaveClass(/sps-host-dot-connected/)
  // Opening the picker did not have to ask again (the answer was fresh).
  expect(hydrate.statusCalls()).toBe(1)
})

test('connecting row shows the step list; a WS frame advances it with no extra list-dirs request; connected fetches at once', async ({ page }) => {
  await injectHost(page, status('install-runtime'))
  const mode = { value: 'pending' as 'pending' | 'dirs' | 'error', dirs: ['projects', 'scratch'] }
  const remote = scriptRemoteListDirs(page, mode)
  await remote.install()
  await openPicker(page)
  await hostTab(page).click()
  await input(page).fill('/home/me/')

  const row = list(page).locator('.sps-host-connecting')
  await expect(row).toBeVisible()
  const steps = row.locator('.sps-host-step')
  await expect(steps).toHaveCount(7)
  await expect(row.locator('.sps-host-step[data-step="ssh"]')).toHaveAttribute('data-status', 'done')
  await expect(row.locator('.sps-host-step[data-step="probe"]')).toHaveAttribute('data-status', 'done')
  await expect(row.locator('.sps-host-step[data-step="install-runtime"]')).toHaveAttribute('data-status', 'active')
  await expect(row.locator('.sps-host-step[data-step="upload"]')).toHaveAttribute('data-status', 'todo')
  await expect(row.locator('.sps-host-step-note')).toContainText('First connect installs the session daemon')
  await expect(row.locator('.sps-host-step-total')).toContainText(/Connecting for/)
  // Full contrast, never the old whisper.
  expect(await row.evaluate(el => parseFloat(getComputedStyle(el).opacity))).toBe(1)
  // One wait, one indicator.
  await expect(list(page).locator('.sps-empty', { hasText: 'Loading paths' })).toHaveCount(0)

  // Two more phases arrive over the socket. The row follows each frame on its
  // own: the step has moved by the time the frame is dispatched, and the
  // request count is read at that same instant, so a poll cannot be what moved it.
  let callsBefore = remote.calls.length
  await pushStatus(page, status('start', { note: undefined }))
  await expect(row.locator('.sps-host-step[data-step="start"]')).toHaveAttribute('data-status', 'active')
  expect(remote.calls.length).toBe(callsBefore)
  await expect(row.locator('.sps-host-step[data-step="install-runtime"]')).toHaveAttribute('data-status', 'done')
  await expect(row.locator('.sps-host-step-note')).toHaveCount(0)
  callsBefore = remote.calls.length
  await pushStatus(page, status('handshake', { note: undefined }))
  await expect(row.locator('.sps-host-step[data-step="handshake"]')).toHaveAttribute('data-status', 'active')
  expect(remote.calls.length).toBe(callsBefore)

  // Connected: the listing is fetched immediately, not on the next poll tick.
  mode.value = 'dirs'
  const t0 = Date.now()
  await pushStatus(page, status('connected'))
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'projects' })).toBeVisible({ timeout: 2500 })
  expect(Date.now() - t0).toBeLessThan(2500)
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'scratch' })).toBeVisible()
  await expect(row).toHaveCount(0)
  await expect(hostTab(page).locator('.sps-host-dot')).toHaveClass(/sps-host-dot-connected/)

  // While the socket was pushing, the fallback poll stayed lazy: every request
  // between the first answer and the connected-triggered fetch waited 4s+.
  const polls = remote.times.slice(0, -1)
  for (let i = 1; i < polls.length; i++) expect(polls[i] - polls[i - 1]).toBeGreaterThanOrEqual(4000)
})

test('failure arrives over WS: the card names the cause and the fix; Retry reconnects and the card clears', async ({ page }) => {
  await injectHost(page, status('tunnel'))
  const mode = { value: 'pending' as 'pending' | 'dirs' | 'error', dirs: ['work'] }
  const remote = scriptRemoteListDirs(page, mode)
  await remote.install()
  const retries: string[] = []
  await page.route('**/api/sessions/host-retry', async (route) => {
    retries.push(route.request().postDataJSON()?.host)
    await route.fulfill({ json: { ok: true } })
  })
  await openPicker(page)
  await hostTab(page).click()
  await input(page).fill('/home/me/')
  await expect(list(page).locator('.sps-host-connecting')).toBeVisible()

  await pushStatus(page, status('failed', {
    error: 'Permission denied (publickey).', kind: 'auth',
    hint: `Walnut runs \`ssh me@${HOSTNAME}\` without a password prompt. Make sure that command works from this machine on its own, then retry.`,
    retryInMs: 58_000,
  }))
  const down = list(page).locator('.sps-host-down')
  await expect(down).toBeVisible()
  await expect(down).toContainText('Could not connect to Big dev box')
  await expect(down).toContainText('Permission denied (publickey).')
  await expect(down).toContainText(`ssh me@${HOSTNAME}`)
  await expect(list(page).locator('.sps-host-connecting')).toHaveCount(0)
  expect(await down.evaluate(el => parseFloat(getComputedStyle(el).opacity))).toBe(1)

  // Retry: the server is told, and the row goes back to showing progress as
  // the reconnect walks the steps again; the folders land when it is done.
  await down.getByRole('button', { name: 'Retry' }).click()
  await expect.poll(() => retries).toEqual([HOST])
  // What the server really pushes next: the cleared failure (idle, no cause),
  // then the warmup taking the host (queued), then the first real step. None of
  // the first two may bring the failure card back or read as a new failure.
  await pushStatus(page, status('idle', { phaseElapsedMs: 0, connectElapsedMs: 0, warmup: 'failed' }))
  await pushStatus(page, status('queued', { phaseElapsedMs: 0, connectElapsedMs: 0, warmup: 'queued' }))
  await expect(list(page).locator('.sps-host-connecting')).toContainText('Waiting for another host')
  await expect(list(page).locator('.sps-host-connecting .sps-host-step[data-status="active"]')).toHaveCount(0)
  await expect(down).toHaveCount(0)
  await pushStatus(page, status('ssh', { warmup: 'running' }))
  await expect(list(page).locator('.sps-host-connecting .sps-host-step[data-step="ssh"]')).toHaveAttribute('data-status', 'active')
  await expect(down).toHaveCount(0)
  mode.value = 'dirs'
  await pushStatus(page, status('connected'))
  await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'work' })).toBeVisible()
  await expect(list(page).locator('.sps-host-connecting')).toHaveCount(0)
})

test('typing while the host connects keeps the step list; no flash back to the generic spinner', async ({ page }) => {
  await injectHost(page, status('upload'))
  const mode = { value: 'pending' as 'pending' | 'dirs' | 'error', dirs: [] }
  const remote = scriptRemoteListDirs(page, mode)
  await remote.install()
  await openPicker(page)
  await hostTab(page).click()
  await input(page).fill('/home/')
  const row = list(page).locator('.sps-host-connecting')
  await expect(row.locator('.sps-host-step[data-step="upload"]')).toHaveAttribute('data-status', 'active')

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
  await expect(row.locator('.sps-host-step[data-step="upload"]')).toHaveAttribute('data-status', 'active')
  expect(await page.evaluate(() => (window as unknown as { __flash: number }).__flash)).toBe(0)
})

test('an out-of-order (older) status frame never moves the UI backwards', async ({ page }) => {
  await injectHost(page, status('probe'))
  await openPicker(page)
  const dot = hostTab(page).locator('.sps-host-dot')
  await expect(dot).toHaveClass(/sps-host-dot-connecting/)

  const newer = status('connected', { at: Date.now() + 5_000 })
  await pushStatus(page, newer)
  await expect(dot).toHaveClass(/sps-host-dot-connected/)
  // A frame stamped before the one we hold (a late retransmit) is ignored.
  await pushStatus(page, status('ssh', { at: newer.at - 60_000 }))
  await page.waitForTimeout(300)
  await expect(dot).toHaveClass(/sps-host-dot-connected/)
})

test('Settings › Remote hosts: a live status line per host and a Connect now button', async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json() as { config?: Record<string, unknown> } & Record<string, unknown>
    const cfg = (body.config ?? body) as { hosts?: Record<string, unknown> }
    cfg.hosts = { ...(cfg.hosts ?? {}), [HOST]: { hostname: HOSTNAME, user: 'me', label: HOST_LABEL, enabled: true } }
    await route.fulfill({ response: res, json: body })
  })
  // The status read is held until the test releases it: Settings mounts behind a
  // queue of other requests in real life, and that gap must read as "checking",
  // never as a verdict.
  let releaseStatus: () => void = () => {}
  const statusHeld = new Promise<void>((resolve) => { releaseStatus = resolve })
  await page.route('**/api/hosts/status', async (route) => {
    await statusHeld
    await route.fulfill({ json: { hosts: [status('idle', { phaseElapsedMs: 0, connectElapsedMs: 0 })] } })
  })
  const connects: string[] = []
  await page.route(`**/api/hosts/${HOST}/connect`, async (route) => {
    connects.push(route.request().method())
    // The route answers after the warmup has QUEUED the host (no ssh yet).
    await route.fulfill({ json: { ok: true, status: status('queued', { phaseElapsedMs: 0, connectElapsedMs: 0, warmup: 'queued' }) } })
  })

  // Straight to Settings (page.goto only to load): the home page's own polling
  // keeps `networkidle` busy for so long that the held read would hit the
  // client's 15s request timeout before the row is even on screen.
  await page.goto('/settings')
  await page.getByTestId('settings-nav-remote-hosts').click()
  await waitForWs(page)

  const row = page.locator('.rh-status', { hasText: HOST_LABEL }).or(page.locator(`.rh-status[data-host="${HOST}"]`)).first()
  await expect(row).toBeVisible()
  await expect(row).toContainText('Checking status')
  await expect(row.locator('.status-dot')).toHaveClass(/status-dot-testing/)
  await expect(row).not.toContainText('unknown')
  releaseStatus()
  await expect(row).toContainText(/Not connected/)
  await row.locator('.rh-connect-btn').click()
  await expect.poll(() => connects).toEqual(['POST'])
  // The button's answer seeds the store: the wait shows without any WS frame
  // (never "Not connected" or a bare failure), and the button stays out of the
  // way while a connect is queued or running.
  await expect(row).toContainText('Waiting for another host')
  await expect(row.locator('.status-dot')).toHaveClass(/status-dot-testing/)
  await expect(row.locator('.rh-connect-btn')).toBeDisabled()

  await pushStatus(page, status('ssh'))
  await expect(row).toContainText(PHASE_LABEL.ssh)
  await pushStatus(page, status('install-runtime'))
  await expect(row).toContainText('Installing the session daemon runtime')
  await pushStatus(page, status('connected'))
  await expect(row).toContainText('Connected')
  await expect(row.locator('.status-dot')).toHaveClass(/status-dot-connected/)

  await pushStatus(page, status('failed', { error: 'Connection timed out', kind: 'network', hint: 'Check the VPN.' }))
  await expect(row).toContainText('Connection timed out')
  await expect(row.locator('.status-dot')).toHaveClass(/status-dot-error/)
  await expect(row.locator('.rh-connect-btn')).toHaveText('Retry')
  await expect(row.locator('.rh-connect-btn')).toBeEnabled()
  // Settings re-reads /api/config on its own clock; WebKit tears the page down
  // fast enough that one such read is still in flight when the test ends.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('System pane: a connecting host shows its current step instead of a bare Disconnected', async ({ page }) => {
  await page.route('**/api/system/health', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { daemons?: unknown[] }
    body.daemons = [...(body.daemons ?? []), { host: HOST, label: HOST_LABEL, connected: false, bridgeConnected: null }]
    await route.fulfill({ response: res, json: body })
  })
  await injectHost(page, status('start'))

  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
  await waitForWs(page)
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'System' }).click()

  const row = panel.locator('.notification-detail-row', { hasText: HOST_LABEL })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toContainText('Starting the session daemon')
  await expect(row).not.toContainText('Disconnected')
  await pushStatus(page, status('handshake'))
  await expect(row).toContainText('Handshaking with the session daemon')
})
