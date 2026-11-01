/**
 * Rhythm never starts on its own (2026-10-31, the user: "it should not start by itself,
 * I start it ... and if I don't start, don't start it yourself").
 *
 * Every way a run could begin without the person is walked here: a fresh launch, a
 * clock running for a day, waking from sleep mid-run, a restart and a reload of the
 * plugin, attention and agent-turn events (what the old stand-up reminder counted), and
 * the end of a break. Then the source itself is scanned: only the Start op starts a
 * run, the only callers of that op are buttons, and a routine's tool list cannot reach it.
 * (A session may still call the op; the skill and the op's description say only when
 * the person asked, which is how Ask Walnut starts a pomodoro someone asks for.)
 * A NEW caller of either fails here until it is shown to be a person's click.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeWalnut } from '../../../packages/plugin-api/src/testing.js'
import { activate, deactivate } from '../../../plugin-store/walnut-rhythm/src/server'
import * as actions from '../../../plugin-store/walnut-rhythm/src/server/actions'
import { makeHarness, MIN } from './harness'

const NINE = new Date(2026, 8, 25, 9, 0).getTime()
const HOUR = 60 * MIN
const SAFE_CONFIG = { mirror_macos_focus: false, macos_focus_shortcuts: false }
const PLUGIN = path.resolve(__dirname, '../../../plugin-store/walnut-rhythm')
const IOS = path.resolve(__dirname, '../../../ios-native/Walnut')

async function boot(start = NINE) {
  const h = makeHarness({ start, config: SAFE_CONFIG })
  const runtime = h.build()
  await runtime.load()
  await runtime.kick()
  return { h, runtime }
}

/** A day of the 30s tick, in 5 minute steps (the tick does the same thing each time). */
async function runClock(h: ReturnType<typeof makeHarness>, runtime: Awaited<ReturnType<typeof boot>>['runtime'], ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 5 * MIN) await h.tick(runtime, 5 * MIN)
}

describe('nothing starts a run but Start', () => {
  it('a fresh launch is off, and a day of the clock leaves it off with nothing said', async () => {
    const { h, runtime } = await boot()
    expect(runtime.focus.phase).toBe('idle')
    await runClock(h, runtime, 24 * HOUR)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.notices()).toHaveLength(0)
    expect(h.calls.filter((call) => call.type === 'quiet.set')).toHaveLength(0)
  })

  it('after a run, the break ends with ONE question, and then it stays off for the rest of the day', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, {})
    await h.tick(runtime, 25 * MIN + 1) // the block ends: its notice
    await h.tick(runtime, 5 * MIN) // the break ends: the one question
    expect(runtime.focus.phase).toBe('idle')
    expect(h.notices('break-over')).toHaveLength(1)
    await runClock(h, runtime, 24 * HOUR)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.notices('break-over')).toHaveLength(1)
    expect(h.notices()).toHaveLength(2) // the block-done notice and the one question
  })

  it('a restart and a second process after the run ask nothing again and start nothing', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, {})
    await h.tick(runtime, 25 * MIN + 1) // the block ends: its notice
    await h.tick(runtime, 5 * MIN) // the break ends: the one question
    await runtime.persist()
    for (let restart = 0; restart < 3; restart++) {
      h.clock.t += MIN
      const again = h.build()
      await again.load()
      await again.kick()
      expect(again.focus.phase).toBe('idle')
    }
    expect(h.notices()).toHaveLength(2)
  })

  it('waking from sleep hours after a block began closes the run quietly and leaves it off', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, {})
    await runtime.persist()
    h.clock.t = NINE + 3 * HOUR // the Mac slept through the block and its break
    const woke = h.build()
    await woke.load()
    await woke.kick()
    expect(woke.focus).toMatchObject({ phase: 'idle', lastRunStartedAt: NINE, lastRunEndedAt: NINE + 30 * MIN })
    expect(h.notices()).toHaveLength(0) // both would arrive hours late
    // The block's quiet hold ran out with the block (an expired hold is no hold).
    expect(await h.fake.api.notifications.quiet.get()).toMatchObject({ active: false })
    await runClock(h, woke, 2 * HOUR)
    expect(woke.focus.phase).toBe('idle')
  })

  it('an older version\'s state of someone mid-streak boots off', async () => {
    const h = makeHarness({ start: NINE, config: SAFE_CONFIG })
    await h.fake.api.storage.writeJson('state.json', {
      version: 1,
      presence: { streakStartedAt: NINE - 50 * MIN, lastActiveAt: NINE - MIN },
      reminder: { streakKey: NINE - 50 * MIN, nextDueAt: NINE + 10 * MIN, snoozedUntil: null, deferStartedAt: null, outstanding: false, firedAt: null },
      focus: { phase: 'idle', minutes: 0, startedAt: 0, endsAt: 0, completedInCycle: 0, lastEndedAt: 0 },
    })
    const runtime = h.build()
    await runtime.load()
    await runClock(h, runtime, 2 * HOUR)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.notices()).toHaveLength(0)
  })
})

