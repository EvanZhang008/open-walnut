/**
 * An engine switch of a session a host runs and judges, every piece a real process: the cluster of
 * tests/helpers/host-judge-cluster.ts. The switch retires the old session on the leader (its
 * `engine_switched:` archive, a leader field: sessions/session-row-owner.ts) and starts the new one
 * on the same host at once; the host judges that start against its own store, which hears of the
 * archive only with the next round of the `sessions` copy. Here that round is held (the probe's
 * /hold-copy), as it lagged in production (2026-11-25: a switch from Claude to Antigravity on a
 * host was refused "already has its active session", the copy's last round 2.5 minutes before).
 * The start carries the leader's rows of the task (session-channel/start-task-rows.ts), so the host
 * judges with the leader's word on them.
 *
 *   S1 acp     Claude to an ACP engine (OpenCode's slot, the scripted adapter; Antigravity's class):
 *              the switch is done, the new session runs on the host and answers, and the host's row
 *              of the old one says it was switched away from
 *   S2 codex   that session to Codex (its direct app-server path, the scripted app-server), the same way
 *   S3 back    Codex back to Claude, the copy still held: the earlier Claude session is resumed with
 *              the turns it missed and answers on the host
 *
 * The cluster's host daemon runs from source and so names no acp-host-v1 (daemon-standalone.ts
 * says it only inside the compiled file), and a switch asks the host's engines first
 * (engine-switch.ts switchHostBlocker): the Mac's boot seeds its answer, as a compiled host gives it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, ROOT, waitFor } from '../helpers/replica-cluster.js'
import { writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

/** The Mac's boot: the host's engines as a compiled host answers them (see the header), kept fresh. */
const HOST_ENGINES = `
{
  const he = await import(${JSON.stringify('file://' + path.join(ROOT, 'src/core/agents/host-engines.ts'))})
  const yes = { installed: true, version: 'test', reason: null }
  const seed = () => he._seedHostEngineCache(${JSON.stringify(HOST_KEY)}, { claude: yes, opencode: yes, codex: yes })
  seed()
  setInterval(seed, 2000).unref()
}
`

describe.skipIf(!RUN)('an engine switch on a host that judges its sessions, its sessions copy lagging', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  let taskId = ''
  let claudeSid = ''
  let acpSid = ''
  let codexSid = ''

  const channelEvents = async (s: string) => ((await h.mac(`/events?sid=${s}`)) as ProbeEvent[]).filter((e) => e.source === 'host-channel')
  const resultOn = (events: ProbeEvent[], text: string) => events.find((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const say = (why: string) => `${why}\n--- mac ---\n${h.c.logs().mac.slice(-8000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`
  const fail = (err: unknown) => { throw new Error(say(String(err))) }
  const hostRow = async (sid: string): Promise<Record<string, any> | null> => (await h.host(`/row?sid=${sid}`)).row ?? null

  /** The switch, answered once it is done (or failed); the session it ended on. */
  async function switchTo(engine: string, message: string): Promise<string> {
    const r = await h.c.mac('POST', `/api/v1/tasks/${taskId}/switch-engine`, { engine, message, wait_ms: 150_000 })
    expect(r.status, say(JSON.stringify(r.json))).toBe(200)
    expect(r.json).toMatchObject({ state: 'done', engine, host: HOST_KEY })
    return r.json.sessionId as string
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster({ macBootExtra: HOST_ENGINES })
    process.stdout.write(`host-judged-engine-switch-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    const t = await h.c.mac('POST', '/api/tasks', { title: 'Engine switch on a host', project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    taskId = t.json.task.id as string
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel').catch(fail)
    const st = await h.c.mac('POST', `/api/v1/tasks/${taskId}/start`, { host: HOST_KEY, cwd: hostCwd, mode: 'bypass', message: 'SWITCH round one' })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    claudeSid = st.json.sessionId as string
    await waitFor(async () => resultOn(await channelEvents(claudeSid), 'echo: SWITCH round one'), 120_000, 'the Claude answer on the Mac').catch(fail)
    // The host's copy of the task's rows stays as it is now: no write brings a sessions round.
    await waitFor(async () => (await hostRow(claudeSid))?.taskId === taskId, 60_000, 'the host\'s row of the Claude session').catch(fail)
    await h.mac('/hold-copy?kind=sessions&on=1')
  }, 900_000)

  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) process.stdout.write(`host-judged-engine-switch: logs at ${writeClusterLogs(h.c, 'host-judged-engine-switch')}\n`)
  })
  afterAll(async () => {
    await h?.mac('/hold-copy?kind=sessions&on=0').catch(() => {})
    await h?.stop()
  }, 120_000)

  it('S1: Claude to an ACP engine starts on the host, its sessions copy held', async () => {
    acpSid = await switchTo('opencode', 'SWITCH to acp')
    expect(acpSid).not.toBe(claudeSid)
    await waitFor(async () => resultOn(await channelEvents(acpSid), 'hello from mock-acp'), 120_000, 'the ACP answer on the Mac').catch(fail)
    expect(await h.mac(`/judge?sid=${acpSid}`)).toEqual({ judge: 'host', host: HOST_KEY })
    // The host took the leader's word on the old row with the start, not from a copy round.
    expect(await hostRow(claudeSid)).toMatchObject({ taskId, archived: true, archive_reason: 'engine_switched:opencode' })
    expect(h.c.logs().replica).not.toContain('already has its active session')
  }, 400_000)

  it('S2: that ACP session to Codex, the same way', async () => {
    expect(acpSid, 'S1 ran').not.toBe('')
    codexSid = await switchTo('codex', 'SWITCH to codex')
    await waitFor(async () => resultOn(await channelEvents(codexSid), 'echo: '), 120_000, 'the Codex answer on the Mac').catch(fail)
    expect(await h.mac(`/judge?sid=${codexSid}`)).toEqual({ judge: 'host', host: HOST_KEY })
    expect(await hostRow(acpSid)).toMatchObject({ taskId, archived: true, archive_reason: 'engine_switched:codex' })
    expect(h.c.logs().replica).not.toContain('already has its active session')
  }, 400_000)

  it('S3: Codex back to Claude resumes the earlier session on the host, the copy still held', async () => {
    expect(codexSid, 'S2 ran').not.toBe('')
    const back = await switchTo('claude', 'SWITCH back to claude')
    const switchLines = () => [...h.c.logs().mac.split('\n'), ...h.c.logs().replica.split('\n')].filter((l) => /engine switch|resum|prefix|history/i.test(l)).slice(-40).join('\n')
    expect(back, switchLines()).toBe(claudeSid)
    await waitFor(async () => resultOn(await channelEvents(claudeSid), 'SWITCH back to claude'), 120_000, 'the resumed Claude answer on the Mac').catch(fail)
    expect(h.c.logs().replica).not.toContain('already has its active session')
    // The Mac's look at cut switches (15 s after its boot, about when these run) left the live ones alone.
    expect(h.c.logs().mac).not.toContain('resuming the earlier session failed')
  }, 400_000)
})
