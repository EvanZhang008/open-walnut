import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOT_CHECK_DELAY_MS, BOOT_RECHECK_MS, BootStartKeeper, PROBE_RETRY_MS, type BootStartKeeperIo } from '../../src/providers/remote-boot-start-keeper.js'

const VERSION = 'walnut-daemon-1234abcd'
const REMOTE_BIN = '/home/walnut/.local/share/open-walnut/daemon/versions/walnut-daemon-1234abcd/open-walnut-daemon'
const NOW = 1_800_000_000_000
const HOUR = 3_600_000

type Facts = Record<string, string>

const PLAIN: Facts = {
  platform: 'Linux', user: 'walnut', linger: 'no', user_manager: '0', user_unit: '0', system_unit: '0',
  boot_script: '0', crontab: 'none', cron: 'enabled cron.service', plist: '0',
}
const CRON_BOOT: Facts = { ...PLAIN, boot_script: '1', crontab: 'ok', cron_line: '1' }
const LOGIN_UNIT: Facts = { ...PLAIN, user_manager: '1', user_unit: '1', user_unit_enabled: 'enabled' }
const BLOCKED: Facts = { ...PLAIN, crontab: 'missing' }

const probeOutput = (facts: Facts): string =>
  `banner from an rc file\n${Object.entries(facts).map(([key, value]) => `${key}=${value}`).join('\n')}\nwalnut-boot-probe-done\n`

interface LabOptions {
  facts?: Facts
  /** The probe answer once an install answered ok. */
  after?: Facts
  install?: string | string[]
  status?: string
  off?: string | null
  hold?: (string | null)[]
  capable?: boolean
  remoteVersion?: string
  expected?: string | null
}

function lab(options: LabOptions = {}) {
  const calls: string[] = []
  const markers: string[] = []
  const installs = Array.isArray(options.install) ? [...options.install] : [options.install ?? '{"ok":true,"status":{"scope":"cron","startup":"boot"}}']
  const holds = [...(options.hold ?? [])]
  let installed = false
  const run = vi.fn(async (command: string) => {
    calls.push(command)
    if (command.includes('walnut-boot-probe-done')) return probeOutput(installed && options.after ? options.after : options.facts ?? PLAIN)
    if (command === `${REMOTE_BIN} --version 2>/dev/null || true`) return `${options.remoteVersion ?? VERSION}\n`
    if (command.startsWith(`${REMOTE_BIN} walnut daemon install --yes --executable ${REMOTE_BIN}`)) {
      const reply = installs.length > 1 ? installs.shift()! : installs[0]
      if (reply.includes('"ok":true')) installed = true
      return reply
    }
    if (command.startsWith(`${REMOTE_BIN} walnut daemon status`)) return options.status ?? '{"installed":false}'
    if (command.includes('boot-setup')) { markers.push(command); return '' }
    throw new Error(`unexpected command: ${command}`)
  })
  const chunk = vi.fn(async () => true)
  const reconnect = vi.fn()
  const off = vi.fn(async () => options.off ?? null)
  const hold = vi.fn(async () => holds.length ? holds.shift()! : null)
  const io: BootStartKeeperIo = {
    hostKey: 'devbox',
    run,
    chunk,
    connected: () => true,
    hold,
    off,
    expectedVersion: () => (options.expected === undefined ? VERSION : options.expected),
    localBinary: async () => '/nonexistent/local/walnut-daemon',
    remoteBinary: async () => REMOTE_BIN,
    hasCapability: (cap) => (options.capable ?? true) && cap === 'service-handover-v1',
    reconnect,
  }
  const keeper = new BootStartKeeper(io, () => NOW)
  const installCalls = () => calls.filter((command) => command.includes('walnut daemon install'))
  const probes = () => calls.filter((command) => command.includes('walnut-boot-probe-done')).length
  return { keeper, io, calls, markers, run, chunk, reconnect, off, hold, installCalls, probes }
}

let current: ReturnType<typeof lab> | null = null
function start(options: LabOptions = {}) {
  current = lab(options)
  return current
}

afterEach(() => {
  current?.keeper.stop()
  current = null
  vi.useRealTimers()
})

function expectNoUpload(l: ReturnType<typeof lab>) {
  expect(l.chunk).not.toHaveBeenCalled()
  expect(l.calls.some((command) => command.includes('mktemp'))).toBe(false)
}

