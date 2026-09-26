/**
 * Shared helpers for the host-problems specs (banner + draft surfaces).
 * Host statuses are shaped like the server's buildHostStatus frames; the
 * hydrate is answered through page.route and each change is a `host:status`
 * frame dispatched on the app's own captured socket. The aliases here are
 * reset on the fixture server first (resetServerHostFixture) so a real server
 * push can never overwrite a client-side frame mid-assertion.
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { expect, type APIRequestContext, type Page, type Locator, type Route } from '@playwright/test'

export const SHOTS = '/tmp/walnut-host-problems-slice/p3'
export const DISMISS_KEY = 'open-walnut-host-banner-dismissed'

export interface Readiness {
  checkedAt: number
  problems: Array<{ kind: string; message: string; commands: string[] }>
  claude?: { version?: string; minVersion?: string; installMethod?: string; found?: boolean }
}
export interface HS {
  host: string; label: string; hostname: string; user?: string
  connected: boolean; phase: string; phaseLabel: string; steps: unknown[]
  phaseElapsedMs: number; connectElapsedMs: number; at: number; serverNow?: number
  error?: string; kind?: string; hint?: string; retryable?: boolean; retryAt?: number
  lastError?: string; lastKind?: string; lastHint?: string; reconnectSince?: number
  attemptStartedAt?: number; connectedAt?: number; readiness?: Readiness; removed?: true
}

export const now = () => Date.now()
export const base = (host: string, label: string): HS => ({
  host, label, hostname: `${host}.example.com`, user: 'alice', connected: false, phase: 'idle',
  phaseLabel: `Connecting to ${label}`, steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: now(), serverNow: now(),
})
export const connected = (host: string, label: string, readiness?: Partial<Readiness>, connectedAgoMs = 60_000): HS => ({
  ...base(host, label), connected: true, phase: 'connected', phaseLabel: `Connected to ${label}`,
  connectedAt: now() - connectedAgoMs,
  readiness: { checkedAt: now() - 1000, problems: [], claude: { version: '2.1.281', minVersion: '2.1.280', found: true }, ...readiness },
})
export const outdated = (host: string, label: string, minVersion = '2.1.280', version = '2.1.220'): HS => connected(host, label, {
  problems: [{ kind: 'claude_outdated', message: `Claude Code on ${label} is ${version}, but the default model needs ${minVersion} or newer.`, commands: [] }],
  claude: { version, minVersion, installMethod: 'other', found: true },
})
export const signedOut = (host: string, label: string): HS => connected(host, label, {
  problems: [{ kind: 'claude_not_logged_in', message: `Claude Code on ${label} is not signed in. Run \`claude\` once there and sign in.`,
    commands: ['ssh -t alice@sign.example.com claude', 'ssh alice@sign.example.com claude /login'] }],
  claude: { version: '2.1.281', minVersion: '2.1.280', found: true },
})
export const HINTS: Record<string, string> = {
  unreachable: 'Check the network or VPN, then Retry.',
  timeout: 'The host did not answer in time. Check the VPN, then Retry.',
  auth: 'SSH refused the key. Check the key for this host in Remote Hosts, then Retry.',
  cert_expired: "Your SSH certificate expired; run your organization's login command, then Retry.",
  proxy: 'A proxy closed the connection. Check the proxy settings, then Retry.',
}
export const failed = (host: string, label: string, kind: string, extra: Partial<HS> = {}): HS => ({
  ...base(host, label), phase: 'failed', phaseLabel: `Could not connect to ${label}`, kind,
  error: `ssh: connect to host ${host}.example.com port 22: ${kind}`, hint: HINTS[kind] ?? 'Retry.',
  retryable: kind === 'unreachable' || kind === 'timeout', attemptStartedAt: now() - 5000, ...extra,
})
export const connecting = (host: string, label: string): HS => ({
  ...base(host, label), phase: 'ssh', phaseLabel: `Opening an SSH connection to ${label}`, attemptStartedAt: now() - 2000,
  steps: [{ phase: 'ssh', label: 'SSH', status: 'active' }],
})
export const reconnecting = (host: string, label: string, sinceAgoMs: number, lastKind?: string): HS => ({
  ...base(host, label), phase: 'reconnecting', phaseLabel: `Reconnecting to ${label}`, reconnectSince: now() - sinceAgoMs,
  ...(lastKind ? { lastKind, lastError: `ssh: ${lastKind}`, lastHint: HINTS[lastKind] ?? '' } : {}),
})
/** A frame is always fresh: the store drops a frame older than the one it holds. */
export const fresh = (s: HS): HS => ({ ...s, at: now(), serverNow: now() })