describe('the plugin as the host runs it', () => {
  it('listens to no attention or agent-turn signal, and gives a routine only the read-only status tool', async () => {
    const fake = createFakeWalnut({ pluginId: 'walnut-rhythm', config: SAFE_CONFIG })
    const on = vi.spyOn(fake.api.events, 'on')
    const hook = vi.spyOn(fake.api.registry, 'hook')
    const tool = vi.spyOn(fake.api.registry, 'tool')
    await activate(fake.api)
    try {
      expect(on.mock.calls.map((call) => call[0])).toEqual(['quiet:changed'])
      expect(hook).not.toHaveBeenCalled()
      expect(tool.mock.calls.map((call) => (call[0] as { name: string }).name)).toEqual(['status'])
    } finally {
      await deactivate()
    }
  })

  it('a launch, then attention and agent-turn events, leave it off, and the ring says so with one Start', async () => {
    for (let launch = 0; launch < 2; launch++) {
      const fake = createFakeWalnut({ pluginId: 'walnut-rhythm', config: SAFE_CONFIG })
      await activate(fake.api)
      try {
        const now = Date.now()
        fake.api.events.emit('time:banked', { records: [{ ts: new Date(now - 90 * MIN).toISOString(), durationMs: 90 * MIN, kind: 'session' }] })
        fake.api.events.emit('time:outside', { ts: new Date(now - 10 * MIN).toISOString(), durationMs: 10 * MIN, app: 'Xcode' })
        await new Promise((resolve) => setTimeout(resolve, 20))
        const status = await fake.registeredOps.find((op) => op.name === 'status')!.handler({}, { call: async () => undefined }) as { focus: { phase: string } }
        expect(status.focus.phase).toBe('idle')
        const ring = fake.statusItems.get('rhythm')
        expect(ring).toMatchObject({ title: 'Rhythm is off', glyph: 'pause' })
        expect(ring?.timer).toBeUndefined()
        expect(ring?.actions).toEqual([{ label: 'Start focus block (25 min)', op: 'focus_start', primary: true }])
        expect(fake.notices).toHaveLength(0)
      } finally {
        await deactivate()
      }
    }
  })
})

function sources(dir: string, ext: RegExp): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full, ext))
    else if (ext.test(entry.name)) out.push(full)
  }
  return out
}

function filesContaining(root: string, ext: RegExp, needle: RegExp): string[] {
  return sources(root, ext).filter((file) => needle.test(fs.readFileSync(file, 'utf8'))).map((file) => path.relative(root, file)).sort()
}

