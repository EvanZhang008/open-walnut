/**
 * An own service set installed by an earlier build of this Walnut, then a leader update before the
 * move (service-set-provision.ts provisionServiceSet, refresh): the set takes this build by the
 * regular update, naming the Walnut, and the move's set lines then find it. Guard: after any leader
 * build change, the look leaves the set with the build setCliCommand runs, or the move never starts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updates: Array<{ expected: string; scope: string; opts: Record<string, unknown> }> = []
let updateNames: string | null = '0123456789abcdef'
let updateFails: Error | null = null
/** The builds in the set's install root on the fake host. */
const builds = new Set<string>()

vi.mock('../../src/providers/daemon-service-update.js', async (orig) => {
  const real = await orig<typeof import('../../src/providers/daemon-service-update.js')>()
  return {
    ...real,
    withServiceExecutable: async (_s: unknown, _e: string, _io: unknown, fn: (x: string) => Promise<unknown>) => fn('/x/walnut'),
    updateRemoteDaemonService: async (_s: unknown, expected: string, _io: unknown, scope: string, opts: Record<string, unknown> & { onServiceSet?: (s: string | null) => void }) => {
      updates.push({ expected, scope, opts })
      if (updateFails) throw updateFails
      builds.add(expected)
      opts.onServiceSet?.(updateNames)
      return 'applied'
    },
  }
})

const { provisionServiceSet, setCliCommand } = await import('../../src/providers/service-set-provision.js')

const SET = '0123456789abcdef'
const ask = { walnutId: '0123456789abcdef0123456789abcdef', home: '/home/u/.open-walnut' }
const source = { binary: null } as never

function io() {
  return {
    run: async (c: string) => {
      if (c.includes('echo build:yes')) return builds.has(/= (walnut-daemon-[0-9a-f]+) \]/.exec(c)![1]) ? 'build:yes' : 'build:no'
      if (c.includes(' status')) return `service set: ${SET}\n{"installed":true,"scope":"user"}`
      if (c.includes('id -u')) return '/home/u\n1000\n'
      return ''
    },
    chunk: async () => true,
  }
}

describe('provisionServiceSet with refresh', () => {
  beforeEach(() => { updates.length = 0; builds.clear(); builds.add('walnut-daemon-000000000000'); updateNames = SET; updateFails = null })

  it('guard: after each leader update the set holds the build the move\'s set lines run', async () => {
    for (const leader of ['walnut-daemon-aaaaaaaaaaaa', 'walnut-daemon-bbbbbbbbbbbb', 'walnut-daemon-cccccccccccc']) {
      expect(await provisionServiceSet(source, leader, io() as never, ask, { refresh: true })).toMatchObject({ set: SET, installed: true, ok: true })
      const line = setCliCommand(SET, leader, 'net-id')
      expect(builds.has(/= (walnut-daemon-[0-9a-f]+) \]/.exec(line)![1])).toBe(true)
    }
    // The regular update, once per leader build, naming the Walnut and the set, in the status's scope.
    expect(updates.map((u) => [u.expected, u.scope, u.opts.walnut, u.opts.set])).toEqual([
      ['walnut-daemon-aaaaaaaaaaaa', 'user', ask, SET], ['walnut-daemon-bbbbbbbbbbbb', 'user', ask, SET], ['walnut-daemon-cccccccccccc', 'user', ask, SET],
    ])
  })

  it('a set with this build is not updated, and without refresh nothing is probed', async () => {
    builds.add('walnut-daemon-aaaaaaaaaaaa')
    expect(await provisionServiceSet(source, 'walnut-daemon-aaaaaaaaaaaa', io() as never, ask, { refresh: true })).toMatchObject({ ok: true })
    expect(await provisionServiceSet(source, 'walnut-daemon-bbbbbbbbbbbb', io() as never, ask)).toMatchObject({ ok: true })
    expect(updates).toEqual([])
  })

  it('a build that failed on the host is not tried again for a day; a refresh that ran says so', async () => {
    updateFails = Object.assign(new Error('Managed daemon update failed: the new daemon did not stay'), { buildFailed: true })
    expect(await provisionServiceSet(source, 'walnut-daemon-aaaaaaaaaaaa', io() as never, ask, { refresh: true })).toMatchObject({ ok: false, retryLook: true, retryInMs: 24 * 3600_000 })
    updateFails = null
    expect(await provisionServiceSet(source, 'walnut-daemon-aaaaaaaaaaaa', io() as never, ask, { refresh: true })).toMatchObject({ ok: true, refreshed: true })
  })

  it('an upload the link cut (DaemonUpdateStageError) is a quiet retry, no failure', async () => {
    updateFails = Object.assign(new Error('Daemon update upload failed; the installed service was not changed'), { name: 'DaemonUpdateStageError' })
    expect(await provisionServiceSet(source, 'walnut-daemon-aaaaaaaaaaaa', io() as never, ask, { refresh: true })).toMatchObject({ ok: false, retryLook: true, cut: true })
  })

  it('an update that failed, or named another set, asks for another look and never says ok', async () => {
    updateFails = new Error('Managed daemon update failed: probation failed')
    expect(await provisionServiceSet(source, 'walnut-daemon-aaaaaaaaaaaa', io() as never, ask, { refresh: true })).toMatchObject({ ok: false, retryLook: true, message: expect.stringMatching(/could not take this build: .*probation failed/) })
    updateFails = null
    updateNames = ''
    expect(await provisionServiceSet(source, 'walnut-daemon-bbbbbbbbbbbb', io() as never, ask, { refresh: true })).toMatchObject({ ok: false, retryLook: true, message: expect.stringMatching(/named set default, not this Walnut's own/) })
  })
})