let lastAt = 0
/** Strictly increasing frame times (two frames in one millisecond must not tie). */
export function stamp(s: HS): HS {
  lastAt = Math.max(lastAt + 1, now())
  return { ...s, at: lastAt, serverNow: lastAt }
}

/** The routed host server: the hydrate answers the current map; push() changes it and sends a frame. */
export class Hosts {
  readonly map = new Map<string, HS>()
  connectAnswer: (host: string) => HS | null = () => null
  checkAnswer: (host: string) => HS | null = () => null
  connectDelayMs = 0
  /** Hold the /api/hosts/status hydrate this long (a slow first answer). */
  hydrateDelayMs = 0
  /** POST /api/hosts/<alias>/connect requests answered so far, per alias. */
  readonly connects = new Map<string, number>()
  /** The routed local health (set by setup()). */
  health?: HealthControl
  constructor(private page: Page) {}

  async install(initial: HS[]): Promise<void> {
    for (const s of initial) this.map.set(s.host, stamp(s))
    await this.page.addInitScript(() => {
      const original = window.WebSocket
      window.WebSocket = class HostProblemsWs extends original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          const u = new URL(String(url), window.location.href)
          const w = window as unknown as { __hpWs?: WebSocket }
          if (u.pathname === '/ws' && !w.__hpWs) w.__hpWs = this
        }
      } as typeof WebSocket
    })
    await this.page.route('**/api/hosts/status', async (route) => {
      if (this.hydrateDelayMs) await new Promise((r) => setTimeout(r, this.hydrateDelayMs))
      await route.fulfill({ json: { hosts: [...this.map.values()] } })
    })
    await this.page.route('**/api/hosts/*/connect', async (route: Route) => {
      const host = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3])
      this.connects.set(host, (this.connects.get(host) ?? 0) + 1)
      if (this.connectDelayMs) await new Promise((r) => setTimeout(r, this.connectDelayMs))
      const next = this.connectAnswer(host) ?? this.map.get(host)!
      const s = stamp(next)
      this.map.set(host, s)
      await route.fulfill({ json: { ok: true, status: s } })
    })
    await this.page.route('**/api/hosts/*/check', async (route: Route) => {
      const host = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3])
      await new Promise((r) => setTimeout(r, 400))
      const next = this.checkAnswer(host) ?? this.map.get(host)!
      const s = stamp(next)
      this.map.set(host, s)
      await route.fulfill({ json: { ok: true, status: s } })
    })
  }

  /** One host:status frame on the app's socket (and the hydrate answer from now on). */
  async push(s: HS): Promise<void> {
    const frame = stamp(s)
    if (s.removed) this.map.delete(s.host)
    else this.map.set(s.host, frame)
    await this.page.evaluate((data) => {
      const ws = (window as unknown as { __hpWs?: WebSocket }).__hpWs
      if (!ws) throw new Error('the app socket was never captured')
      ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: 'host:status', data, seq: Date.now() }) }))
    }, frame)
  }
}

/** This machine's Claude Code states a routed /api/system/health can report. */
export type LocalState = 'ready' | 'outdated' | 'sign-in'

