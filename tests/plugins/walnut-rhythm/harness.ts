/**
 * A Rhythm runtime on a fake clock, a fake host and fake macOS, for the runtime tests.
 *
 * The notifications service is our own recording fake rather than the one inside
 * createFakeWalnut: the order of dismiss / notify / quiet calls is part of what these
 * tests assert, and quiet-hold liveness must follow the FAKE clock, not Date.now().
 * No real process runs and no real file under ~/Library is read.
 */
import { createFakeWalnut } from '../../../packages/plugin-api/src/testing.js'
import type { WalnutTask } from '../../../packages/plugin-api/src/shared.js'
import type { PluginNotifyInput, QuietHold } from '../../../packages/plugin-api/src/server.js'
import type { RunResult, Runner } from '../../../plugin-store/walnut-rhythm/src/server/exec'
import { MacosBridge } from '../../../plugin-store/walnut-rhythm/src/server/macos-bridge'
import type { FocusDetailRead, LiveAssertion, MacosFocusRead } from '../../../plugin-store/walnut-rhythm/src/server/macos-focus'
import { DndController, DND_MODE_ID } from '../../../plugin-store/walnut-rhythm/src/server/macos-dnd'
import { SHORTCUT_OFF, SHORTCUT_ON } from '../../../plugin-store/walnut-rhythm/src/server/macos-shortcuts'
import { RhythmRuntime } from '../../../plugin-store/walnut-rhythm/src/server/runtime'
import { SpotifyControl } from '../../../plugin-store/walnut-rhythm/src/server/spotify'

export const MIN = 60_000

export type HostCall =
  | { type: 'notify'; notice: PluginNotifyInput }
  | { type: 'dismiss'; key: string }
  | { type: 'quiet.set'; input: { until?: number; reason?: string } }
  | { type: 'quiet.clear' }

export interface HarnessOptions {
  start: number
  config?: Record<string, unknown>
  darwin?: boolean
  tasks?: WalnutTask[]
  macosFocus?: () => MacosFocusRead
  runner?: Runner
  /** Spotify.app is installed (on a `darwin` harness). Default true. */
  spotifyInstalled?: boolean
}

/**
 * A fake macOS Focus store: the Rhythm shortcuts add and remove Do Not Disturb here the
 * way macOS does, a Focus "until a time" ends at its time, and a test can turn on the
 * person's own Focus. Nothing real runs.
 */
export interface FakeMac {
  live: LiveAssertion[]
  /** The shortcut input Rhythm last wrote. */
  input: string | null
  /** Which Rhythm shortcuts exist in Shortcuts. */
  shortcuts: string[]
  failOn: boolean
  failOff: boolean
  /** The shortcut runs, but macOS starts nothing. */
  silentOn: boolean
  /** An older copy of the shortcut: Do Not Disturb with no end time. */
  ignoreInput?: boolean
  /** Real milliseconds each `shortcuts run` takes, as macOS does (default none). */
  delayMs?: number
  /** Assertions past their end that macOS has not cleared from its file yet. */
  stale?: LiveAssertion[]
  /** macOS refuses the read (no Full Disk Access). */
  denied: boolean
  seq: number
}

