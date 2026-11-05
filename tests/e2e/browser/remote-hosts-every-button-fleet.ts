/**
 * The fixture fleet of remote-hosts-every-button.spec.ts (served by PaneRoutes in
 * remote-hosts-every-button-helpers.ts): the Overview's cards, the host profiles and Walnut on a
 * host. One fleet for every part of the page.
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */

const GB = 1024 ** 3
const DAY = 86_400_000
const MIN = 60_000

function days(covered = 30) {
  const now = Date.now()
  return Array.from({ length: 30 }, (_, i) => {
    const minutes = i >= 30 - covered ? 1440 : 0
    return { start: now - (30 - i) * DAY, minutes, up: minutes, linked: minutes, cpu: 0.3, mem: 0.5, sessionsMax: 3 }
  })
}

export function card(over: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now()
  return {
    host: 'x', label: 'X', local: false, line: '', checkedAt: now,
    connection: { kind: 'ssh-tunnel', connected: true, phase: 'connected', phaseLabel: 'Connected', since: now - 20 * MIN, rttMs: 38, error: null },
    system: { os: 'Ubuntu 24.04', arch: 'x64', cpus: 16, memBytes: 64 * GB, diskFreeBytes: 200 * GB, kind: 'public-cloud-vm', probedAt: null },
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
 * The one fleet every part of the page shows (2026-11-04 review: the Overview and the Hosts list
 * showed different hosts): this computer and Alpha box live (Alpha box's daemon does not start
 * after a reboot: Set up), Beta box and the joined gpu-box not connected, the same as the
 * server's host fixture and the host network say.
 */
export function fleet(alphaFixed: boolean): Record<string, unknown>[] {
  const now = Date.now()
  const alphaDaemon = alphaFixed
    ? { version: 'walnut-daemon-0123456789ab', startedAt: now - DAY, startup: 'service', startsAfterReboot: true, runtime: 'bun', vitals: true, bootStart: { mode: 'boot', backend: 'systemd-user', reason: null, checkedAt: now, setupRunning: false, setupError: null, next: null }, reboot: 'starts by itself after a reboot (as a systemd user service)' }
    : { version: 'walnut-daemon-0123456789ab', startedAt: now - DAY, startup: 'on-demand', startsAfterReboot: false, runtime: 'bun', vitals: true, bootStart: { mode: 'none', backend: null, reason: 'nothing on it starts the daemon at boot', checkedAt: now, setupRunning: false, setupError: null, next: 'install' }, reboot: 'does not start by itself after a reboot: nothing on it starts the daemon at boot' }
  const away = (host: string, label: string, phaseLabel: string, error: string) => card({
    host, label,
    connection: { kind: 'ssh-tunnel', connected: false, phase: 'failed', phaseLabel, since: null, rttMs: null, error },
    now: null, history: null, sessions: { running: null }, spend: null, readAt: now - 5 * MIN,
    placement: { score: null, busy: null, reasons: [], weight: null, longRunning: { ok: false, reasons: ['Walnut is not connected to it now.'] } },
  })
  return [
    card({
      host: '__local__', label: 'This computer', local: true,
      connection: { kind: 'local', connected: true, phase: 'connected', phaseLabel: 'Running on this Mac', since: null, rttMs: 1, error: null },
      system: { os: 'macOS 15.1', arch: 'arm64', cpus: 10, memBytes: 32 * GB, diskFreeBytes: 200 * GB, kind: 'laptop', probedAt: null },
    }),
    card({ host: 'devbox', label: 'Alpha box', daemon: alphaDaemon }),
    away('downbox', 'Beta box', 'Connecting to Beta box timed out', 'ssh: connect to host beta.example.com port 22: Connection timed out'),
    away('gpu-box', 'gpu-box', 'Not connected', 'no link to it'),
  ]
}

/** A host's profile; `probedAt` is when its probe ran (two hours ago, unless a Probe again just ran). */
export function profile(host: string, cpus: number, extra: Record<string, unknown> = {}, probedAt = Date.now() - 2 * 3_600_000): Record<string, unknown> {
  const at = new Date(probedAt).toISOString()
  return {
    host, kind: 'dev-box', kindReasons: ['It answered over SSH with a home folder'], kindSetByUser: false, userNote: '',
    probed: { os: { prettyName: 'Ubuntu 24.04' }, arch: 'x64', cpus, memBytes: 64 * GB, diskFreeBytes: 200 * GB, tools: { git: '2.43.0', docker: null }, probedAt: at },
    observed: { repoPaths: { api: { path: '/home/dev/work/api', at } } },
    ...extra,
  }
}

export function hostServer(hostKey: string, label: string, tunnel: Record<string, unknown>, notice?: string): Record<string, unknown> {
  return {
    hostKey, label,
    settings: { enabled: true, program: 'replica', expose: { enabled: true, provider: 'tunnel', options: {} }, copies: {} },
    view: { hostKey, enabled: true, phase: 'running', since: Date.now() - 3_600_000, build: '0.6.20', ...(notice ? { notice } : {}), server: { route: { kind: 'leader' }, expose: { enabled: true, provider: 'tunnel', providerTitle: 'Test tunnel', since: Date.now() - MIN, ...tunnel } } },
  }
}
