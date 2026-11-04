/**
 * Routes and the button sweep for remote-hosts-every-button.spec.ts.
 *
 * The SSH hosts are the SERVER's host fixture (real status frames, real connect and check
 * routes). Everything else the pane reads is answered here, so no click reaches a real host,
 * starts an agent or deletes anything: the config (the fixture's hosts plus one host found in
 * ~/.ssh/config; saves are kept here, never written), the Overview, the host network, Walnut
 * on a host, the exec grants, the secrets, the removals to confirm, the host profiles and voice
 * status. Where the real server answers in steps (a read of the hosts runs a while, a host that
 * connects shows as live in the next read), these routes answer the same way. Each routed request is recorded in `calls`; a gated route waits for its release so
 * a busy label can be seen.
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test'
import { fixtureFile, hostFixture, isolatePrefs, loadApp, loadFixture, openRemoteHosts, openRemoteHostsMore } from './host-problems-fixture-helpers'
import { connected, stamp } from './host-problems-helpers'

export interface Call { method: string; path: string; body: unknown }
interface Grant { id: string; taskId: string; taskTitle: string | null; host: string; grantedAt: number; via: string; runs: number; lastRunAt: number; lastCommand: string }

const GB = 1024 ** 3
const DAY = 86_400_000
const MIN = 60_000
/** How long a read of the hosts runs (the real one waits on each host's daemon). */
const READ_MS = 1_200

/**
 * Every name a button may carry: the sweep writes `<host>`, `<task>` or `<secret>` for each, so
 * one key covers the same button on every row. `fixture-remote` is the test server's own host.
 */