export function makeHarness(options: HarnessOptions) {
  const clock = { t: options.start }
  const calls: HostCall[] = []
  const feed = new Map<string, PluginNotifyInput>()
  let ourHold: QuietHold | null = null
  let userHold: QuietHold | null = null
  const live = (hold: QuietHold | null) => (hold && (hold.until === undefined || hold.until > clock.t) ? hold : null)
  const notifications = {
    async notify(notice: PluginNotifyInput) { calls.push({ type: 'notify', notice }); feed.set(notice.dedupKey, notice) },
    async error() { /* not used */ },
    async recover() { /* not used */ },
    async dismiss(key: string) { calls.push({ type: 'dismiss', key }); feed.delete(key) },
    quiet: {
      async get() {
        const holds = [live(userHold), live(ourHold)].filter((hold): hold is QuietHold => hold !== null)
        return { active: holds.length > 0, allowPermissions: true, holds }
      },
      async set(input: { until?: number; reason?: string }) {
        calls.push({ type: 'quiet.set', input: { ...input } })
        ourHold = { source: 'plugin:walnut-rhythm', since: clock.t, ...input }
      },
      async clear() { calls.push({ type: 'quiet.clear' }); ourHold = null },
    },
  }
  const fake = createFakeWalnut({
    pluginId: 'walnut-rhythm',
    pluginName: 'Rhythm',
    config: options.config ?? {},
    tasks: options.tasks,
    overrides: { notifications: notifications as never },
  })
  const runs: Array<{ command: string; args: readonly string[] }> = []
  const mac: FakeMac = { live: [], input: null, shortcuts: [SHORTCUT_ON, SHORTCUT_OFF], failOn: false, failOff: false, silentOn: false, denied: false, seq: 0 }
  const liveNow = () => mac.live.filter((one) => one.endsAt === undefined || one.endsAt > clock.t)
  const runner: Runner = options.runner ?? (async (command, args): Promise<RunResult> => {
    runs.push({ command, args })
    if (command === 'shortcuts' && args[0] === 'list') return { ok: true, code: 0, stdout: mac.shortcuts.join('\n'), stderr: '' }
    if (command === 'shortcuts' && args[0] === 'run' && mac.delayMs) await new Promise((resolve) => setTimeout(resolve, mac.delayMs))
    if (command === 'shortcuts' && args[0] === 'run' && args[1] === SHORTCUT_ON) {
      if (mac.failOn) return { ok: false, code: 1, stdout: '', stderr: '', error: 'The shortcut could not be found' }
      if (!mac.silentOn) {
        const endsAt = mac.input && !mac.ignoreInput ? new Date(mac.input.replace(' ', 'T')).getTime() : undefined
        mac.live.push({ id: `dnd-${++mac.seq}`, modeId: DND_MODE_ID, startedAt: clock.t, ...(endsAt ? { endsAt } : {}) })
      }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    if (command === 'shortcuts' && args[0] === 'run' && args[1] === SHORTCUT_OFF) {
      if (mac.failOff) return { ok: false, code: 1, stdout: '', stderr: '', error: 'timed out' }
      mac.live = mac.live.filter((one) => one.modeId !== DND_MODE_ID)
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    // Spotify answers "playing" once asked to play; nothing here is a real process.
    const stdout = command === 'osascript' && args.some((arg) => arg.includes('player state')) ? 'playing\n' : ''
    return { ok: true, code: 0, stdout, stderr: '' }
  })
  const macFocus = (): MacosFocusRead => {
    if (mac.denied) return { ok: false, reason: 'permission', message: 'denied' }
    const latest = liveNow().pop()
    return latest ? { ok: true, focus: { active: true, modeId: latest.modeId, name: latest.modeId === DND_MODE_ID ? 'Do Not Disturb' : 'Work' } } : { ok: true, focus: { active: false } }
  }
  const macosFocus = options.macosFocus ?? macFocus
  const readDetail = async (): Promise<FocusDetailRead> => {
    const focus = macosFocus()
    if (!focus.ok) return focus
    // A Focus a test names without the fake store is the person's own.
    const live = liveNow()
    const raw = [...(mac.stale ?? []), ...live]
    return { ok: true, focus: focus.focus, live: focus.focus.active && live.length === 0 ? [{ id: 'theirs', modeId: focus.focus.modeId, startedAt: 0 }] : raw }
  }

  const build = () => {
    const macos = new MacosBridge({
      enabled: options.darwin ?? false,
      log: fake.api.log,
      run: runner,
      readFocus: async () => macosFocus(),
      shortcutsDir: '/tmp/walnut-rhythm-test-shortcuts',
      onChange: () => undefined,
    })
    const spotify = new SpotifyControl({
      enabled: options.darwin ?? false,
      run: runner,
      storage: fake.api.storage,
      appPaths: ['/Applications/Spotify.app'],
      exists: async () => options.spotifyInstalled ?? true,
      sleep: async () => undefined,
    })
    return new RhythmRuntime({
      walnut: fake.api, macos, spotify, now: () => clock.t,
      dnd: (rt) => new DndController({
        enabled: options.darwin ?? false,
        log: fake.api.log,
        run: runner,
        readDetail,
        checkShortcuts: (now) => macos.checkShortcuts(now),
        writeInput: async (text) => { mac.input = text; return '/fixture/until.txt' },
        assumeOff: (now) => macos.assumeDoNotDisturbOff(now),
        now: () => clock.t,
        running: () => rt.runningBlock(),
        onChange: () => rt.dndChanged(),
        wait: async () => undefined,
      }),
    })
  }

  return {
    clock,
    mac,
    calls,
    feed,
    fake,
    runs,
    build,
    setUserQuiet(hold: QuietHold | null) { userHold = hold },
    ourHold: () => ourHold,
    /** Move the clock and run one step, the way the 30s tick does. */
    async tick(runtime: RhythmRuntime, ms = 0) {
      clock.t += ms
      await runtime.kick()
    },
    notices: (key?: string) => calls.filter((call): call is Extract<HostCall, { type: 'notify' }> => call.type === 'notify' && (!key || call.notice.dedupKey === key)),
  }
}
