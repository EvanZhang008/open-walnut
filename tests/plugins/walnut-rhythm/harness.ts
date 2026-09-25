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
import type { MacosFocusRead } from '../../../plugin-store/walnut-rhythm/src/server/macos-focus'
import { spansFromBanked } from '../../../plugin-store/walnut-rhythm/src/server/presence'
import { RhythmRuntime } from '../../../plugin-store/walnut-rhythm/src/server/runtime'

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
  const runner: Runner = options.runner ?? (async (command, args): Promise<RunResult> => {
    runs.push({ command, args })
    return { ok: true, code: 0, stdout: '', stderr: '' }
  })
  const macosFocus = options.macosFocus ?? ((): MacosFocusRead => ({ ok: true, focus: { active: false } }))

  const build = () => {
    const macos = new MacosBridge({
      enabled: options.darwin ?? false,
      log: fake.api.log,
      run: runner,
      readFocus: async () => macosFocus(),
      shortcutsDir: '/tmp/walnut-rhythm-test-shortcuts',
      onChange: () => undefined,
    })
    return new RhythmRuntime({ walnut: fake.api, macos, now: () => clock.t })
  }

  return {
    clock,
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

/** One console attention record covering [start, start + ms). */
export function banked(start: number, ms: number, extra: Record<string, unknown> = {}) {
  return { records: [{ ts: new Date(start).toISOString(), durationMs: ms, kind: 'session', ...extra }] }
}

/**
 * Feed continuous attention from `from` to `to` in one-minute records, stepping the
 * clock along with it, the way the browser banks a batch about once a minute.
 */
export async function sitThrough(h: ReturnType<typeof makeHarness>, runtime: RhythmRuntime, from: number, to: number): Promise<void> {
  for (let t = from; t < to; t += MIN) {
    const end = Math.min(t + MIN, to)
    h.clock.t = end
    await runtime.attention(spansFromBanked(banked(t, end - t), h.clock.t), 'walnut')
  }
}