export const NAMES: Record<string, string> = Object.fromEntries([
  ...['This computer', 'Alpha box', 'Beta box', 'Far box', 'Big remote host', 'fixture-remote', 'lab-mac', 'gpu-box', 'this Mac', 'This Mac', '__local__', 'devbox', 'downbox', 'farbox'].map((n) => [n, '<host>']),
  ...['Nightly build', 'Lint job'].map((n) => [n, '<task>']),
  ...['github-read', 'deploy-key'].map((n) => [n, '<secret>']),
])
/** Buttons known by their class (their name is a command, a state, or an icon). */
const STABLE_CLASSES = ['setup-copy-btn', 'hc-other', 'rh-connect-btn', 'rh-show-again-btn', 'hft-details', 'mic-btn', 'mic-chevron-badge', 'mic-error-retry', 'mic-error-dismiss', 'secret-toggle']
/** A button whose label is its state: the key it is registered under. */
const STATE_ALIASES: Record<string, string> = {
  'Hosts/button:Done': 'Hosts/button:Edit',
  'Hosts/button:Probe now': 'Hosts/button:Probe again',
  'Hosts/button:Probing...': 'Hosts/button:Probe again',
}
/** Keys that differ only by a part the same check walks through (one copy switch per kind). */
const FOLDS: Array<[RegExp, string]> = [[/^(.*)\/switch#host-server-copy-<host>-[a-z_]+$/, '$1/switch#host-server-copy-<host>-<kind>']]

/**
 * Every visible button and link on the Remote Hosts pane (and its header's buttons in the sticky
 * bar once the pane scrolled), as stable keys `<group>/<role><id>`: the group is the heading of
 * the settings group it sits in (or Header, Overview), the id its data-testid, else a known
 * class, else its accessible name, with each host's name written `<host>`.
 */
export async function paneKeys(page: Page): Promise<string[]> {
  const raw = await page.evaluate(({ names, classes }) => {
    const root = document.getElementById('remote-hosts')
    if (!root) throw new Error('#remote-hosts is not on the page')
    // Scrolled down, the pane's header buttons move to the sticky bar above it (SettingsSection PaneHeader).
    const roots = [root, ...document.querySelectorAll<HTMLElement>('.settings-pane-stickybar.is-compact .settings-pane-stickybar-actions')]
    const sorted = Object.keys(names).sort((a, b) => b.length - a.length)
    const norm = (s: string) => {
      let out = s.replace(/\s+/g, ' ').trim()
      for (const n of sorted) out = out.split(n).join(names[n])
      return out.replace(/\bHost \d+\b/g, '<host>')
    }
    const sel = 'button, a[href], select, summary, input[type="checkbox"], input[type="radio"], [role="button"], [role="link"], [role="switch"], [role="radio"], [role="checkbox"], [role="menuitem"], [role="option"], [role="tab"]'
    const groupOf = (el: HTMLElement) => {
      if (!root.contains(el) || el.closest('.settings-pane-header, .settings-card-head')) return 'Header'
      if (el.closest('[data-testid="host-fleet"]')) return 'Overview'
      const title = el.closest('.settings-group-block')?.querySelector(':scope > .settings-group-heading .settings-group-title')?.textContent?.trim()
      return title ?? 'Pane'
    }
    const out: string[] = []
    for (const el of roots.flatMap((r) => [...r.querySelectorAll<HTMLElement>(sel)])) {
      // A native box drawn by its label (a checkbox) is measured by the label; nothing inert or hidden counts.
      if (el.closest('[inert], [aria-hidden="true"]')) continue
      const box = el.tagName === 'INPUT' ? el.closest('label') ?? el : el
      const r = box.getBoundingClientRect()
      const cs = getComputedStyle(box)
      if ((r.width === 0 && r.height === 0) || cs.visibility === 'hidden' || cs.display === 'none') continue
      const native = el.tagName === 'A' ? 'link' : el.tagName === 'SELECT' ? 'combobox' : el.tagName === 'INPUT' ? (el as HTMLInputElement).type : 'button'
      const role = `${groupOf(el)}/${el.getAttribute('role') || native}`
      const tid = el.getAttribute('data-testid')
      const cls = classes.find((c) => el.classList.contains(c))
      const relay = el.getAttribute('data-relay')
      out.push(tid ? `${role}#${norm(tid)}` : relay ? `${role}[relay=${relay}]` : cls ? `${role}.${cls}` : `${role}:${norm(el.getAttribute('aria-label') || el.textContent || '')}`)
    }
    return out
  }, { names: NAMES, classes: STABLE_CLASSES })
  return [...new Set(raw.map((k) => FOLDS.reduce((acc, [re, to]) => acc.replace(re, to), STATE_ALIASES[k] ?? k)))]
}

// ── Fixtures ──

function days(covered = 30) {
  const now = Date.now()
  return Array.from({ length: 30 }, (_, i) => {
    const minutes = i >= 30 - covered ? 1440 : 0
    return { start: now - (30 - i) * DAY, minutes, up: minutes, linked: minutes, cpu: 0.3, mem: 0.5, sessionsMax: 3 }
  })
}

function card(over: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now()
  return {
    host: 'x', label: 'X', local: false, line: '', checkedAt: now,
    connection: { kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: now - 20 * MIN, rttMs: 38, error: null },
    system: { os: 'Ubuntu 24.04', arch: 'x64', cpus: 16, memBytes: 64 * GB, diskFreeBytes: 400 * GB, kind: 'public-cloud-vm', probedAt: null },
    now: { cpus: 16, cpuUtil: 0.12, load: [1.5, 1.2, 1], memTotalBytes: 64 * GB, memAvailBytes: 40 * GB, uptimeSec: 9 * 86400, bootedAt: now - 9 * DAY, linked: true, gpuUtil: null, disk: { totalBytes: 300 * GB, freeBytes: 200 * GB }, at: now, stale: false },
    history: { coverageFrom: now - 30 * DAY, bucketMinutes: 1440, buckets: days(), windows: [{ days: 7, minutes: 7 * 1440, up: 7 * 1440, linked: 7 * 1440, online: 1, linkedShare: 1, drops: 0, downs: 0 }], outages: [], boots: [], daemonStarts: 1 },
    sessions: { running: 2 },
    spend: { last30dUsd: 120.5, from: '2026-10-05', basis: 'list-price' },
    server: null,
    daemon: { version: 'walnut-daemon-0123456789ab', startedAt: now - DAY, startup: 'service', startsAfterReboot: true, runtime: 'bun', vitals: true },
    placement: { score: 12, busy: false, reasons: [], weight: 50, longRunning: { ok: true, reasons: [] } },
    readAt: now, refreshing: false, readError: null, readFailedAt: null,
    ...over,
  }
}

/**
 * This computer and Alpha box live (Alpha box's daemon does not start after a reboot: Set up),
 * Far box away (Retry) until a connect brings it up.
 */
function fleet(alphaFixed: boolean, farUp: boolean): Record<string, unknown>[] {
  const now = Date.now()
  const alphaDaemon = alphaFixed
    ? { version: 'walnut-daemon-0123456789ab', startedAt: now - DAY, startup: 'service', startsAfterReboot: true, runtime: 'bun', vitals: true, bootStart: { mode: 'boot', backend: 'systemd-user', reason: null, checkedAt: now, setupRunning: false, setupError: null, next: null }, reboot: 'starts by itself after a reboot (as a systemd user service)' }
    : { version: 'walnut-daemon-0123456789ab', startedAt: now - DAY, startup: 'on-demand', startsAfterReboot: false, runtime: 'bun', vitals: true, bootStart: { mode: 'none', backend: null, reason: 'nothing on it starts the daemon at boot', checkedAt: now, setupRunning: false, setupError: null, next: 'install' }, reboot: 'does not start by itself after a reboot: nothing on it starts the daemon at boot' }
  return [
    card({
      host: '__local__', label: 'This computer', local: true,
      connection: { kind: 'local', connected: true, phase: 'connected', phaseLabel: 'Running on this Mac', since: null, rttMs: 1, error: null },
      system: { os: 'macOS 15.1', arch: 'arm64', cpus: 10, memBytes: 32 * GB, diskFreeBytes: 300 * GB, kind: 'laptop', probedAt: null },
    }),
    card({ host: 'devbox', label: 'Alpha box', daemon: alphaDaemon }),
    farUp ? card({ host: 'farbox', label: 'Far box' }) : card({
      host: 'farbox', label: 'Far box',
      connection: { kind: 'ssh-tunnel', connected: false, phase: 'failed', phaseLabel: 'Could not reach Far box', since: null, rttMs: null, error: 'ssh: connection timed out' },
      now: null, history: null, sessions: { running: null }, readAt: now - 5 * MIN,
      placement: { score: null, busy: null, reasons: [], weight: null, longRunning: { ok: false, reasons: ['Walnut is not connected to it now.'] } },
    }),
  ]
}

function profile(host: string, cpus: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString()
  return {
    host, kind: 'dev-box', kindReasons: ['It answered over SSH with a home folder'], kindSetByUser: false, userNote: '',
    probed: { os: { prettyName: 'Ubuntu 24.04' }, arch: 'x64', cpus, memBytes: 64 * GB, diskFreeBytes: 200 * GB, tools: { git: '2.43.0', docker: null }, probedAt: at },
    observed: { repoPaths: { api: { path: '/home/dev/work/api', at } } },
    ...extra,
  }
}

function hostServer(hostKey: string, label: string, tunnel: Record<string, unknown>, notice?: string): Record<string, unknown> {
  return {
    hostKey, label,
    settings: { enabled: true, program: 'replica', expose: { enabled: true, provider: 'tunnel', options: {} }, copies: {} },
    view: { hostKey, enabled: true, phase: 'running', since: Date.now() - 3_600_000, build: '0.6.20', ...(notice ? { notice } : {}), server: { route: { kind: 'leader' }, expose: { enabled: true, provider: 'tunnel', providerTitle: 'Test tunnel', since: Date.now() - MIN, ...tunnel } } },
  }
}

export const ALPHA_URL = 'https://alpha-tunnel.example.dev'
export const WINDOWS_APP = 'https://downloads.example.com/walnut-windows.exe'
/** Invite n's link and commands: each new link differs, so a second one shows as new. */
export const netLink = (n: number) => `https://wn.example.com/join/INV-${n}`
export const netCommand = (n: number) => `curl -fsSL ${netLink(n)} | sh`
export const netWindows = (n: number) => `irm ${netLink(n)}/ps | iex`

/** The routed side of the pane; `calls` holds every request it answered. */
export class PaneRoutes {
  readonly calls: Call[] = []
  /** Laid over GET /api/config: null until the editor saves, then what it saved. */
  hosts: Record<string, Record<string, unknown>> | null = null
  limits: Record<string, number> = { devbox: 3 }
  readonly found: Record<string, Record<string, unknown>> = { 'lab-mac': { hostname: '10.0.0.9', user: 'sam', discovered: true, connect: 'ask', enabled: false } }
  alphaFixed = false
  /** Far box answered a connect: the next read shows it live, as the server's cached read does. */
  farUp = false
  /** A read of the hosts runs until then (the server answers `refreshing: true` meanwhile). */
  private refreshUntil = 0
  /** The join links read back as expired (the 10 minutes ran out). */
  expireInvites = false
  relay: 'own' | 'public' | 'none' = 'public'
  invites = 0
  readonly servers = [
    hostServer('devbox', 'Alpha box', { state: 'connected', url: ALPHA_URL }, 'It runs an older build than this computer.'),
    hostServer('downbox', 'Beta box', { state: 'retrying', lastError: 'The tunnel stopped', nextRetryAt: Date.now() + 60_000 }),
  ]
  grants: Grant[] = [{ id: 'g-1', taskId: 'task-build', taskTitle: 'Nightly build', host: 'devbox', grantedAt: Date.now() - DAY, via: 'letter', runs: 3, lastRunAt: Date.now() - 3_600_000, lastCommand: 'make test' }]
  denied: Array<{ taskId: string; taskTitle: string | null; host: string; askedAt: number; answeredAt: number | null }> = [{ taskId: 'task-lint', taskTitle: 'Lint job', host: 'downbox', askedAt: Date.now() - 2 * DAY, answeredAt: Date.now() - 2 * DAY }]
  closed: string[] = []
  secrets: Record<string, unknown>[] = [{ name: 'github-read', description: 'GitHub, read only', hosts: ['devbox'], env: 'GH_TOKEN', sessions: true, version: 1, createdAt: Date.now() - DAY, updatedAt: Date.now() - DAY, copies: { devbox: { version: 1, at: Date.now() - DAY } } }]
  readonly profiles = new Map<string, Record<string, unknown>>()
  private gates = new Map<string, { promise: Promise<void>; release: () => void }>()

  constructor(private readonly page: Page) {}

  /** The next request through gate `name` waits until the returned release is called. */
  gate(name: string): () => void {
    let release!: () => void
    const promise = new Promise<void>((r) => { release = r })
    this.gates.set(name, { promise, release })
    return release
  }

  private async pass(name: string): Promise<void> {
    const g = this.gates.get(name)
    if (!g) return
    await g.promise
    this.gates.delete(name)
  }

  private record(route: Route): Call {
    const req = route.request()
    let body: unknown = null
    try { body = req.postDataJSON() } catch { body = req.postData() }
    const call = { method: req.method(), path: new URL(req.url()).pathname, body }
    this.calls.push(call)
    return call
  }

  callsTo(method: string, path: string | RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)))
  }

  /** Waits for the n-th (1-based) call matching, and answers it. */
  async nth(method: string, path: string | RegExp, n: number): Promise<Call> {
    await expect.poll(() => this.callsTo(method, path).length, { message: `${method} ${String(path)} #${n}`, timeout: 15_000 }).toBeGreaterThanOrEqual(n)
    return this.callsTo(method, path)[n - 1]
  }

  async install(): Promise<void> {
    const page = this.page
    await page.route('**/api/stt/status', (route) => route.fulfill({ json: { engine: null, available: false } }))
    // Typed drafts (the Add limit row) stay in this page: the fixture server is shared by every spec.
    await page.route((url) => url.pathname.startsWith('/api/drafts'), (route) => route.fulfill({ json: route.request().method() === 'GET' ? { drafts: {} } : { ok: true } }))
    await page.route((url) => url.pathname === '/api/config', async (route) => {
      if (route.request().method() === 'PUT') {
        const call = this.record(route)
        const body = call.body as { hosts?: Record<string, Record<string, unknown>>; session_limits?: Record<string, number> }
        if (body.hosts) this.hosts = body.hosts
        if (body.session_limits) this.limits = body.session_limits
        return route.fulfill({ json: { ok: true } })
      }
      const res = await route.fetch()
      const body = await res.json() as { config: Record<string, unknown> }
      const real = (body.config.hosts ?? {}) as Record<string, unknown>
      const hosts = this.hosts ?? { ...real, ...this.found }
      return route.fulfill({ response: res, json: { ...body, config: { ...body.config, hosts, session_limits: this.limits } } })
    })
    await page.route('**/api/hosts/*/found-answer', async (route) => {
      const call = this.record(route)
      const host = call.path.split('/')[3]
      const answer = (call.body as { answer: string }).answer
      const patch = { connect: answer, enabled: answer === 'yes' }
      this.found[host] = { ...this.found[host], ...patch }
      if (this.hosts?.[host]) this.hosts[host] = { ...this.hosts[host], ...patch }
      return route.fulfill({ json: { ok: true, host, answer } })
    })
    // Hosts the fixture does not know: a machine on the host network, and the Overview's away host.
    await page.route(/\/api\/hosts\/(gpu-box|farbox)\/connect$/, async (route) => {
      const call = this.record(route)
      const host = call.path.split('/')[3]
      await this.pass(`connect:${host}`)
      if (host === 'farbox') this.farUp = true
      return route.fulfill({ json: { ok: true, status: stamp(connected(host, host === 'farbox' ? 'Far box' : host)) } })
    })
    await this.installFleet()
    await this.installNet()
    await this.installGroups()
  }

  private async installFleet(): Promise<void> {
    const page = this.page
    await page.route((url) => url.pathname === '/api/v1/hosts', (route) => {
      const refreshing = Date.now() < this.refreshUntil
      const hosts = fleet(this.alphaFixed, this.farUp).map((h) => ({ ...h, refreshing }))
      return route.fulfill({ json: { hosts, checkedAt: Date.now(), refreshing } })
    })
    await page.route('**/api/v1/hosts/refresh', (route) => {
      const body = (this.record(route).body ?? {}) as { hosts?: string[] }
      this.refreshUntil = Date.now() + READ_MS
      return route.fulfill({ status: 202, json: { started: body.hosts ?? [], refreshing: body.hosts ?? [] } })
    })
    await page.route('**/api/v1/hosts/*/boot-start', async (route) => {
      this.record(route)
      await this.pass('boot')
      this.alphaFixed = true
      return route.fulfill({ json: { host: fleet(true, this.farUp)[1] } })
    })
    await page.route('**/api/v1/hosts/*/profile', async (route) => {
      const host = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[4])
      const cur = this.profiles.get(host) ?? profile(host, 16)
      if (route.request().method() === 'GET') return route.fulfill({ json: { profile: cur, summary: '' } })
      const body = this.record(route).body as { kind?: string | null; refresh?: boolean; user_note?: string }
      let next = { ...cur }
      if (body.refresh) next = { ...profile(host, 32), kind: cur.kind, kindSetByUser: cur.kindSetByUser }
      if ('kind' in body) next = { ...next, kind: body.kind ?? 'dev-box', kindSetByUser: body.kind !== null }
      if (typeof body.user_note === 'string') next = { ...next, userNote: body.user_note }
      this.profiles.set(host, next)
      return route.fulfill({ json: { profile: next } })
    })
  }

  private async installNet(): Promise<void> {
    const page = this.page
    // Not connected (no host status for it), so no link either: the real server says both at once.
    let machines = [{ host: 'gpu-box', endpoint: 'e'.repeat(64), enabled: true, platform: 'linux-x64', addedAt: Date.now() - DAY, path: 'none' }]
    const invite = (id: string) => {
      const n = Number(id.split('-')[1])
      return { id, link: netLink(n), command: netCommand(n), windowsCommand: netWindows(n), windowsApp: WINDOWS_APP, expiresAt: Date.now() + 10 * MIN, state: this.expireInvites ? 'expired' : 'waiting' }
    }
    await page.route('**/api/hosts/net', (route) => route.fulfill({
      json: { enabled: true, macId: 'a'.repeat(64), companion: false, relay: this.relay, relays: [], syncedAt: Date.now(), error: null, machines },
    }))
    await page.route('**/api/hosts/net/invites', (route) => { this.record(route); this.invites++; return route.fulfill({ status: 201, json: invite(`ni-${this.invites}`) }) })
    await page.route('**/api/hosts/net/invites/*', (route) => route.fulfill({ json: invite(new URL(route.request().url()).pathname.split('/').pop()!) }))
    await page.route('**/api/hosts/net/machines/*', (route) => {
      const host = decodeURIComponent(this.record(route).path.split('/').pop()!)
      machines = machines.filter((m) => m.host !== host)
      return route.fulfill({ json: { removed: host } })
    })
    await page.route('**/api/hosts/net/relay', (route) => {
      this.relay = (this.record(route).body as { relay: 'own' | 'public' | 'none' }).relay
      return route.fulfill({ json: { ok: true } })
    })
  }

  private async installGroups(): Promise<void> {
    const page = this.page
    await page.route((url) => url.pathname.startsWith('/api/host-servers'), async (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ json: { hosts: this.servers, providers: [{ id: 'tunnel', title: 'Test tunnel', owner: 'test', options: [] }] } })
      }
      const call = this.record(route)
      await this.pass('host-server')
      const key = decodeURIComponent(call.path.split('/')[3])
      type Entry = { settings: { enabled: boolean; expose: Record<string, unknown>; copies: Record<string, boolean> }; view: { server: { expose: Record<string, unknown> } } & Record<string, unknown> }
      const entry = this.servers.find((s) => s.hostKey === key) as Entry | undefined
      const body = (call.body ?? {}) as { enabled?: boolean; expose?: Record<string, unknown>; copies?: Record<string, boolean> }
      if (entry && call.method === 'PUT') {
        if (typeof body.enabled === 'boolean') entry.settings.enabled = body.enabled
        if (body.expose) entry.settings.expose = { ...entry.settings.expose, ...body.expose }
        if (body.copies) entry.settings.copies = { ...entry.settings.copies, ...body.copies }
      }
      // Try again starts the new build; the tunnel's Retry starts the tunnel again (as the server does).
      if (entry && call.path.endsWith('/expose/retry')) entry.view.server.expose = { ...entry.view.server.expose, state: 'starting', lastError: undefined, nextRetryAt: undefined }
      else if (entry && call.path.endsWith('/retry')) entry.view = { ...entry.view, phase: 'starting', message: 'Starting the new build...', notice: undefined }
      return route.fulfill({ json: { host: entry ?? null } })
    })
    await page.route((url) => url.pathname.startsWith('/api/v1/host-exec/'), (route) => {
      const method = route.request().method()
      if (method === 'GET') return route.fulfill({ json: { grants: this.grants, denied: this.denied, closedHosts: this.closed } })
      const call = this.record(route)
      if (method === 'DELETE') this.grants = this.grants.filter((g) => g.id !== call.path.split('/').pop())
      if (method === 'POST') {
        const { task_id, host } = call.body as { task_id: string; host: string }
        const d = this.denied.find((x) => x.taskId === task_id && x.host === host)
        this.denied = this.denied.filter((x) => x !== d)
        this.grants = [...this.grants, { id: `g-${this.grants.length + 2}`, taskId: task_id, taskTitle: d?.taskTitle ?? null, host, grantedAt: Date.now(), via: 'settings', runs: 0, lastRunAt: Date.now(), lastCommand: '' }]
      }
      if (method === 'PUT') {
        const host = decodeURIComponent(call.path.split('/').pop()!)
        const { closed } = call.body as { closed: boolean }
        this.closed = closed ? [...new Set([...this.closed, host])] : this.closed.filter((h) => h !== host)
        return route.fulfill({ json: { closedHosts: this.closed } })
      }
      return route.fulfill({ json: { ok: true } })
    })
    await page.route((url) => url.pathname.startsWith('/api/v1/secrets'), (route) => {
      const method = route.request().method()
      if (method === 'GET') return route.fulfill({ json: { active: true, secrets: this.secrets } })
      const call = this.record(route)
      const name = decodeURIComponent(call.path.split('/').pop()!)
      if (method === 'DELETE') this.secrets = this.secrets.filter((s) => s.name !== name)
      if (method === 'PUT' && !this.secrets.some((s) => s.name === name)) {
        const b = call.body as Record<string, unknown>
        this.secrets = [...this.secrets, { name, description: b.description, hosts: b.hosts, env: b.env ?? undefined, sessions: b.sessions, version: 1, createdAt: Date.now(), updatedAt: Date.now(), copies: {} }]
      }
      return route.fulfill({ json: { ok: true, pending: [] } })
    })
    let armed: Record<string, unknown> | null = null
    await page.route('**/api/replicas/status', (route) => route.fulfill({
      json: { ok: true, targets: [{ id: 'host:devbox', kind: 'host', label: 'Alpha box', kinds: [{ kind: 'notes', refusals: 2, needsConfirm: !armed, lastRefusal: { error: 'would remove 40 of 120 notes', at: Date.now() - 10 * MIN, entries: 80, keys: 'k80', local: 120, removing: 40 }, ...(armed ? { confirmArmed: armed } : {}) }] }] },
    }))
    await page.route('**/api/replicas/confirm-removal', (route) => {
      this.record(route)
      armed = { entries: 80, keys: 'k80', at: Date.now(), expiresAt: Date.now() + 10 * MIN }
      return route.fulfill({ json: { ok: true } })
    })
  }
}