export function localClaudeBody(state: LocalState): Record<string, unknown> {
  if (state === 'outdated') return {
    checkedAt: now(),
    claude: { found: true, version: '2.1.258', minVersion: '2.1.280', versionOk: false, kind: 'native', auth: 'ok', installMethod: 'other' },
    problems: [{ kind: 'claude_outdated', message: 'Claude Code on this computer is 2.1.258, but the default model needs 2.1.280 or newer.', commands: ['claude update'] }],
  }
  if (state === 'sign-in') return {
    checkedAt: now(),
    claude: { found: true, version: '2.1.281', minVersion: '2.1.280', versionOk: true, kind: 'native', auth: 'not-logged-in', installMethod: 'native' },
    problems: [{ kind: 'claude_not_logged_in', message: 'Claude Code on this computer is not signed in. Run `claude` in a terminal and sign in.', commands: ['claude'] }],
  }
  return { checkedAt: now(), claude: { found: true, version: '2.1.281', minVersion: '2.1.280', versionOk: true, kind: 'native', auth: 'ok' }, problems: [] }
}

/** The routed health: flip the local state mid-test; count the sign-in re-checks the page sends. */
export interface HealthControl {
  state: LocalState
  /** POST /api/system/local-claude/check requests seen so far. */
  rechecks: number
  /** Change the local state and push it as a system:health frame (the server's own push shape). */
  set(state: LocalState): Promise<void>
}

/**
 * This machine's Claude Code as /api/system/health reports it (ready by default).
 * The real server's own system:health pushes are dropped on the page, so the
 * routed state holds; the re-check route answers the current state and pushes it.
 */
export async function routeHealth(page: Page, local: LocalState = 'ready'): Promise<HealthControl> {
  let baseBody: Record<string, unknown> = {}
  const bodyFor = (state: LocalState) => ({ ...baseBody, hasReadyProvider: true, claudeCliAvailable: true, localClaude: localClaudeBody(state) })
  const pushHealth = (state: LocalState) => page.evaluate((data) => {
    const w = window as unknown as { __hpHealthWs?: WebSocket }
    if (!w.__hpHealthWs) return
    w.__hpHealthWs.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: 'system:health', data, seq: Date.now(), __hp: true }) }))
  }, bodyFor(state)).catch(() => {})
  const control: HealthControl = {
    state: local,
    rechecks: 0,
    async set(state) { control.state = state; await pushHealth(state) },
  }
  await page.addInitScript(() => {
    const original = window.WebSocket
    window.WebSocket = class HostProblemsHealthWs extends original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const u = new URL(String(url), window.location.href)
        const w = window as unknown as { __hpHealthWs?: WebSocket }
        if (u.pathname !== '/ws') return
        if (!w.__hpHealthWs) w.__hpHealthWs = this
        // Registered before the app's own listener: a real system:health push never reaches it.
        this.addEventListener('message', (e: MessageEvent) => {
          if (typeof e.data !== 'string' || !e.data.includes('"system:health"')) return
          try {
            const msg = JSON.parse(e.data) as { name?: string; __hp?: boolean }
            if (msg.name === 'system:health' && !msg.__hp) e.stopImmediatePropagation()
          } catch { /* not JSON: leave it */ }
        })
      }
    } as typeof WebSocket
  })
  await page.route('**/api/system/health', async (route) => {
    try {
      const res = await route.fetch()
      baseBody = await res.json() as Record<string, unknown>
      await route.fulfill({ response: res, json: bodyFor(control.state) })
    } catch { /* the page closed mid-request (the test ended): nothing to answer */ }
  })
  await page.route('**/api/system/local-claude/check', async (route) => {
    control.rechecks += 1
    await route.fulfill({ json: { localClaude: localClaudeBody(control.state) } })
    await pushHealth(control.state)
  })
  return control
}

export const TODO_VISIBLE_KEY = 'open-walnut-home-todo-visible'
export const CHAT_VISIBLE_KEY = 'open-walnut-home-chat-visible'

/** Home is up: the task panel when it is shown, else the rail's bell (a hidden task panel is collapsed). */
export async function waitForHome(page: Page): Promise<void> {
  const todoShown = await page.evaluate((k) => localStorage.getItem(k) !== 'false', TODO_VISIBLE_KEY)
  if (todoShown) await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  else await expect(page.locator('.sidebar-notification-btn')).toBeVisible({ timeout: 30_000 })
}

