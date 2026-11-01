/**
 * Rhythm runtime: the pure decisions applied to a fake host on a fake clock. Real
 * timelines, minute by minute: a run the person starts (block, break, the one question
 * after it), quiet mode, a macOS Focus, and restarts.
 */
import { describe, expect, it, vi } from 'vitest'
import type { WalnutTask } from '../../../packages/plugin-api/src/shared.js'
import * as actions from '../../../plugin-store/walnut-rhythm/src/server/actions'
import type { MacosFocusRead } from '../../../plugin-store/walnut-rhythm/src/server/macos-focus'
import { buildPublicState } from '../../../plugin-store/walnut-rhythm/src/server/public-state'
import { makeHarness, MIN } from './harness'

/** 09:00 local. */
const NINE = new Date(2026, 8, 25, 9, 0).getTime()

function task(id: string, title: string): WalnutTask {
  return {
    id, title, phase: 'IN_PROGRESS', priority: 'none', description: '', summary: '', source: 'local',
    createdAt: new Date(NINE).toISOString(), updatedAt: new Date(NINE).toISOString(),
  } as WalnutTask
}

async function boot(options: Partial<Parameters<typeof makeHarness>[0]> = {}) {
  const h = makeHarness({ start: NINE, ...options })
  const runtime = h.build()
  await runtime.load()
  await runtime.kick()
  return { h, runtime }
}

