/**
 * Rhythm's server entry: wires the runtime to the host and nothing else.
 *
 * Rhythm is off until the person presses Start, so it listens to nothing about them:
 * no attention events, no agent turns. What feeds it is the person's own ops, quiet
 * changes, config changes, and the clock (a 30s tick plus one precise timeout at the
 * end of the running phase), and the clock only ever moves a run toward off.
 * Everything it registers is owned by the host, so disable and reload take all of it
 * away, the quiet hold and the sidebar ring included.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Disposable, WalnutServerApi } from '@open-walnut/plugin-api/server'
import { runProcess } from './server/exec'
import { MacosBridge } from './server/macos-bridge'
import { DndController } from './server/macos-dnd'
import { focusDbDir, readFocusDetail, readMacosFocus, type ReadText } from './server/macos-focus'
import { registerOps } from './server/ops'
import { buildPublicState, stateFingerprint } from './server/public-state'
import { RhythmRuntime } from './server/runtime'
import { rhythmStatusItem, STATUS_ITEM_ID } from './server/status-item'
import { SpotifyControl } from './server/spotify'
import { testCopyReason } from './server/test-copy'

const TICK_MS = 30_000
/** Land the phase change just after the boundary, never a hair before it. */
const BOUNDARY_SLACK_MS = 250

let active: RhythmRuntime | null = null

export async function activate(walnut: WalnutServerApi): Promise<void> {
  // The working directory is the server's, so the skills path comes from this module's own URL.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  walnut.registry.skill({ id: 'rhythm', directory: path.resolve(moduleDir, '..', 'skills') })

  if (walnut.replica) {
    // The primary owns the timers, the notices and the Mac. Two boxes would remind twice.
    registerOps(walnut, null)
    walnut.log.info('Rhythm is idle on this cloud replica; the primary runs it')
    return
  }

  let emitState: () => void = () => undefined
  // The Focus files sit behind Full Disk Access. Read through Walnut's one grant for it,
  // so the person adds Walnut once instead of whichever program runs the server (often a
  // bare `node`, a second row next to Walnut's). A host older than `walnut.macos` reads
  // them directly, as Rhythm always did.
  const protectedReads = typeof walnut.macos?.readProtectedFile === 'function' ? walnut.macos : null
  const focusDir = focusDbDir()
  const readText: ReadText | undefined = protectedReads
    ? (file) => protectedReads.readProtectedFile(file).catch((error: unknown) => {
        // No reader on this host (a test server's temporary data dir): read it directly.
        if ((error as { code?: string }).code === 'ENOTSUP') return fsp.readFile(file, 'utf8')
        throw error
      })
    : undefined
  const shortcutsDir = path.join(walnut.storage.dataDir, 'shortcuts')
  // A test copy reads the Mac (the Focus mirror) but never changes it: see test-copy.ts.
  const testCopy = testCopyReason({ dataDir: walnut.storage.dataDir })
  const changesMac = process.platform === 'darwin' && testCopy === null
  if (process.platform === 'darwin' && testCopy) walnut.log.info(`Rhythm leaves Do Not Disturb and Spotify alone on ${testCopy}`)
  const macos = new MacosBridge({
    enabled: process.platform === 'darwin',
    log: walnut.log.child('macos'),
    run: runProcess,
    readFocus: () => readMacosFocus(focusDir, readText),
    ...(protectedReads
      ? {
          useAccess: () => protectedReads.useFullDiskAccess({
            reason: "mirror your Mac's Focus into Walnut's quiet mode",
            probe: path.join(focusDir, 'Assertions.json'),
          }),
          grantTarget: () => protectedReads.fullDiskAccessTarget(),
        }
      : {}),
    shortcutsDir,
    onChange: () => { emitState() },
    // Host-owned, so the install watch's sleep ends with the plugin (see deactivate).
    wait: (ms) => new Promise<void>((resolve) => { walnut.timers.timeout(resolve, ms) }),
  })
  const spotify = new SpotifyControl({
    enabled: changesMac,
    ...(testCopy && process.platform === 'darwin' ? { offReason: `Spotify is left to your real Walnut: this is ${testCopy}.` } : {}),
    run: runProcess, storage: walnut.storage })
  const runtime = new RhythmRuntime({
    walnut, macos, spotify,
    dnd: (rt) => new DndController({
      enabled: changesMac,
      log: walnut.log.child('dnd'),
      run: runProcess,
      readDetail: () => readFocusDetail(focusDir, readText),
      checkShortcuts: (now) => macos.checkShortcuts(now),
      writeInput: async (text) => {
        await fsp.mkdir(shortcutsDir, { recursive: true })
        const file = path.join(shortcutsDir, 'until.txt')
        await fsp.writeFile(file, text, 'utf8')
        return file
      },
      assumeOff: (now) => macos.assumeDoNotDisturbOff(now),
      now: () => rt.now(),
      running: () => rt.runningBlock(),
      onChange: () => rt.dndChanged(),
      wait: (ms) => new Promise<void>((resolve) => { walnut.timers.timeout(resolve, ms) }),
    }),
  })
  await runtime.load()
  active = runtime

  // The ring in the console rail. A host older than status items has no `walnut.ui`.
  const statusItem = typeof walnut.ui?.statusItem === 'function' ? walnut.ui.statusItem({ id: STATUS_ITEM_ID }) : null
  let lastFingerprint = ''
  emitState = () => {
    const state = buildPublicState(runtime, runtime.now())
    if (statusItem) {
      try {
        const item = rhythmStatusItem(state)
        if (item) statusItem.set(item)
        else statusItem.clear()
      } catch (error) {
        runtime.warnOnce('status-item', 'Rhythm could not update its sidebar item', { error: String(error) })
      }
    }
    const fingerprint = stateFingerprint(state)
    if (fingerprint === lastFingerprint) return
    lastFingerprint = fingerprint
    walnut.events.emit('state', state)
  }
  runtime.onChanged = () => { emitState() }

  let boundary: { at: number; timer: Disposable } | null = null
  runtime.onStepped = (now) => {
    const focus = runtime.focus
    const at = focus.phase !== 'idle' && focus.endsAt > now ? focus.endsAt : 0
    if (boundary && boundary.at === at) return
    boundary?.timer.dispose()
    boundary = at ? { at, timer: walnut.timers.timeout(() => runtime.kick(), at - now + BOUNDARY_SLACK_MS) } : null
  }

  registerOps(walnut, runtime)

  walnut.events.on('quiet:changed', () => runtime.kick())

  walnut.config.onChange((config) => {
    runtime.applyConfig(config)
    return runtime.kick()
  })

  walnut.timers.interval(() => runtime.kick(), TICK_MS)
  await runtime.kick()
  walnut.log.info('Rhythm activated', {
    focus: runtime.focus.phase,
    focusMinutes: runtime.config.focusMinutes,
  })
}

export async function deactivate(): Promise<void> {
  const runtime = active
  active = null
  if (!runtime) return
  runtime.macos.dispose()
  try {
    runtime.markDirty()
    await runtime.persist()
  } catch {
    // The host is already tearing the plugin down; a failed flush must not throw here.
  }
}