// ── The pane, opened; and the checks every group uses ──

const SHOTS = process.env.PW_SHOTS_DIR || path.join(process.cwd(), 'test-results', 'rh-every-button-shots')

const FILE = fixtureFile({
  devbox: { label: 'Alpha box', hostname: 'alpha.example.com', phase: 'connected', claude: { found: false }, extraCommands: { claude_missing: ['npm install -g @anthropic-ai/claude-code'] } },
  downbox: { label: 'Beta box', hostname: 'beta.example.com', phase: 'failed', error: 'ssh: connect to host beta.example.com port 22: Connection timed out' },
})

export const isChromium = (page: Page) => page.context().browser()?.browserType().name() === 'chromium'

/** What the window shows right now (where a press landed). */
export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

/** A Copy that says Copied, and (where the engine lets a test read it) put exactly `text` there. */
export async function expectCopied(page: Page, button: Locator, text: string): Promise<void> {
  await button.click()
  await expect(button).toHaveText('Copied')
  if (isChromium(page)) expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text)
}

export async function expectOpensTab(page: Page, link: Locator, url: string): Promise<void> {
  await expect(link).toHaveAttribute('href', url)
  await expect(link).toHaveAttribute('target', '_blank')
  const popup = page.waitForEvent('popup')
  await link.click()
  const tab = await popup
  await expect.poll(() => tab.url()).toContain(new URL(url).host)
  await tab.close()
}