/** The slot-only layout: the task panel hidden, the Ask Walnut slot shown (call before the first load). */
export async function slotLayout(page: Page): Promise<void> {
  await page.addInitScript(([t, c]) => { localStorage.setItem(t, 'false'); localStorage.setItem(c, 'true') }, [TODO_VISIBLE_KEY, CHAT_VISIBLE_KEY])
}

/** No page mount at all: the task panel and the slot both hidden (call before the first load). */
export async function bareLayout(page: Page): Promise<void> {
  await page.addInitScript(([t, c]) => { localStorage.setItem(t, 'false'); localStorage.setItem(c, 'false') }, [TODO_VISIBLE_KEY, CHAT_VISIBLE_KEY])
}

/**
 * ui-prefs never leave this page (a dismissal or a panel flag must not reach
 * the shared fixture server and change the next test), and the boot read is
 * the first-boot shape. Install it in every context.
 */
export async function isolatePrefs(page: Page): Promise<void> {
  await page.route('**/api/ui-prefs', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: route.request().method() === 'GET' ? '{"prefs":{}}' : '{"ok":true}',
  }))
}

export async function loadHome(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await waitForHome(page)
  await page.waitForFunction(() => {
    const ws = (window as unknown as { __hpWs?: WebSocket }).__hpWs
    return !!ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 20_000 })
}

export async function setup(page: Page, hosts: HS[], local?: LocalState, opts: { serverPrefs?: boolean } = {}): Promise<Hosts> {
  await page.addInitScript((key) => { if (!sessionStorage.getItem('hp-keep')) localStorage.removeItem(key) }, DISMISS_KEY)
  // Dismissals and panel flags sync to the fixture server (ui-prefs); one
  // test's must not change another's, so none leaves the page. serverPrefs
  // keeps the real sync for the test that pins it (C92).
  if (!opts.serverPrefs) await isolatePrefs(page)
  const h = new Hosts(page)
  await h.install(hosts)
  h.health = await routeHealth(page, local)
  await loadHome(page)
  return h
}

/** THE card on Home: the task panel mount (the default layout shows the task panel). */
export const banner = (page: Page): Locator => page.locator('[data-testid="attention-banner"][data-mount="tasks"]')
/** Every attention banner on the page, wherever it is mounted. */
export const anyBanner = (page: Page): Locator => page.locator('[data-testid="attention-banner"]')
/** Host rows only (an undo row in a dismissed row's place carries no data-host). */
export const rows = (page: Page): Locator => banner(page).locator('li.hpb-row[data-host]')
export const row = (page: Page, host: string): Locator => banner(page).locator(`li.hpb-row[data-host="${host}"]`)
export const storedKeys = (page: Page): Promise<string[]> =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]') as string[], DISMISS_KEY)

// ── The server's host fixture (POST /api/test/host-fixture, test-host-fixture.ts) ──

/** One fixture action on the server; fails the test when the server refuses it. */
export async function hostFixture(request: APIRequestContext, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await request.post('/api/test/host-fixture', { data: body })
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  expect(res.ok(), `host fixture ${String(body.action)}: ${String(json.error ?? res.status())}`).toBe(true)
  return json
}

/**
 * Drop every server fixture host, so a real frame from the server can never
 * overwrite a routed one. A server without the fixture route (404) has none.
 */
export async function resetServerHostFixture(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/test/host-fixture', { data: { action: 'reset' } })
  if (res.status() !== 404) expect(res.ok(), `host fixture reset: ${res.status()}`).toBe(true)
}


/** The rail's task panel toggle (the toolbar has its own Hide task panel button). */
export const railTodoToggle = (page: Page): Locator => page.locator('.sidebar-home-panels .app-task-panel-toggle')

/** Hide the task panel with a real click on the rail toggle. */
export async function hideTaskPanel(page: Page): Promise<void> {
  await railTodoToggle(page).click()
  await expect(railTodoToggle(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.main-page-todo')).toHaveClass(/collapsed/)
}

/** Show the task panel again with a real click on the rail toggle. */
export async function showTaskPanel(page: Page): Promise<void> {
  await railTodoToggle(page).click()
  await expect(railTodoToggle(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.todo-panel')).toBeVisible()
}