describe('a run the person starts', () => {
  it('block → break by itself → off, with one notice for each and quiet only during the block', async () => {
    const { h, runtime } = await boot({ tasks: [task('task-7', 'Draft the plan')] })
    const appendLog = vi.spyOn(h.fake.api.tasks, 'appendLog')
    const started = await actions.focusStart(runtime, { taskId: 'task-7' })
    expect(started.state.focus).toMatchObject({ phase: 'focus', taskId: 'task-7', title: 'Draft the plan', minutes: 25, runStartedAt: NINE, endsAt: NINE + 25 * MIN })
    expect(h.calls).toContainEqual({ type: 'quiet.set', input: { reason: 'Focus block', until: NINE + 25 * MIN } })
    await expect(actions.focusStart(runtime, {})).rejects.toThrow(/already running/)

    await h.tick(runtime, 25 * MIN + 1)
    expect(appendLog).toHaveBeenCalledWith('task-7', 'Focus block: 25 min')
    // The break started by itself, at the block's end.
    expect(runtime.focus).toMatchObject({ phase: 'break', breakKind: 'short', startedAt: NINE + 25 * MIN, endsAt: NINE + 30 * MIN, runStartedAt: NINE })
    // Quiet is released before the block-done notice, or Walnut would never show it.
    const cleared = h.calls.findIndex((call) => call.type === 'quiet.clear')
    expect(cleared).toBeGreaterThan(-1)
    expect(cleared).toBeLessThan(h.calls.findIndex((call) => call.type === 'notify' && call.notice.dedupKey === 'focus-done'))
    const done = h.notices('focus-done')
    expect(done).toHaveLength(1)
    expect(done[0]!.notice).toMatchObject({
      title: 'Focus block done, 5 min break',
      body: '25 min on Draft the plan. Stand up and move; the break ends at 09:30.',
      taskId: 'task-7',
      actions: [
        { label: 'End break', op: 'break_skip' },
        { label: 'Another block', op: 'focus_start', args: { taskId: 'task-7', minutes: 25 } },
      ],
    })
    expect(runtime.day).toMatchObject({ focusMinutes: 25, focusBlocks: [{ minutes: 25, taskId: 'task-7' }], focusBreaks: 1 })

    await h.tick(runtime, 5 * MIN)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.feed.has('focus-done')).toBe(false)
    const over = h.notices('break-over')
    expect(over).toHaveLength(1)
    expect(over[0]!.notice.title).toBe('Break over. Start the next block?')
    expect(over[0]!.notice.actions).toEqual([
      { label: 'Start next block', op: 'focus_start', args: { taskId: 'task-7', minutes: 25 } },
      { label: 'Not now', op: 'focus_stop' },
    ])
    expect(buildPublicState(runtime, h.clock.t).focus).toMatchObject({
      phase: 'idle', runStartedAt: null, endsAt: null, lastRun: { startedAt: NINE, endedAt: NINE + 30 * MIN },
    })

    // Not now: still off, the question is gone, nothing else is asked.
    const notNow = await actions.focusStop(runtime)
    expect(notNow.message).toBe('Rhythm is off. It starts when you press Start.')
    expect(h.feed.has('break-over')).toBe(false)
    expect(runtime.day.stoppedBlocks).toBe(0)
  })

  it('Start next block from the question starts the next run on the same task', async () => {
    const { h, runtime } = await boot({ tasks: [task('task-7', 'Draft the plan')] })
    await actions.focusStart(runtime, { taskId: 'task-7', minutes: 10 })
    await h.tick(runtime, 15 * MIN + 1)
    const next = h.notices('break-over')[0]!.notice.actions![0]!
    const again = await actions.focusStart(runtime, next.args ?? {})
    expect(again.state.focus).toMatchObject({ phase: 'focus', taskId: 'task-7', minutes: 10, runStartedAt: h.clock.t })
    expect(h.feed.has('break-over')).toBe(false)
  })

  it('End break turns Rhythm off at once and asks nothing', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, {})
    await h.tick(runtime, 25 * MIN + 1)
    await h.tick(runtime, 2 * MIN)
    const ended = await actions.breakSkip(runtime)
    expect(ended.message).toBe('Break ended. Rhythm is off until you start the next block.')
    expect(runtime.focus.phase).toBe('idle')
    expect(h.feed.size).toBe(0)
    await h.tick(runtime, 30 * MIN)
    expect(h.notices('break-over')).toHaveLength(0)
    expect(ended.state.focus.lastRun).toEqual({ startedAt: NINE, endedAt: NINE + 27 * MIN + 1 })
  })

  it('the fourth block earns the long break, which starts by itself', async () => {
    const { h, runtime } = await boot({ config: { focus_minutes: 10 } })
    for (let block = 0; block < 4; block++) {
      await actions.focusStart(runtime, {})
      await h.tick(runtime, 10 * MIN + 1)
      if (block < 3) {
        expect(runtime.focus).toMatchObject({ phase: 'break', breakKind: 'short' })
        await actions.breakSkip(runtime)
      }
    }
    expect(runtime.focus).toMatchObject({ phase: 'break', breakKind: 'long', completedInCycle: 0 })
    expect(runtime.focus.endsAt - runtime.focus.startedAt).toBe(15 * MIN)
    expect(h.notices('focus-done').at(-1)!.notice.title).toBe('Focus block done, 15 min long break')
  })

  it('an unknown task is refused before anything starts', async () => {
    const { h, runtime } = await boot()
    await expect(actions.focusStart(runtime, { taskId: 'nope' })).rejects.toThrow(/was not found/)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.calls.filter((call) => call.type === 'quiet.set')).toHaveLength(0)
  })

  it('stop ends the block, clears quiet, counts a stopped block and records the run', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 30 })
    await h.tick(runtime, 12 * MIN)
    const stopped = await actions.focusStop(runtime)
    expect(stopped.message).toBe('Focus block stopped after 12 min. Rhythm is off.')
    expect(h.ourHold()).toBeNull()
    expect(runtime.day).toMatchObject({ stoppedBlocks: 1, focusMinutes: 0 })
    expect(stopped.state.focus).toMatchObject({ phase: 'idle', lastRun: { startedAt: NINE, endedAt: NINE + 12 * MIN } })
    expect(h.notices()).toHaveLength(0)
  })
})

