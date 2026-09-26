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
  cert_expired: "Your SSH certificate expired; run your organisation's login command, then Retry.",
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
    await this.page.route('**/api/hosts/status', (route) => route.fulfill({ json: { hosts: [...this.map.values()] } }))
    await this.page.route('**/api/hosts/*/connect', async (route: Route) => {
      const host = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3])
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

/** This machine's Claude Code as /api/system/health reports it (ready by default). */
export async function routeHealth(page: Page, local?: 'outdated'): Promise<void> {
  await page.route('**/api/system/health', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as Record<string, unknown>
    body.hasReadyProvider = true
    body.claudeCliAvailable = true
    body.localClaude = local === 'outdated' ? {
      checkedAt: now(),
      claude: { found: true, version: '2.1.258', minVersion: '2.1.280', versionOk: false, kind: 'native', auth: 'ok', installMethod: 'other' },
      problems: [{ kind: 'claude_outdated', message: 'Claude Code on this computer is 2.1.258, but the default model needs 2.1.280 or newer.', commands: ['claude update'] }],
    } : { checkedAt: now(), claude: { found: true, version: '2.1.281', versionOk: true, kind: 'native', auth: 'ok' }, problems: [] }
    await route.fulfill({ response: res, json: body })
  })
}

export async function loadHome(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await page.waitForFunction(() => {
    const ws = (window as unknown as { __hpWs?: WebSocket }).__hpWs
    return !!ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 20_000 })
}

export async function setup(page: Page, hosts: HS[], local?: 'outdated', opts: { serverPrefs?: boolean } = {}): Promise<Hosts> {
  await page.addInitScript((key) => { if (!sessionStorage.getItem('hp-keep')) localStorage.removeItem(key) }, DISMISS_KEY)
  // Dismissals sync to the fixture server (ui-prefs); one test's must not hide another's rows.
  // Both ways: the boot read never sees another test's dismissals, and this
  // test's own never reach the server (a later serverPrefs test reads them).
  if (!opts.serverPrefs) {
    await page.route('**/api/ui-prefs', async (route) => {
      const req = route.request()
      if (req.method() === 'PUT') {
        const body = (req.postDataJSON() ?? {}) as { prefs?: Record<string, unknown> }
        if (!body.prefs || !(DISMISS_KEY in body.prefs)) return route.fallback()
        delete body.prefs[DISMISS_KEY]
        if (Object.keys(body.prefs).length === 0) return route.fulfill({ json: { ok: true } })
        return route.fallback({ postData: JSON.stringify(body) })
      }
      if (req.method() !== 'GET') return route.fallback()
      const res = await route.fetch()
      const body = await res.json() as { prefs?: Record<string, unknown> }
      if (body.prefs) delete body.prefs[DISMISS_KEY]
      await route.fulfill({ response: res, json: body })
    })
  }
  const h = new Hosts(page)
  await h.install(hosts)
  await routeHealth(page, local)
  await loadHome(page)
  return h
}

export const banner = (page: Page): Locator => page.locator('.main-page-chat [data-testid="attention-banner"]')
export const rows = (page: Page): Locator => banner(page).locator('li.hpb-row')
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

