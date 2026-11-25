/**
 * Every check a host ran while no server was there reaches the server when it comes back, on the
 * real standalone daemon (src/providers/trigger-unsent-checks.ts, daemon-trigger-runs.ts
 * reportCheck, daemon-trigger-set.ts replayChecks).
 *
 * The incident (2026-11-25): a trigger on a dev host checked every 30 minutes from 05:09 to
 * 08:40Z while the Mac, the Walnut that records checks, slept. The daemon sent each report only to
 * connected servers; with none it was dropped, and the reconnect replayed only the latest. The
 * record had a four-hour hole and its reader thought the trigger had stopped.
 *
 * What's real: the daemon process (the standalone, under bun), its trigger and state files, a
 * restart, /bin/sh checks on the daemon's own clock. What's faked: the Walnut server is a bare WS
 * client (tests/helpers/trigger-daemon.ts). MACHINE SAFETY: every dir is a temp dir; the helper
 * signals only the daemon groups it started.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { triggerStateFileName, type TriggerHostState } from '../../src/providers/trigger-check-core.js'
import { guardedPath } from '../setup/exec-guard.js'
import { TRIGGER_BUN as BUN, TriggerDaemon, killTriggerDaemons, waitFor } from '../helpers/trigger-daemon.js'

/** The daemon's shortest interval, and its tick: a due check starts on the first tick after its time. */
const EVERY_MS = 10_000
const TICK_MS = 5_000
const ID = 'trg-unsent'
/** Checks run with no server before it comes back. */
const AWAY_CHECKS = 3

const base = BUN ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-trig-unsent-'))) : ''
afterAll(() => { if (base.includes('walnut-trig-unsent-')) fs.rmSync(base, { recursive: true, force: true }) })
afterEach(() => killTriggerDaemons())

type Ev = Record<string, any>