describe('the Start form: lengths and music', () => {
  const DEEP = 'spotify:playlist:37i9dQZF1DWZeKCadgRdKQ'
  const spotifyScripts = (h: ReturnType<typeof makeHarness>) => h.runs.filter((run) => run.command === 'osascript').map((run) => run.args[1])

  it('remember keeps the picked lengths as the settings; a plain start (an agent) leaves them', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 10 })
    expect(await h.fake.api.config.get()).toEqual({})
    await actions.focusStop(runtime)
    const started = await actions.focusStart(runtime, { minutes: 50, breakMinutes: 10, remember: true })
    expect(started.message).toBe('Focus block started: 50 min, then a 10 min break.')
    expect(await h.fake.api.config.get()).toEqual({ focus_minutes: 50, break_minutes: 10 })
    // Applied at once: the off ring's Start and the next default already say 50.
    expect(runtime.config).toMatchObject({ focusMinutes: 50, breakMinutes: 10 })
    await h.tick(runtime, 50 * MIN + 1)
    expect(runtime.focus).toMatchObject({ phase: 'break', endsAt: NINE + 60 * MIN })
    expect(h.notices('focus-done')[0]!.notice.title).toBe('Focus block done, 10 min break')
    // Out of the settings' range (a 3 min block) is still a block, but never the default.
    await actions.focusStop(runtime)
    await actions.focusStart(runtime, { minutes: 3, breakMinutes: 10, remember: true })
    expect(await h.fake.api.config.get()).toEqual({ focus_minutes: 50, break_minutes: 10 })
  })

  it('the next-block buttons repeat the length, the break and the playlist', async () => {
    const { h, runtime } = await boot({ darwin: true, tasks: [task('task-7', 'Draft the plan')] })
    await actions.focusStart(runtime, { taskId: 'task-7', minutes: 30, breakMinutes: 8, spotify: DEEP })
    await h.tick(runtime, 30 * MIN + 1)
    expect(h.notices('focus-done')[0]!.notice.actions![1]).toEqual({ label: 'Another block', op: 'focus_start', args: { spotify: DEEP, taskId: 'task-7', minutes: 30, breakMinutes: 8 } })
    await h.tick(runtime, 8 * MIN)
    expect(h.notices('break-over')[0]!.notice.actions![0]).toEqual({ label: 'Start next block', op: 'focus_start', args: { spotify: DEEP, taskId: 'task-7', minutes: 30, breakMinutes: 8 } })
  })

  it('a Spotify playlist plays with the block and pauses at its end and on Stop', async () => {
    const { h, runtime } = await boot({ darwin: true })
    const started = await actions.focusStart(runtime, { spotify: 'https://open.spotify.com/playlist/37i9dQZF1DWZeKCadgRdKQ?si=abc123' })
    expect(started.message).toBe('Focus block started: 25 min, then a 5 min break. Spotify is playing Deep Focus on this Mac.')
    expect(started.spotifyError).toBeUndefined()
    expect(spotifyScripts(h)).toEqual([`tell application "Spotify" to play track "${DEEP}"`, 'tell application "Spotify" to player state as string'])
    await h.tick(runtime, 25 * MIN + 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spotifyScripts(h).at(-1)).toBe('if application "Spotify" is running then tell application "Spotify" to pause')
    // Stop during a block pauses too; a block without Spotify never touches it.
    await actions.breakSkip(runtime)
    await actions.focusStart(runtime, { spotify: DEEP })
    const before = spotifyScripts(h).length
    await actions.focusStop(runtime)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spotifyScripts(h).slice(before)).toEqual(['if application "Spotify" is running then tell application "Spotify" to pause'])
    await actions.focusStart(runtime, {})
    await actions.focusStop(runtime)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spotifyScripts(h).length).toBe(before + 1)
  })

  it('Spotify missing, refused or silent: the block still runs and the answer says why', async () => {
    const missing = await boot({ darwin: true, spotifyInstalled: false })
    const one = await actions.focusStart(missing.runtime, { spotify: DEEP })
    expect(one.state.focus.phase).toBe('focus')
    expect(one.spotifyError).toBe('Spotify is not installed on this Mac. Install it and sign in to play a playlist with a block.')
    expect(missing.h.runs.filter((run) => run.command === 'osascript')).toEqual([])

    const refused = await boot({ darwin: true, runner: async () => ({ ok: false, code: 1, stdout: '', stderr: '', error: 'execution error: Not authorized to send Apple events to Spotify. (-1743)' }) })
    const two = await actions.focusStart(refused.runtime, { spotify: DEEP })
    expect(two.spotifyError).toMatch(/^macOS has not allowed Walnut to control Spotify/)

    const silent = await boot({ darwin: true, runner: async () => ({ ok: true, code: 0, stdout: 'paused\n', stderr: '' }) })
    const three = await actions.focusStart(silent.runtime, { spotify: DEEP })
    expect(three.spotifyError).toMatch(/^Spotify did not start playing/)

    const notMac = await boot({ darwin: false })
    expect((await actions.focusStart(notMac.runtime, { spotify: DEEP })).spotifyError).toBe('Spotify plays on a Mac only.')
  })

  it('Spotify follows the block it played for: a Stop while it opens, a play that failed, a block end caught up late', async () => {
    // Stop lands while Spotify is still opening: its pause runs first, so the play is paused once it lands.
    let release: () => void = () => undefined
    const scripts: string[] = []
    const slow = await boot({
      darwin: true,
      runner: async (command, args) => {
        const script = String(args.at(-1))
        scripts.push(script)
        if (script.includes('play track')) await new Promise<void>((resolve) => { release = resolve })
        return { ok: true, code: 0, stdout: script.includes('player state') ? 'playing\n' : '', stderr: '' }
      },
    })
    const starting = actions.focusStart(slow.runtime, { spotify: DEEP })
    while (!scripts.some((one) => one.includes('play track'))) await new Promise((resolve) => setTimeout(resolve, 0))
    await actions.focusStop(slow.runtime)
    release()
    await starting
    expect(slow.runtime.focus.phase).toBe('idle')
    expect(scripts.at(-1)).toBe('if application "Spotify" is running then tell application "Spotify" to pause')

    // A play that failed is not the block's: its end leaves Spotify alone.
    const failed: string[] = []
    const refused = await boot({
      darwin: true,
      runner: async (_command, args) => {
        failed.push(String(args.at(-1)))
        return { ok: false, code: 1, stdout: '', stderr: '', error: 'Not authorized to send Apple events to Spotify. (-1743)' }
      },
    })
    await actions.focusStart(refused.runtime, { spotify: DEEP })
    expect(refused.runtime.focus.spotifyUri).toBeUndefined()
    await refused.h.tick(refused.runtime, 25 * MIN + 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(failed.filter((one) => one.includes('pause'))).toEqual([])

    // The Mac slept through the block's end: hours later the music playing is the person's own.
    const { h, runtime } = await boot({ darwin: true })
    await actions.focusStart(runtime, { spotify: DEEP })
    await h.tick(runtime, 3 * 60 * MIN)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spotifyScripts(h).filter((one) => one.includes('pause'))).toEqual([])
  })

  it('the start message names the long break when this block earns it', async () => {
    const { runtime } = await boot()
    runtime.focus = { ...runtime.focus, completedInCycle: runtime.config.longBreakEvery - 1 }
    const started = await actions.focusStart(runtime, { minutes: 30, breakMinutes: 7 })
    expect(started.message).toBe(`Focus block started: 30 min, then the ${runtime.config.longBreakMinutes} min long break.`)
  })

  it('refuses a link that is not Spotify before anything starts, and never puts it in a script', async () => {
    const { h, runtime } = await boot({ darwin: true })
    for (const bad of ['https://evil.example/playlist/37i9dQZF1DWZeKCadgRdKQ', 'spotify:playlist:x" & do shell script "touch /tmp/p', 'not a link']) {
      await expect(actions.focusStart(runtime, { spotify: bad })).rejects.toThrow(/not a Spotify link/)
    }
    expect(runtime.focus.phase).toBe('idle')
    expect(h.runs).toEqual([])
  })

  it('keeps the playlists: Deep Focus first, add by link with its name from Spotify, remove', async () => {
    const { h, runtime } = await boot({ darwin: true })
    const fetch = vi.spyOn(h.fake.api.http, 'fetch').mockResolvedValue({ ok: true, status: 200, headers: {}, text: async () => '', json: async () => ({ title: 'Lofi Beats' }) } as never)
    expect((await actions.musicTracks(runtime, { readdir: async () => [], stat: async () => ({ size: 0, isFile: false }) })).spotify)
      .toEqual({ available: true, playlists: [{ uri: DEEP, name: 'Deep Focus' }] })
    const added = await actions.spotifyPlaylistAdd(runtime, { link: 'https://open.spotify.com/intl-de/playlist/0vvXsWCC9xrXsKd4FyS8kM?si=1' })
    expect(fetch).toHaveBeenCalledWith('https://open.spotify.com/oembed?url=https%3A%2F%2Fopen.spotify.com%2Fplaylist%2F0vvXsWCC9xrXsKd4FyS8kM', { timeoutMs: 5000 })
    expect(added.spotify.playlists).toEqual([{ uri: DEEP, name: 'Deep Focus' }, { uri: 'spotify:playlist:0vvXsWCC9xrXsKd4FyS8kM', name: 'Lofi Beats' }])
    fetch.mockRejectedValue(new Error('offline'))
    const named = await actions.spotifyPlaylistAdd(runtime, { link: 'spotify:album:1A2GTWGtFfWp7KSQTwWOyo' })
    expect(named.spotify.playlists.at(-1)).toEqual({ uri: 'spotify:album:1A2GTWGtFfWp7KSQTwWOyo', name: 'Spotify playlist' })
    const removed = await actions.spotifyPlaylistRemove(runtime, { uri: DEEP })
    expect(removed.spotify.playlists.map((one) => one.uri)).not.toContain(DEEP)
    await expect(actions.spotifyPlaylistAdd(runtime, { link: 'https://example.com' })).rejects.toThrow(/not a Spotify link/)
  })
})

