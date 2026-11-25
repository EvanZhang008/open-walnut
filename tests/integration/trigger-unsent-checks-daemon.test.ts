/**
 * Every check a host ran while no server was there reaches the server when it comes back, on the
 * real standalone daemon (src/providers/trigger-unsent-checks.ts, daemon-trigger-runs.ts
 * reportCheck, daemon-trigger-set.ts replayChecks).
 *
 * The incident (2026-11-25): a trigger on a dev host checked every 30 minutes from 05:09 to
 * 08:40Z while the Mac, the Walnut that records checks, slept. The daemon sent each report only to
 * connected servers; with none it was dropped, and the reconnect replayed only the latest. The
 * record had a four-hour hole and its reader thought the trigger had stopped. Then, 18:12 to
 * 19:25Z with the Mac's lid shut, every check sent into a socket the Mac left open but silent after a
 * dark wake, and the configure replay of 19:22:07 ten seconds before it slept again, were lost: a
 * report on the wire counted as read. Each report now stays kept until its socket is heard a beat
 * later (trigger-unsent-checks.ts settleChecksOnWire).
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
/** The daemon's beat here: it pings each server socket once a beat (a pong to one sent after a report: read); silent 8 beats, it is closed. */
const BEAT_MS = 2_000

const base = BUN ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-trig-unsent-'))) : ''
afterAll(() => { if (base.includes('walnut-trig-unsent-')) fs.rmSync(base, { recursive: true, force: true }) })
afterEach(() => killTriggerDaemons())

type Ev = Record<string, any>
const times = (list: Array<{ atMs: number }> | undefined) => (list ?? []).map((c) => c.atMs)

describe.skipIf(!BUN)('checks run with no server are all reported when one comes back (real daemon)', () => {
  const dir = (n: string) => path.join(base, n)
  for (const n of ['h', 'tmp']) if (BUN) fs.mkdirSync(dir(n), { recursive: true })
  const HOME = dir('h')
  const env: Record<string, string> = {
    HOME, PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: dir('tmp'), LANG: 'C', SHELL: '/bin/sh',
    WALNUT_DAEMON_DIR: dir('run'), WALNUT_TRIGGER_STATE_DIR: dir('durable'),
    WALNUT_STREAMS_DIR: dir('st'), WALNUT_LEGACY_STREAMS_DIR: dir('ls'), WALNUT_SPAWN_JOURNAL: dir('sj.jsonl'),
    WALNUT_JOURNAL_DIR: dir('j'), WALNUT_TASK_DIR_ROOT: dir('tasks'), WALNUT_TRIGGER_REPLAY_MS: '600000', WALNUT_TRUSTED_CLIENT_BEAT_MS: String(BEAT_MS),
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

  /** Nothing kept, once the server read what it was sent: a beat after the send, it answered a ping. */
  const keptCleared = async (d: TriggerDaemon, what: string) => {
    // The daemon drops what was read at once and writes its file with the next run.
    await waitFor(() => (stateNow().lastCheck && stateNow().unsentChecks === undefined ? true : undefined), 2 * BEAT_MS + EVERY_MS + TICK_MS + 5_000, what)
    void d
  }

  it('a live check is kept only until read; checks with no server are kept, sent oldest first on the configure that asks, then the latest, and never again', async () => {
    let d = await start()
    await configure(d, false)

    // With a server here, a check goes to it live and nothing is kept.
    const live = await waitFor(() => liveAfter(d, 0)[0], EVERY_MS + TICK_MS + 10_000, 'a live check')
    expect(live).toMatchObject({ outcome: 'quiet', reason: 'fire-false' })
    await waitFor(() => (stateNow().lastCheck?.atMs === live.atMs ? true : undefined), 5_000, 'the live check in the state file')
    await keptCleared(d, 'a check the server read is not kept')

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
    // Read (the server answered a ping a beat later): cleared in the state file.
    await keptCleared(d, 'the kept checks cleared on disk')

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
    await keptCleared(d, 'that check read')

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

  it('checks sent into a socket left open but silent (a Mac asleep) are kept and reach the server when it is back', async () => {
    fs.rmSync(dir('durable'), { recursive: true, force: true })
    const d = await start()
    await configure(d, true)
    const live = await waitFor(() => liveAfter(d, 0)[0], EVERY_MS + TICK_MS + 10_000, 'a live check')
    await keptCleared(d, 'the live check read')

    // The server falls asleep with its socket open: the daemon goes on sending into it.
    d.freeze()
    const frozenAt = Date.now()
    const runs = () => { try { return fs.readFileSync(dir('runs.log'), 'utf8').split('\n').filter(Boolean).length } catch { return 0 } }
    const runsAtFreeze = runs()
    // Three checks while it sleeps: the first goes into the open socket (the daemon closes it only
    // after 8 silent beats, 16 s here), the others find no server.
    await waitFor(() => (runs() >= runsAtFreeze + 3 && (stateNow().unsentChecks?.length ?? 0) >= 3 ? true : undefined),
      3 * EVERY_MS + TICK_MS + 15_000, 'three checks while the server slept')
    const ranAsleep = runs() - runsAtFreeze

    // Back: a new socket and its configure; the kept ones go first, then the latest.
    await d.reconnect()
    const mark = d.events.length
    await configure(d, true)
    const got = [...new Set(replaysAfter(d, mark).map((e) => e.atMs as number).filter((t) => t > frozenAt))]
    // Every check that ran while it slept reaches the server, the one sent into the silent socket too.
    expect(got.length, `${ranAsleep} checks ran while the server slept; each reaches it once it is back`).toBeGreaterThanOrEqual(ranAsleep)
    expect(got.every((t) => t > live.atMs)).toBe(true)
    await keptCleared(d, 'read once the server answers a beat later')
    await d.stop()
  }, 120_000)

  it('a configure replay the server never read (it slept again at once, the 19:22:07 case) is sent again on the next one', async () => {
    fs.rmSync(dir('durable'), { recursive: true, force: true })
    const d = await start()
    await configure(d, true)
    await waitFor(() => liveAfter(d, 0)[0], EVERY_MS + TICK_MS + 10_000, 'a live check')
    await d.disconnect()
    const goneAt = Date.now()
    await waitFor(() => ((stateNow().unsentChecks ?? []).filter((c) => c.atMs > goneAt).length >= 2 ? true : undefined), 2 * EVERY_MS + TICK_MS + 15_000, 'two checks with no server')

    // A dark wake: the server connects, sends its configure and falls asleep before reading a thing.
    await d.reconnect()
    const ranAway = (stateNow().unsentChecks ?? []).filter((c) => c.atMs > goneAt).map((c) => c.atMs)
    void d.rpc({ cmd: 'triggers.configure', config: { version: 1, triggers }, replayChecks: true }).catch(() => {})
    d.freeze()
    await new Promise((r) => setTimeout(r, 3 * BEAT_MS))
    // Its pings went unanswered: nothing it was sent counts as read.
    for (const t of ranAway) expect(times(stateNow().unsentChecks), 'still kept').toContain(t)

    // Awake for real: the next configure sends each again, and this time it is read.
    await d.reconnect()
    const mark = d.events.length
    await configure(d, true)
    const got = replaysAfter(d, mark).map((e) => e.atMs as number)
    for (const t of ranAway) expect(got, `the check of ${new Date(t).toISOString()} reaches the server`).toContain(t)
    await keptCleared(d, 'read once the server answers a ping')
    await d.stop()
  }, 120_000)
})