describe.skipIf(!BUN)('checks run with no server are all reported when one comes back (real daemon)', () => {
  const dir = (n: string) => path.join(base, n)
  for (const n of ['h', 'tmp']) if (BUN) fs.mkdirSync(dir(n), { recursive: true })
  const HOME = dir('h')
  const env: Record<string, string> = {
    HOME, PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: dir('tmp'), LANG: 'C', SHELL: '/bin/sh',
    WALNUT_DAEMON_DIR: dir('run'), WALNUT_TRIGGER_STATE_DIR: dir('durable'),
    WALNUT_STREAMS_DIR: dir('st'), WALNUT_LEGACY_STREAMS_DIR: dir('ls'), WALNUT_SPAWN_JOURNAL: dir('sj.jsonl'),
    WALNUT_JOURNAL_DIR: dir('j'), WALNUT_TASK_DIR_ROOT: dir('tasks'), WALNUT_TRIGGER_REPLAY_MS: '600000',
    // The daemon ends with this test process, whatever happens to the test.
    WALNUT_DAEMON_PARENT_PID: String(process.pid),
    XDG_STATE_HOME: path.join(HOME, '.local', 'state'), XDG_CONFIG_HOME: path.join(HOME, '.config'),
    XDG_CACHE_HOME: path.join(HOME, '.cache'), XDG_DATA_HOME: path.join(HOME, '.local', 'share'),
  }
  const check = dir('check.sh')
  if (BUN) fs.writeFileSync(check, `echo run >> "${dir('runs.log')}"\nprintf '{"fire":false}\\n'\n`)
  const triggers = [{ id: ID, name: 'Build watch', everyMs: EVERY_MS, check: { run: `sh ${check}`, timeoutSeconds: 10 } }]

  const start = async (): Promise<TriggerDaemon> => {
    const d = await TriggerDaemon.start('standalone', { mode: '--start', env, runDir: dir('run'), cwd: HOME })
    expect((await d.rpc({ cmd: 'hello' })).capabilities as string[]).toContain('triggers-v1')
    return d
  }
  /** A server's push; the configure reply goes before its replays, so a hello after it orders them all. */
  const configure = async (d: TriggerDaemon, replayChecks: boolean) => {
    const reply = await d.rpc({ cmd: 'triggers.configure', config: { version: 1, triggers }, ...(replayChecks ? { replayChecks: true } : {}) })
    expect(reply).toMatchObject({ ok: true, applied: true, count: 1 })
    await d.rpc({ cmd: 'hello' })
  }
  const statePath = () => path.join(dir('durable'), triggerStateFileName(ID))
  const stateOf = (): TriggerHostState => JSON.parse(fs.readFileSync(statePath(), 'utf8')) as TriggerHostState
  /** For a wait: a file mid-write reads as not there yet. */
  const stateNow = (): Partial<TriggerHostState> => { try { return stateOf() } catch { return {} } }
  const replaysAfter = (d: TriggerDaemon, mark: number): Ev[] => d.events.slice(mark).filter((e) => e.ev === 'trigger.checked' && e.id === ID && e.replay === true)
  const liveAfter = (d: TriggerDaemon, mark: number): Ev[] => d.events.slice(mark).filter((e) => e.ev === 'trigger.checked' && e.id === ID && e.replay !== true)

  it('a live check keeps nothing; checks with no server are kept, sent oldest first on the configure that asks, then the latest, and never again', async () => {
    let d = await start()
    await configure(d, false)

    // With a server here, a check goes to it live and nothing is kept.
    const live = await waitFor(() => liveAfter(d, 0)[0], EVERY_MS + TICK_MS + 10_000, 'a live check')
    expect(live).toMatchObject({ outcome: 'quiet', reason: 'fire-false' })
    await waitFor(() => (stateNow().lastCheck?.atMs === live.atMs ? true : undefined), 5_000, 'the live check in the state file')
    expect(stateOf().unsentChecks, 'a delivered check is not kept').toBeUndefined()

    // The server goes away; the daemon keeps checking on its own clock.
    await d.disconnect()
    const goneAt = Date.now()
    const keptState = await waitFor(() => {
      const s = stateNow()
      return (s.unsentChecks?.length ?? 0) >= AWAY_CHECKS ? s : undefined
    }, AWAY_CHECKS * EVERY_MS + TICK_MS + 20_000, `${AWAY_CHECKS} checks kept with no server`)
    const kept = keptState.unsentChecks!.map((c) => c.atMs)
    expect([...kept].sort((a, b) => a - b), 'kept oldest first').toEqual(kept)
    expect(new Set(kept).size).toBe(kept.length)
    expect(kept[0]!, 'each ran after the server left').toBeGreaterThan(live.atMs)
    for (const c of keptState.unsentChecks!) expect(c).toMatchObject({ type: 'trigger.checked', id: ID, outcome: 'quiet', reason: 'fire-false' })
    expect(keptState.lastCheck?.atMs, 'the latest is the newest kept').toBe(kept.at(-1))
    expect(kept.at(-1)! - goneAt).toBeGreaterThan(0)

    // A server comes back and asks for the checks it missed.
    await d.reconnect()
    const mark = d.events.length
    await d.rpc({ cmd: 'hello' })
    await configure(d, true)
    const got = replaysAfter(d, mark).map((e) => e.atMs as number)
    // Every one kept, oldest first (more may have been kept since the read above), then the latest.
    expect(got.slice(0, kept.length), 'every check made while no server was here, oldest first').toEqual(kept)
    const unsentSent = got.slice(0, -1)
    expect([...unsentSent].sort((a, b) => a - b)).toEqual(unsentSent)
    expect(new Set(unsentSent).size, 'none twice').toBe(unsentSent.length)
    expect(got.at(-1)!, 'then the latest check').toBeGreaterThanOrEqual(kept.at(-1)!)
    for (const e of replaysAfter(d, mark)) expect(e).toMatchObject({ outcome: 'quiet', reason: 'fire-false', nextRunAtMs: expect.any(Number) })
    // Handed on: cleared in the state file.
    await waitFor(() => (stateNow().unsentChecks === undefined && stateNow().lastCheck ? true : undefined), 5_000, 'the kept checks cleared on disk')

    // A second configure sends only the latest again, none of those kept.
    const mark2 = d.events.length
    await configure(d, true)
    const again = replaysAfter(d, mark2)
    expect(again, 'only the latest check').toHaveLength(1)
    expect(unsentSent.slice(0, -1)).not.toContain(again[0]!.atMs)

    // While the server is here, the next check is live and nothing is kept.
    const next = await waitFor(() => liveAfter(d, mark2)[0], EVERY_MS + TICK_MS + 10_000, 'a live check after the return')
    expect(next.atMs).toBeGreaterThan(kept.at(-1)!)
    await waitFor(() => ((stateNow().lastCheck?.atMs ?? 0) >= next.atMs ? true : undefined), 5_000, 'that check in the state file')
    expect(stateOf().unsentChecks).toBeUndefined()

    // A restart reads the file: nothing kept comes back.
    await d.stop()
    expect(stateOf().unsentChecks, 'cleared on disk').toBeUndefined()
    d = await start()
    const mark3 = d.events.length
    await configure(d, true)
    const afterRestart = replaysAfter(d, mark3)
    expect(afterRestart.length, 'only the latest check').toBe(1)
    expect(unsentSent).not.toContain(afterRestart[0]!.atMs)
    await d.stop()
  }, 150_000)
})