describe('quiet mode and the macOS Focus mirror', () => {
  it('keeps one hold that is the union of a focus block and a macOS Focus', async () => {
    let focus: MacosFocusRead = { ok: true, focus: { active: true, modeId: 'x', name: 'Deep Work' } }
    const { h, runtime } = await boot({ darwin: true, macosFocus: () => focus })
    expect(h.ourHold()).toMatchObject({ reason: 'macOS Focus: Deep Work' })
    expect(h.ourHold()?.until).toBeUndefined()

    await actions.focusStart(runtime, {})
    expect(h.ourHold()).toMatchObject({ reason: 'Focus block, macOS Focus: Deep Work' })
    expect(h.ourHold()?.until).toBeUndefined()

    await h.tick(runtime, 25 * MIN + 1)
    expect(h.ourHold()).toMatchObject({ reason: 'macOS Focus: Deep Work' })
    // The hold dropped the block's part BEFORE the block-done notice went out.
    const union = h.calls.findIndex((call) => call.type === 'quiet.set' && call.input.reason === 'Focus block, macOS Focus: Deep Work')
    const narrowed = h.calls.findIndex((call, i) => i > union && call.type === 'quiet.set' && call.input.reason === 'macOS Focus: Deep Work')
    const announced = h.calls.findIndex((call) => call.type === 'notify' && call.notice.dedupKey === 'focus-done')
    expect(union).toBeGreaterThan(-1)
    expect(narrowed).toBeGreaterThan(-1)
    expect(narrowed).toBeLessThan(announced)

    focus = { ok: true, focus: { active: false } }
    await h.tick(runtime, 30_000)
    expect(h.ourHold()).toBeNull()
    // Nothing is re-sent while nothing changes.
    const quietCalls = h.calls.filter((call) => call.type.startsWith('quiet')).length
    await h.tick(runtime, 30_000)
    expect(h.calls.filter((call) => call.type.startsWith('quiet')).length).toBe(quietCalls)
  })

  it('a refused Focus read is reported once and backs off; mirror off never reads', async () => {
    let reads = 0
    const { h, runtime } = await boot({ darwin: true, macosFocus: () => { reads++; return { ok: false, reason: 'permission', message: 'denied' } } })
    expect(runtime.macos.mirror).toMatchObject({ phase: 'unavailable', error: 'denied' })
    await h.tick(runtime, 60_000)
    expect(reads).toBe(1)
    await h.tick(runtime, 10 * MIN)
    expect(reads).toBe(2)
    runtime.applyConfig({ mirror_macos_focus: false })
    await h.tick(runtime, 11 * MIN)
    expect(reads).toBe(2)
    expect(runtime.macos.mirror.phase).toBe('off')
  })

  it('a macOS Focus starts nothing, and the drive shortcuts follow the block', async () => {
    const { h, runtime } = await boot({
      darwin: true,
      config: { macos_focus_shortcuts: true },
      macosFocus: () => ({ ok: true, focus: { active: true, name: 'Work' } }),
    })
    await h.tick(runtime, 65 * MIN)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.notices()).toHaveLength(0)

    await actions.focusStart(runtime, {})
    await h.tick(runtime, 25 * MIN + 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shortcutRuns = h.runs.filter((run) => run.command === 'shortcuts' && run.args[0] === 'run').map((run) => run.args[1])
    expect(shortcutRuns).toEqual(['Walnut Focus On', 'Walnut Focus Off'])
  })

  it('the Do Not Disturb that a block turned on never silences the block\'s own notice', async () => {
    // The mirror keeps reading "on": the real file lags the shortcut by seconds and the
    // poll by up to 25s. That hold used to outlive the block and swallow its toast.
    let macosSaysOn = false
    const { h, runtime } = await boot({
      darwin: true,
      config: { macos_focus_shortcuts: true },
      macosFocus: () => (macosSaysOn ? { ok: true, focus: { active: true, name: 'Do Not Disturb' } } : { ok: true, focus: { active: false } }),
    })
    await actions.focusStart(runtime, {})
    macosSaysOn = true
    await h.tick(runtime, 30_000)
    expect(h.ourHold()).toMatchObject({ reason: 'Focus block, macOS Focus: Do Not Disturb' })

    await h.tick(runtime, 25 * MIN)
    const prompt = h.calls.findIndex((call) => call.type === 'notify' && call.notice.dedupKey === 'focus-done')
    const released = h.calls.findIndex((call) => call.type === 'quiet.clear')
    expect(prompt).toBeGreaterThan(-1)
    expect(released).toBeGreaterThan(-1)
    expect(released).toBeLessThan(prompt)
    expect(h.ourHold()).toBeNull()

    // macOS really did stay on (the shortcut failed, say): after the grace the mirror wins again.
    await h.tick(runtime, 2 * MIN)
    expect(h.ourHold()).toMatchObject({ reason: 'macOS Focus: Do Not Disturb' })
  })
})