describe('the source: who can start a run', () => {
  it('only the Start op moves a run out of off', () => {
    // startFocus is the one function that leaves idle; it is defined in focus.ts and called by the op.
    expect(filesContaining(path.join(PLUGIN, 'src'), /\.tsx?$/, /\bstartFocus\(/)).toEqual(['server/actions.ts', 'server/focus.ts'])
    const calls = fs.readFileSync(path.join(PLUGIN, 'src/server/actions.ts'), 'utf8').match(/\bstartFocus\(/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it('the Start op is named only by its registration and by buttons the person clicks', () => {
    // ops.ts registers it; status-item.ts and notices.ts are buttons; start-form.tsx is the
    // Start form (the App's focus card and the sidebar popover both draw it).
    expect(filesContaining(path.join(PLUGIN, 'src'), /\.tsx?$/, /['"]focus_start['"]/)).toEqual([
      'server/notices.ts', 'server/ops.ts', 'server/status-item.ts', 'web/start-form.tsx',
    ])
    const form = fs.readFileSync(path.join(PLUGIN, 'src/web/start-form.tsx'), 'utf8')
    // Its one call sits in startWithMusic, whose one caller is the form's `start`, which only the Start button's onClick runs.
    expect(form.match(/['"]focus_start['"]/g)).toHaveLength(1)
    expect(form.match(/\bstartWithMusic\(/g)).toHaveLength(2) // the definition and the one call
    expect(form).toMatch(/const start = \(\) => \{[^]*?void startWithMusic\(/)
    // Exported, so any file could call it: only the form does.
    expect(filesContaining(path.join(PLUGIN, 'src'), /\.tsx?$/, /\bstartWithMusic\(/)).toEqual(['web/start-form.tsx'])
    // Every other use of `start`, string literals blanked out (a test id is not a call).
    const startUses = form.split('\n')
      .filter((line) => !/^\s*(\*|\/\/)/.test(line) && !/const start = /.test(line))
      .filter((line) => /[^.\w]start[^\w]/.test(line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')))
    expect(startUses.map((line) => line.trim())).toEqual(['onClick={start}'])
    // Every file that renders the form: the App's focus card and the popover panel, both a person's click away.
    expect(filesContaining(path.join(PLUGIN, 'src'), /\.tsx?$/, /<StartForm\b/)).toEqual(['web.tsx', 'web/focus-card.tsx'])
  })

  it('nothing else in Walnut (server, console, phone, shipped skills) calls the Start op', () => {
    const root = path.resolve(__dirname, '../../..')
    const outside = [
      ...filesContaining(path.join(root, 'src'), /\.(ts|tsx|md|yaml|json)$/, /walnut_rhythm_focus_start|rhythm\/ops\/[^'"`]*focus_start/).map((f) => `src/${f}`),
      ...filesContaining(path.join(root, 'web/src'), /\.(ts|tsx)$/, /focus_start/).map((f) => `web/src/${f}`),
      ...filesContaining(IOS, /\.swift$/, /focus_start/).map((f) => `ios/${f}`),
    ]
    // The phone's one API call, made only by its Start button (checked below).
    expect(outside).toEqual(['ios/API/WalnutAPIRhythm.swift'])
  })

  it('on the phone, only the Start button starts a block', () => {
    expect(filesContaining(IOS, /\.swift$/, /rhythmFocusStart\(/)).toEqual(['API/WalnutAPIRhythm.swift', 'Stores/FocusMusicPlayer.swift'])
    expect(filesContaining(IOS, /\.swift$/, /startFocusBlock\(/)).toEqual(['Stores/FocusMusicPlayer.swift', 'Views/Settings/FocusMusicView.swift'])
    const view = fs.readFileSync(path.join(IOS, 'Views/Settings/FocusMusicView.swift'), 'utf8')
    expect(view.match(/startFocusBlock\(/g)).toHaveLength(1)
    expect(view).toMatch(/Button\("Start [^"\n]*"\) \{\n\s*let minutes = [^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*run \{ await player\.startFocusBlock\(/)
  })
})