/** A switch flips on a click and back on a second one; `saved(on)` sees each write. */
export async function flip(sw: Locator, saved: (on: boolean) => Promise<void>): Promise<void> {
  const before = (await sw.getAttribute('aria-checked')) === 'true'
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', String(!before))
  await saved(!before)
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', String(before))
  await saved(before)
}

/** An inline confirm: armed by a press, put back by Escape, and nothing was sent. */
export async function armThenCancel(routes: PaneRoutes, button: Locator, label: string, confirm: string): Promise<void> {
  const calls = routes.calls.length
  await expect(button).toHaveText(label)
  await button.click()
  await expect(button).toHaveText(confirm)
  await expect(button).toHaveAttribute('data-armed', 'true')
  await button.press('Escape')
  // Well inside the 3 s auto-disarm (CONFIRM_ARM_MS): it is Escape that put it back.
  await expect(button).toHaveAttribute('data-armed', 'false', { timeout: 1_000 })
  await expect(button).toHaveText(label)
  expect(routes.calls.slice(calls).filter((c) => c.method !== 'GET')).toEqual([])
}

/** The fixture's hosts, every route, then Settings > Remote Hosts by clicks, with each group shown. */
export async function openFixturePane(page: Page, request: APIRequestContext): Promise<PaneRoutes> {
  await isolatePrefs(page)
  await loadFixture(request, FILE)
  await hostFixture(request, { action: 'check-slow', host: 'devbox', ms: 800 })
  const routes = new PaneRoutes(page)
  await routes.install()
  await page.context().route(/(downloads\.example\.com|alpha-tunnel\.example\.dev)/, (route) => route.fulfill({ contentType: 'text/html', body: '<title>stub</title>ok' }))
  // WebKit knows no clipboard permission (browser-spec-ratchets.test.ts).
  if (page.context().browser()?.browserType().name() === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  // Beta box was hidden from the home banner earlier: its row offers Show again.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('rheb-seeded')) return
    localStorage.setItem('open-walnut-host-banner-dismissed', JSON.stringify(['downbox|connect']))
    sessionStorage.setItem('rheb-seeded', '1')
  })
  await loadApp(page)
  await openPane(page)
  return routes
}

export async function openPane(page: Page): Promise<void> {
  await openRemoteHosts(page)
  await expect(page.locator('#rh-host-devbox')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[id="hf-card-devbox"]')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-host-alias="gpu-box"]')).toBeVisible({ timeout: 20_000 })
  for (const id of ['remote-hosts-list', 'replica-removals-host', 'remote-hosts-more']) {
    await expect(page.getByTestId(id)).toBeVisible({ timeout: 20_000 })
  }
}

/** Opens More settings (closed by default) and waits for its groups. */
export async function openMore(page: Page): Promise<void> {
  await openRemoteHostsMore(page)
  for (const id of ['host-network-relay', 'host-servers', 'host-exec-grants', 'fleet-secrets', 'rh-session-limits']) {
    await expect(page.getByTestId(id)).toBeVisible({ timeout: 20_000 })
  }
}