describe('boot start keeper', () => {
  it('leaves a host that already starts at boot alone', async () => {
    const l = start({ facts: CRON_BOOT })
    await l.keeper.check()
    expect(l.keeper.state).toMatchObject({ mode: 'boot', backend: 'cron', installed: true, checkedAt: NOW, setup: { running: false, error: null } })
    expect(l.installCalls()).toEqual([])
    expect(l.off).not.toHaveBeenCalled()
    expectNoUpload(l)
  })

  it('never replaces a service config already on the host', async () => {
    const l = start({ facts: LOGIN_UNIT })
    await l.keeper.check()
    expect(l.keeper.state).toMatchObject({ mode: 'login', backend: 'systemd-user', installed: true, setup: null })
    expect(l.installCalls()).toEqual([])
    expect(l.off).not.toHaveBeenCalled()
    expect(l.markers).toEqual([])
  })

  it('shows why a host may not be set up from here and does nothing else', async () => {
    const l = start({ off: 'automatic host fixes are off for this host' })
    await l.keeper.check()
    expect(l.keeper.state?.setup).toMatchObject({ running: false, error: 'automatic host fixes are off for this host' })
    expect(l.installCalls()).toEqual([])
    expect(l.markers).toEqual([])
    expectNoUpload(l)
  })

  it('does not upload to a host that would refuse', async () => {
    const l = start({ facts: BLOCKED })
    await l.keeper.check()
    expect(l.keeper.state?.setup?.error).toContain('loginctl enable-linger walnut')
    expect(l.calls).toHaveLength(1)
    expectNoUpload(l)
  })

  it('waits for a daemon that can hand its sessions over', async () => {
    const l = start({ capable: false })
    await l.keeper.check()
    expect(l.keeper.state?.setup?.error).toContain('cannot hand its sessions to a service yet')
    expect(l.installCalls()).toEqual([])
  })

  it('says so when this Walnut has no daemon build for the host', async () => {
    const l = start({ expected: null })
    await l.keeper.check()
    expect(l.keeper.state?.setup?.error).toBe('this Walnut has no daemon binary for the host')
    expect(l.installCalls()).toEqual([])
  })

  it('does not retry a setup that failed recently', async () => {
    const l = start({ facts: { ...PLAIN, attempt: `v=${VERSION} at=${NOW - HOUR} result=failed` } })
    await l.keeper.check()
    expect(l.keeper.state?.setup?.error).toBe('the last setup attempt failed; Walnut tries again later')
    expect(l.installCalls()).toEqual([])
    expect(l.hold).not.toHaveBeenCalled()
  })

  it('waits while held and tries again two minutes later', async () => {
    vi.useFakeTimers()
    const l = start({ hold: ['a session turn is running'], after: CRON_BOOT })
    await l.keeper.check()
    expect(l.installCalls()).toEqual([])
    expect(l.probes()).toBe(1)

    await vi.advanceTimersByTimeAsync(2 * 60_000 - 1)
    expect(l.probes()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(l.reconnect).toHaveBeenCalledTimes(1))
    expect(l.installCalls()).toHaveLength(1)
    expect(l.hold).toHaveBeenCalledTimes(2)
  })

  it('sets a due host up with the binary already there, records it, and reconnects', async () => {
    const l = start({ after: CRON_BOOT })
    await l.keeper.check()

    expect(l.installCalls()).toEqual([`${REMOTE_BIN} walnut daemon install --yes --executable ${REMOTE_BIN} 2>/dev/null || true`])
    expect(l.markers).toHaveLength(1)
    expect(l.markers[0]).toContain(`v=${VERSION} at=${NOW} result=ok`)
    expect(l.reconnect).toHaveBeenCalledTimes(1)
    expect(l.keeper.state).toMatchObject({ mode: 'boot', backend: 'cron', setup: { running: false, error: null } })
    const lastProbe = l.calls.map((command) => command.includes('walnut-boot-probe-done')).lastIndexOf(true)
    expect(l.calls.indexOf(l.markers[0])).toBeLessThan(lastProbe)
    expectNoUpload(l)
  })

  it('sets up a host whose old attempt is past its retry window', async () => {
    const l = start({ facts: { ...PLAIN, attempt: `v=walnut-daemon-older at=${NOW - 7 * HOUR} result=failed` }, after: CRON_BOOT })
    await l.keeper.check()
    expect(l.installCalls()).toHaveLength(1)
  })

  it('records a failed setup and shows its words', async () => {
    const l = start({
      install: '{"ok":false,"failure":{"code":"noBootStart","message":"this account cannot start the daemon at boot without root","rollback":"nothing was changed"}}',
    })
    await l.keeper.check()

    expect(l.markers).toHaveLength(1)
    expect(l.markers[0]).toContain('result=failed')
    expect(l.reconnect).not.toHaveBeenCalled()
    expect(l.keeper.state?.mode).toBe('none')
    expect(l.keeper.state?.setup?.running).toBe(false)
    expect(l.keeper.state?.setup?.error).toMatch(/^Walnut could not set it up: this account cannot start the daemon at boot without root/)
  })

  it('probes again every few hours', async () => {
    vi.useFakeTimers()
    const l = start({ facts: CRON_BOOT })
    await l.keeper.check()
    await vi.advanceTimersByTimeAsync(BOOT_RECHECK_MS)
    await vi.waitFor(() => expect(l.probes()).toBe(2))
  })

  it('asks again soon after a probe that came back cut short', async () => {
    vi.useFakeTimers()
    const l = start({ facts: CRON_BOOT })
    l.run.mockImplementationOnce(async () => 'banner only, no sentinel\n')
    await l.keeper.check()
    expect(l.keeper.state).toBeNull()
    await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS)
    // The cut-short answer came from the stand-in, so the probe log holds only the retry.
    await vi.waitFor(() => expect(l.probes()).toBe(1))
    expect(l.keeper.state).toMatchObject({ mode: 'boot' })
  })

  it('keeps a host again after the pool disconnected and dialled the same connection', async () => {
    vi.useFakeTimers()
    const l = start({ facts: CRON_BOOT })
    l.keeper.schedule()
    l.keeper.stop()
    l.keeper.schedule()
    await vi.advanceTimersByTimeAsync(BOOT_CHECK_DELAY_MS)
    await vi.waitFor(() => expect(l.probes()).toBe(1))
  })

  it('does nothing once stopped', async () => {
    const l = start()
    l.keeper.stop()
    await l.keeper.check()
    expect(l.calls).toEqual([])
  })
})