describe('restarts', () => {
  it('a running focus block survives a restart and still ends on time', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 20 })
    await runtime.persist()
    h.clock.t = NINE + 5 * MIN
    const again = h.build()
    await again.load()
    expect(again.focus).toMatchObject({ phase: 'focus', endsAt: NINE + 20 * MIN, runStartedAt: NINE })
    await h.tick(again, 15 * MIN)
    expect(h.notices('focus-done')).toHaveLength(1)
    expect(again.focus.phase).toBe('break')
  })

  it('an older version\'s state: its stand-up streak is dropped, its notices withdrawn, a waiting break becomes a running one', async () => {
    const h = makeHarness({ start: NINE + 27 * MIN })
    await h.fake.api.storage.writeJson('state.json', {
      version: 1,
      presence: { streakStartedAt: NINE - 60 * MIN, lastActiveAt: NINE + 26 * MIN },
      reminder: { streakKey: NINE - 60 * MIN, nextDueAt: null, snoozedUntil: null, deferStartedAt: null, outstanding: true, firedAt: NINE },
      focus: { phase: 'break_due', minutes: 25, startedAt: NINE + 25 * MIN, endsAt: NINE + 55 * MIN, completedInCycle: 1, breakKind: 'short', lastEndedAt: NINE + 25 * MIN },
    })
    const runtime = h.build()
    await runtime.load()
    await runtime.kick()
    expect(h.calls).toContainEqual({ type: 'dismiss', key: 'stand-up' })
    expect(h.calls).toContainEqual({ type: 'dismiss', key: 'focus-done' })
    expect(runtime.focus).toMatchObject({ phase: 'break', startedAt: NINE + 25 * MIN, endsAt: NINE + 30 * MIN, runStartedAt: NINE })
    const stored = await h.fake.api.storage.readJson<Record<string, unknown>>('state.json', {})
    expect(Object.keys(stored).sort()).toEqual(['focus', 'version'])
    await h.tick(runtime, 3 * MIN + 1)
    expect(runtime.focus.phase).toBe('idle')
    expect(h.notices('break-over')).toHaveLength(1)
  })

  it('the day log is written to days/<date>.json', async () => {
    const { h, runtime } = await boot()
    await actions.focusStart(runtime, { minutes: 10 })
    await h.tick(runtime, 10 * MIN + 1)
    const files = await h.fake.api.storage.list('days/')
    expect(files).toEqual(['days/2026-09-25.json'])
    expect(await h.fake.api.storage.readJson('days/2026-09-25.json', null)).toMatchObject({ focusMinutes: 10, focusBreaks: 1 })
  })
})
