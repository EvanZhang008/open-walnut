/**
 * Rhythm's real `activate()` against the published fake host (createFakeWalnut): the
 * ops it declares, the events it listens to, the quiet hold it takes, and the replica
 * refusal. macOS mirroring and shortcuts are OFF here, so no file under ~/Library is
 * read and no process is started even when this runs on a Mac.
 */
import { describe, expect, it } from 'vitest'
import { createFakeWalnut } from '../../../packages/plugin-api/src/testing.js'
import { activate, deactivate } from '../../../plugin-store/walnut-rhythm/src/server'

const SAFE_CONFIG = { mirror_macos_focus: false, macos_focus_shortcuts: false, quiet_hours: '' }

function op(fake: ReturnType<typeof createFakeWalnut>, name: string) {
  const found = fake.registeredOps.find((definition) => definition.name === name)
  if (!found) throw new Error(`op ${name} was not registered`)
  return (args: Record<string, unknown> = {}) => found.handler(args, { call: async () => undefined })
}

describe('activate', () => {
  it('declares the nine ops with the intended reach', async () => {
    const fake = createFakeWalnut({ pluginId: 'walnut-rhythm', config: SAFE_CONFIG })
    await activate(fake.api)
    try {
      const reach = Object.fromEntries(fake.registeredOps.map((definition) => [definition.name, `${definition.readonly ? 'read' : 'write'}:${definition.remote}`]))
      expect(reach).toEqual({
        status: 'read:allow',
        focus_start: 'write:allow',
        focus_stop: 'write:allow',
        break_done: 'write:allow',
        break_snooze: 'write:allow',
        break_start: 'write:allow',
        break_skip: 'write:allow',
        macos_shortcuts_install: 'write:deny',
        macos_privacy_open: 'write:deny',
      })
    } finally {
      await deactivate()
    }
  })

  it('runs a focus block end to end through the fake host: quiet hold, state event, stop', async () => {
    const fake = createFakeWalnut({ pluginId: 'walnut-rhythm', config: SAFE_CONFIG })
    await activate(fake.api)
    try {
      const started = await op(fake, 'focus_start')({ minutes: 25 }) as { message: string; state: { focus: { phase: string } } }
      expect(started.message).toBe('Focus block started: 25 min.')
      expect(started.state.focus.phase).toBe('focus')
      const quiet = await fake.api.notifications.quiet.get()
      expect(quiet.active).toBe(true)
      expect(quiet.holds).toEqual([expect.objectContaining({ source: 'plugin:walnut-rhythm', reason: 'Focus block' })])
      expect(fake.emitted.some((event) => event.name === 'state')).toBe(true)
      // The rail's ring, published through the real host seam.
      expect(fake.statusItems.get('rhythm')).toMatchObject({
        title: 'Focus · {remaining} left', tone: 'accent', timer: { mode: 'drain' },
        actions: [{ label: 'Stop block', op: 'focus_stop' }],
      })

      await expect(op(fake, 'focus_start')({})).rejects.toThrow(/already running/)
      const stopped = await op(fake, 'focus_stop')() as { message: string }
      expect(stopped.message).toMatch(/^Focus block stopped after 0 min\.$/)
      expect((await fake.api.notifications.quiet.get()).active).toBe(false)
      // Nobody has been at the keyboard, so there is nothing left to count: the ring goes.
      expect(fake.statusItems.has('rhythm')).toBe(false)
    } finally {
      await deactivate()
    }
  })

  it('folds time:banked attention into the sitting streak', async () => {
    const fake = createFakeWalnut({ pluginId: 'walnut-rhythm', config: SAFE_CONFIG })
    await activate(fake.api)
    try {
      const now = Date.now()
      fake.api.events.emit('time:banked', {
        records: [{ ts: new Date(now - 20 * 60_000).toISOString(), durationMs: 20 * 60_000 - 1000, kind: 'session' }],
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const status = await op(fake, 'status')() as { sitting: { present: boolean; sittingMs: number } }
      expect(status.sitting.present).toBe(true)
      expect(status.sitting.sittingMs).toBeGreaterThanOrEqual(19 * 60_000)
    } finally {
      await deactivate()
    }
  })

  it('on a cloud replica it answers status and refuses every action', async () => {
    const fake = createFakeWalnut({ pluginId: 'walnut-rhythm', config: SAFE_CONFIG, overrides: { replica: true } })
    await activate(fake.api)
    expect(await op(fake, 'status')()).toEqual({ version: 1, replica: true })
    await expect(op(fake, 'focus_start')({})).rejects.toThrow(/primary Walnut/)
    expect(fake.notices).toEqual([])
  })
})

describe('the Focus mirror reads through walnut.macos', () => {
  const ASSERTIONS = JSON.stringify({
    data: [{ storeAssertionRecords: [{ assertionStartDateTimestamp: 1, assertionDetails: { assertionDetailsModeIdentifier: 'com.apple.donotdisturb.mode.default' } }] }],
  })

  /** Activate on a pretend Mac whose protected reads are faked: nothing under the real
   *  ~/Library is read, and no `status` refresh runs (that would list real Shortcuts). */
  async function withMirror(refuse: boolean, body: (fake: ReturnType<typeof createFakeWalnut>) => Promise<void>) {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const fake = createFakeWalnut({
      pluginId: 'walnut-rhythm',
      config: { ...SAFE_CONFIG, mirror_macos_focus: true },
      readProtectedFile: (file) => {
        if (refuse) throw Object.assign(new Error('refused'), { code: 'EPERM' })
        if (file.endsWith('Assertions.json')) return ASSERTIONS
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      fullDiskAccessTarget: '/Applications/Walnut.app',
    })
    try {
      await activate(fake.api)
      await body(fake)
    } finally {
      await deactivate()
      Object.defineProperty(process, 'platform', realPlatform)
    }
    // The plugin stopped, so Settings no longer lists its reason.
    expect(fake.fullDiskAccessUses).toEqual([])
  }

  it('declares why and reads the Focus files through Walnut', async () => {
    await withMirror(false, async (fake) => {
      expect(fake.fullDiskAccessUses).toEqual([{
        reason: "mirror your Mac's Focus into Walnut's quiet mode",
        probe: expect.stringMatching(/\/Library\/DoNotDisturb\/DB\/Assertions\.json$/),
      }])
      expect(fake.protectedReads[0]).toMatch(/\/Library\/DoNotDisturb\/DB\/Assertions\.json$/)
      const state = await op(fake, 'status')() as { macos: { mirror: { phase: string; focusName?: string } } }
      expect(state.macos.mirror).toMatchObject({ phase: 'active', focusName: 'Do Not Disturb' })
    })
  })

  it('a refused read names Walnut, not the server\'s node', async () => {
    await withMirror(true, async (fake) => {
      const state = await op(fake, 'status')() as { macos: { mirror: Record<string, unknown> } }
      expect(state.macos.mirror).toMatchObject({ phase: 'unavailable', needsAccess: true, grantTarget: '/Applications/Walnut.app' })
    })
  })
})
