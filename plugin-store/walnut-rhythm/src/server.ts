/**
 * Rhythm's server entry: wires the runtime to the host and nothing else.
 *
 * Three signals feed it: attention (`time:banked`, `time:outside`), agent turns (a hook
 * on turn start and end, for the natural pause), and the clock (a 30s tick plus one
 * precise timeout at the end of the running focus phase). Everything it registers is
 * owned by the host, so disable and reload take all of it away, the quiet hold included.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Disposable, WalnutServerApi } from '@open-walnut/plugin-api/server'
import { runProcess } from './server/exec'
import { MacosBridge } from './server/macos-bridge'
import { readMacosFocus } from './server/macos-focus'
import { registerOps } from './server/ops'
import { spanFromOutside, spansFromBanked } from './server/presence'
import { buildPublicState, stateFingerprint } from './server/public-state'
import { RhythmRuntime } from './server/runtime'

const TICK_MS = 30_000
/** Land the phase change just after the boundary, never a hair before it. */
const BOUNDARY_SLACK_MS = 250

let active: RhythmRuntime | null = null

export async function activate(walnut: WalnutServerApi): Promise<void> {
  // The working directory is the server's, so the skills path comes from this module's own URL.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  walnut.registry.skill({ id: 'rhythm', directory: path.resolve(moduleDir, '..', 'skills') })

  if (walnut.replica) {
    // The primary owns the timers, the reminders and the Mac. Two boxes would remind twice.
    registerOps(walnut, null)
    walnut.log.info('Rhythm is idle on this cloud replica; the primary runs it')
    return
  }

  let emitState: () => void = () => undefined
  const macos = new MacosBridge({
    enabled: process.platform === 'darwin',
    log: walnut.log.child('macos'),
    run: runProcess,
    readFocus: () => readMacosFocus(),
    shortcutsDir: path.join(walnut.storage.dataDir, 'shortcuts'),
    onChange: () => { emitState() },
  })
  const runtime = new RhythmRuntime({ walnut, macos })
  await runtime.load()
  active = runtime

  let lastFingerprint = ''
  emitState = () => {
    const state = buildPublicState(runtime, runtime.now())
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

  walnut.events.on('time:banked', (event) => runtime.attention(spansFromBanked(event.data, runtime.now()), 'walnut'))
  walnut.events.on('time:outside', (event) => {
    const span = spanFromOutside(event.data, runtime.now())
    return runtime.attention(span ? [span] : [], 'mac')
  })
  walnut.events.on('quiet:changed', () => runtime.kick())

  walnut.registry.hook({
    id: 'turn-tracker',
    points: ['onTurnStart', 'onTurnComplete', 'onTurnError'],
    timeoutMs: 1_000,
    handler(context) { runtime.turn(context) },
  })

  walnut.config.onChange((config) => {
    runtime.applyConfig(config)
    return runtime.kick()
  })

  walnut.timers.interval(() => runtime.kick(), TICK_MS)
  await runtime.kick()
  walnut.log.info('Rhythm activated', {
    focus: runtime.focus.phase,
    reminderEveryMinutes: runtime.config.reminderEveryMinutes,
  })
}

export async function deactivate(): Promise<void> {
  const runtime = active
  active = null
  if (!runtime) return
  try {
    runtime.markDirty()
    await runtime.persist()
  } catch {
    // The host is already tearing the plugin down; a failed flush must not throw here.
  }
}
