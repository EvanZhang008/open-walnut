/**
 * A service set installed or refreshed straight into the host's one Walnut service
 * (service-set-provision.ts `serve`, the experiment macos_one_service): the install and the refresh
 * carry `--serve <home>` under the launcher, and one whose build did not come up as the service
 * (SERVE_FAILURE_CODES) is run once more with `--no-serve`, so the set never stays uninstalled or
 * behind for the service's sake and no mode the first try wrote is carried; when the plain one goes
 * through, the service was the cause and `onUnfit` says why (Walnut Health), with no step of a
 * person's. Any other failure (a cut upload, a busy daemon, a timeout, a lost answer) is the regular
 * failure: no second try, nothing blamed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const updates: Array<{ serve?: unknown }> = []
let updateFails: (opts: { serve?: unknown }) => Error | null = () => null

vi.mock('../../src/providers/daemon-service-update.js', async (orig) => {
  const real = await orig<typeof import('../../src/providers/daemon-service-update.js')>()
  return {
    ...real,
    withServiceExecutable: async (_s: unknown, _e: string, _io: unknown, fn: (x: string) => Promise<unknown>) => fn('/x/walnut'),
    updateRemoteDaemonService: async (_s: unknown, _e: string, _io: unknown, _scope: string, opts: { serve?: unknown; onServiceSet?: (s: string | null) => void }) => {
      updates.push({ serve: opts.serve })
      const err = updateFails(opts)
      if (err) throw err
      opts.onServiceSet?.(SET)
      return 'applied'
    },
  }
})

const { provisionServiceSet, provisionWith } = await import('../../src/providers/service-set-provision.js')

const WALNUT = '0123456789abcdef0123456789abcdef'
const SET = '0123456789abcdef'
const HOME = '/Users/u/.open-walnut'
const ask = { walnutId: WALNUT, home: HOME }
const EXE = '/x/walnut'
const SERVE_WORDS = ` --serve ${HOME}`

function host(installAnswer: (line: string) => string) {
  const lines: string[] = []
  return {
    lines,
    installs: () => lines.filter((l) => l.includes(' install ')),
    io: {
      run: async (c: string) => {
        lines.push(c)
        if (c.includes(' install ')) return installAnswer(c)
        if (c.includes(' uninstall ')) return `service set: ${SET}\n{"ok":true}`
        if (c.includes(' status')) return `service set: ${SET}\n{"installed":false}`
        if (c.includes('id -u')) return '/Users/u\n501\n'
        return ''
      },
    },
  }
}

function serve() {
  const onUnfit = vi.fn()
  return { serve: { serve: { home: HOME, on: true as const }, onUnfit }, onUnfit }
}

describe('a service set straight into the one Walnut service', () => {
  const launcherEnv = process.env.WALNUT_SERVICE_LAUNCHER
  beforeEach(() => { process.env.WALNUT_SERVICE_LAUNCHER = '1'; updates.length = 0; updateFails = () => null })
  afterEach(() => { if (launcherEnv === undefined) delete process.env.WALNUT_SERVICE_LAUNCHER; else process.env.WALNUT_SERVICE_LAUNCHER = launcherEnv })

  it('the first install carries --serve under the launcher; nothing is told', async () => {
    const h = host(() => `service set: ${SET}\n{"ok":true,"status":{"scope":"user"}}`)
    const s = serve()
    expect(await provisionWith(EXE, h.io, ask, undefined, s.serve)).toMatchObject({ set: SET, installed: true, ok: true })
    expect(h.installs()).toEqual([`${EXE} walnut daemon install --yes --executable ${EXE} --launcher${SERVE_WORDS} --walnut ${WALNUT} --walnut-home ${HOME} 2>/dev/null || true`])
    expect(s.onUnfit).not.toHaveBeenCalled()
  })

  it('an install that fails as the service is run once as the daemon: installed, and the reason told', async () => {
    const h = host((l) => l.includes('--serve')
      ? `service set: ${SET}\n{"ok":false,"failure":{"code":"bootProof","message":"the version did not serve as the Walnut service"}}`
      : `service set: ${SET}\n{"ok":true,"status":{"scope":"user"}}`)
    const s = serve()
    expect(await provisionWith(EXE, h.io, ask, undefined, s.serve)).toMatchObject({ set: SET, installed: true, ok: true })
    expect(h.installs().map((l) => (l.includes(' --no-serve ') ? 'no-serve' : l.includes(' --serve ') ? 'serve' : 'none'))).toEqual(['serve', 'no-serve'])
    expect(h.installs()[1]).toContain(` --no-serve ${HOME} `)
    expect(s.onUnfit).toHaveBeenCalledTimes(1)
    expect(s.onUnfit.mock.calls[0]![0]).toMatch(/did not serve as the Walnut service.*runs as the session helper/)
    // A service failure: kept past a leader restart (daemon-connection.ts markServeUnfit, on a Mac).
    expect(s.onUnfit.mock.calls[0]![1]).toEqual({ serviceFailed: true })
  })

  it('an install that fails for another reason (a handover, a timeout, no answer) is not tried again, and nothing is blamed', async () => {
    for (const answer of [`{"ok":false,"failure":{"code":"handoverPending","message":"retry install"}}`, `{"ok":false,"failure":{"code":"notReady","message":"timed out"}}`, '']) {
      const h = host(() => `service set: ${SET}\n${answer}`)
      const s = serve()
      expect(await provisionWith(EXE, h.io, ask, undefined, s.serve)).toMatchObject({ ok: false })
      expect(h.installs().every((l) => l.includes(' --serve '))).toBe(true)
      expect(s.onUnfit).not.toHaveBeenCalled()
    }
  })

  it('an install that fails either way says the install failed, and blames nothing on the service', async () => {
    const h = host((l) => (l.includes(' --serve ') ? `service set: ${SET}\n{"ok":false,"failure":{"code":"bootProof","message":"no launchd"}}` : `service set: ${SET}\n{"ok":false,"failure":{"message":"no launchd"}}`))
    const s = serve()
    const p = await provisionWith(EXE, h.io, ask, undefined, s.serve)
    expect(p).toMatchObject({ set: SET, installed: false, ok: false })
    expect(p.message).toMatch(/no launchd/)
    expect(s.onUnfit).not.toHaveBeenCalled()
  })

  it('without the service: today\'s install line, one try', async () => {
    const h = host(() => `service set: ${SET}\n{"ok":false,"failure":{"message":"no launchd"}}`)
    await provisionWith(EXE, h.io, ask)
    expect(h.installs()).toHaveLength(1)
    expect(h.installs()[0]).not.toContain('--serve')
  })

  describe('the refresh of a set an earlier build installed', () => {
    const installed = {
      run: async (c: string) => {
        if (c.includes('echo build:yes')) return 'build:no'
        if (c.includes(' status')) return `service set: ${SET}\n{"installed":true,"scope":"user"}`
        if (c.includes('id -u')) return '/Users/u\n501\n'
        return ''
      },
      chunk: async () => true,
    }
    const source = { binary: null } as never

    it('carries the service\'s words', async () => {
      const s = serve()
      expect(await provisionServiceSet(source, 'walnut-daemon-aaaaaaaaaaaa', installed as never, ask, { refresh: true, serve: s.serve })).toMatchObject({ ok: true, refreshed: true })
      expect(updates).toEqual([{ serve: { home: HOME, on: true } }])
      expect(s.onUnfit).not.toHaveBeenCalled()
    })

    it('one that fails as the service (its trial put the build back) is run once as the daemon, and the reason told', async () => {
      updateFails = (o) => ((o.serve as { on?: boolean } | undefined)?.on ? Object.assign(new Error('Managed daemon update failed: the new daemon did not stay'), { buildFailed: true, failureCode: 'launcherRolledBack' }) : null)
      const s = serve()
      expect(await provisionServiceSet(source, 'walnut-daemon-aaaaaaaaaaaa', installed as never, ask, { refresh: true, serve: s.serve })).toMatchObject({ ok: true, refreshed: true })
      expect(updates).toEqual([{ serve: { home: HOME, on: true } }, { serve: { home: HOME, on: false } }])
      expect(s.onUnfit.mock.calls[0]![0]).toMatch(/did not stay.*runs as the session helper/)
      expect(s.onUnfit.mock.calls[0]![1]).toEqual({ serviceFailed: true })
    })

    it('a cut upload changed nothing: a quiet retry later, no try as the daemon, nothing blamed', async () => {
      updateFails = () => Object.assign(new Error('Daemon update upload failed'), { name: 'DaemonUpdateStageError' })
      const s = serve()
      expect(await provisionServiceSet(source, 'walnut-daemon-aaaaaaaaaaaa', installed as never, ask, { refresh: true, serve: s.serve })).toMatchObject({ ok: false, retryLook: true, cut: true })
      expect(updates).toHaveLength(1)
      expect(s.onUnfit).not.toHaveBeenCalled()
    })

    it('one that fails for another reason (busy, out of disk) is the regular failure: no try as the daemon, nothing blamed', async () => {
      updateFails = () => Object.assign(new Error('the host is out of disk'), { failureCode: 'commandFailed' })
      const s = serve()
      expect(await provisionServiceSet(source, 'walnut-daemon-aaaaaaaaaaaa', installed as never, ask, { refresh: true, serve: s.serve })).toMatchObject({ ok: false, retryLook: true })
      expect(updates).toHaveLength(1)
      expect(s.onUnfit).not.toHaveBeenCalled()
    })

    it('one that fails as the service and then as the daemon is the regular failure, nothing blamed', async () => {
      updateFails = (o) => Object.assign(new Error('the host is out of disk'), { failureCode: (o.serve as { on?: boolean } | undefined)?.on ? 'bootProof' : 'commandFailed' })
      const s = serve()
      expect(await provisionServiceSet(source, 'walnut-daemon-aaaaaaaaaaaa', installed as never, ask, { refresh: true, serve: s.serve })).toMatchObject({ ok: false, retryLook: true })
      expect(updates).toHaveLength(2)
      expect(s.onUnfit).not.toHaveBeenCalled()
    })
  })
})
