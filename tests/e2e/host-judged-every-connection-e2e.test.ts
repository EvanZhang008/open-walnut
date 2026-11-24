/**
 * Every session feature on every connection (the task's requirement: "every feature holds on every
 * connection: the local machine, an ssh host, and the companion (bridge)"), in one cluster of real
 * processes (tests/helpers/host-judge-cluster.ts with its companion):
 *
 *   C1 local    a session on the Mac's own machine (the Mac is its host: judge 'here', the Mac parses
 *               its lines): start, send, a permission prompt answered, an interrupt, a stop, a resume
 *   C2 ssh      a session on devbox over the Mac's daemon link (the cluster's direct transport, which
 *               stands for the ssh tunnel), run and judged by the host's own service (judge 'host', the
 *               Mac parses none): the same six, every answer a fact the host sent
 *   C3 bridge   the same host session stopped, the Mac away (SIGSTOP): from the phone through the
 *               companion's listener link, a send resumes it on the host, then a prompt answered, an
 *               interrupt, a mode change (the caller's ceiling held), a stop and a resume; a machine
 *               credential reaches none of them
 *
 * The matrix with every cell's test, the cells other files hold included, is
 * tests/core/session-channel/session-features-every-connection.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BUN, HOST_KEY, WINDOWS, waitFor } from '../helpers/replica-cluster.js'
import { hostStream, writeClusterLogs } from '../helpers/replica-cluster-reads.js'
import { startHostJudgeCluster, type HostFactRecord, type HostJudgeCluster, type ProbeEvent } from '../helpers/host-judge-cluster.js'

const RUN = !!BUN && process.platform !== 'win32'

describe.skipIf(!RUN)('every session feature on the local machine, an ssh host and the companion', () => {
  let h: HostJudgeCluster
  let hostCwd = ''
  const sids: { local: string; ssh: string } = { local: '', ssh: '' }

  const macEvents = async (s: string): Promise<ProbeEvent[]> => (await h.mac(`/events?sid=${s}`)) as ProbeEvent[]
  const hostFacts = async (): Promise<{ head: number; recs: HostFactRecord[] }> => h.host('/facts?after=0')
  const say = (why: string) => `${why}\n--- companion ---\n${h.companion?.log().slice(-4000) ?? ''}\n--- mac ---\n${h.c.logs().mac.slice(-6000)}\n--- replica ---\n${h.c.logs().replica.slice(-6000)}`
  const fail = (err: unknown) => { throw new Error(say(String(err))) }
  const macRow = async (sid: string): Promise<Record<string, any> | null> => {
    const r = await h.c.mac('GET', `/api/sessions/${sid}`)
    return r.status === 200 ? (r.json.session ?? r.json) as Record<string, any> : null
  }
  const hostRow = async (sid: string): Promise<Record<string, any> | null> => (await h.host(`/row?sid=${sid}`)).row ?? null

  /** How a connection's answers are read: the local session's on the Mac's own bus, a host's as the facts it sent. */
  const answered = async (kind: 'local' | 'ssh', sid: string, text: string): Promise<number> => {
    if (kind === 'local') return (await macEvents(sid)).filter((e) => e.name === 'session:result' && e.source !== 'host-channel' && String(e.data?.result ?? '').includes(text)).length
    return (await hostFacts()).recs.filter((r) => r.sid === sid && r.name === 'session:result' && String(r.data?.result ?? '').includes(text)).length
  }
  const waitAnswer = (kind: 'local' | 'ssh', sid: string, text: string, what: string) =>
    waitFor(async () => (await answered(kind, sid, text)) > 0, 120_000, what).catch(fail)

  async function startOn(kind: 'local' | 'ssh', title: string, message: string): Promise<string> {
    const t = await h.c.mac('POST', '/api/tasks', { title, project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    // A prompt needs a mode that asks: default.
    const body = kind === 'ssh' ? { host: HOST_KEY, cwd: hostCwd, mode: 'default', message } : { mode: 'default', message }
    const st = await h.c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, body)
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    return st.json.sessionId as string
  }

  /** start, send, prompt, interrupt, stop, resume through the Mac's API, judged where the session runs. */
  async function everyFeature(kind: 'local' | 'ssh', sid: string): Promise<void> {
    // Send.
    const sent = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: `ROUND ${kind} two` })
    expect(sent.status, JSON.stringify(sent.json)).toBeLessThan(300)
    await waitAnswer(kind, sid, `echo: ROUND ${kind} two`, `the ${kind} send's answer`)
    // A permission prompt, seen and answered on the Mac.
    expect((await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: 'please run make check' })).status).toBeLessThan(300)
    const d = await waitFor(async () => { const r = await h.c.mac('GET', `/api/v1/sessions/${sid}`); return r.json.pendingPermissions?.length ? r.json : null }, 90_000, `the ${kind} prompt on the Mac`).catch(fail)
    expect(d.pendingPermissions[0]).toMatchObject({ toolName: 'Bash' })
    const a = await h.c.mac('POST', `/api/v1/sessions/${sid}/permission`, { requestId: d.pendingPermissions[0].requestId, allow: true })
    expect(a.status, JSON.stringify(a.json)).toBe(200)
    expect(a.json).toMatchObject({ status: 'resolved', allow: true })
    await waitAnswer(kind, sid, 'echo: ran make check', `the ${kind} tool to run after the answer`)
    // An interrupt of a running turn.
    const gate = path.join(h.c.base, `never-released-${kind}`)
    expect((await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: `please hold until ${gate}` })).status).toBeLessThan(300)
    await waitFor(async () => (await macRow(sid))?.process_status === 'running', 60_000, `the ${kind} held turn to run`).catch(fail)
    const stop = await h.c.mac('POST', `/api/v1/sessions/${sid}/interrupt`, {})
    expect(stop.status, JSON.stringify(stop.json)).toBe(200)
    expect(stop.json).toMatchObject({ status: 'interrupted', sessionId: sid })
    await waitAnswer(kind, sid, 'echo: interrupted', `the ${kind} held turn to end on the interrupt`)
    expect(fs.existsSync(gate)).toBe(false)
    // A stop, then a send that resumes it.
    const term = await h.c.mac('POST', `/api/v1/sessions/${sid}/terminate`, { force: true })
    expect(term.status, JSON.stringify(term.json)).toBeLessThan(300)
    await waitFor(async () => (await macRow(sid))?.process_status === 'stopped', 60_000, `the ${kind} session to read stopped`).catch(fail)
    if (kind === 'ssh') expect((await hostRow(sid))?.process_status).toBe('stopped')
    // No wait for the stop to settle: the Mac took the host's confirmed stop into its row with the answer.
    expect((await macRow(sid))?.stopRequest?.state, JSON.stringify((await macRow(sid))?.stopRequest)).not.toBe('pending')
    const back = await h.c.mac('POST', `/api/v1/sessions/${sid}/messages`, { text: `ROUND ${kind} back` })
    expect(back.status, JSON.stringify(back.json)).toBeLessThan(300)
    await waitAnswer(kind, sid, `echo: ROUND ${kind} back`, `the ${kind} session's answer after the resume`)
    await waitFor(async () => (await macRow(sid))?.process_status !== 'stopped', 60_000, `the ${kind} session to read alive again`).catch(fail)
  }

  beforeAll(async () => {
    h = await startHostJudgeCluster({ companion: true })
    process.stdout.write(`host-judged-every-connection-e2e: cluster at ${h.c.base}\n`)
    hostCwd = fs.realpathSync(path.join(h.c.base, 'hh', 'work'))
    await waitFor(async () => { const s = await h.mac(`/side?host=${HOST_KEY}`); return s.active && s.linked && s.judges }, 120_000, 'the Mac to link the host\'s session channel').catch(fail)
  }, 900_000)
  afterEach(({ task }) => {
    if (h && (task.result?.state === 'fail' || process.env.HOST_JUDGED_KEEP_LOGS === '1')) {
      const file = writeClusterLogs(h.c, 'every-connection')
      fs.appendFileSync(file, `--- companion ---\n${h.companion?.log() ?? ''}\n`)
      process.stdout.write(`every-connection: logs at ${file}\n`)
    }
  })
  afterAll(async () => { await h?.stop() }, 180_000)

  it('C1 local: the Mac\'s own session is the Mac\'s to run and judge; start, send, prompt, interrupt, stop and resume', async () => {
    sids.local = await startOn('local', 'On the Mac itself', 'ROUND local one')
    await waitAnswer('local', sids.local, 'echo: ROUND local one', 'the local start\'s answer')
    expect(await h.mac(`/judge?sid=${sids.local}`)).toEqual({ judge: 'here', host: null })
    expect((await macRow(sids.local))?.judge).toBeUndefined()
    await everyFeature('local', sids.local)
    // Judged here: the Mac parsed its lines, and the host's channel said nothing of it.
    expect((await h.mac(`/parses?sid=${sids.local}`)).parses).toBeGreaterThan(0)
    expect((await macEvents(sids.local)).filter((e) => e.source === 'host-channel')).toEqual([])
  }, 900_000)

  it('C2 ssh: a session on devbox is its host\'s to run and judge; the same features through the Mac, and the Mac parses none of it', async () => {
    sids.ssh = await startOn('ssh', 'On devbox', 'ROUND ssh one')
    await waitAnswer('ssh', sids.ssh, 'echo: ROUND ssh one', 'the host start\'s answer')
    expect(await h.mac(`/judge?sid=${sids.ssh}`)).toEqual({ judge: 'host', host: HOST_KEY })
    await everyFeature('ssh', sids.ssh)
    expect((await h.mac(`/parses?sid=${sids.ssh}`)).parses).toBe(0)
    expect(hostStream(h.c, sids.ssh).some((l) => l.type === 'result' && String(l.result).includes('echo: ROUND ssh back'))).toBe(true)
  }, 900_000)

  it('C3 bridge: the Mac away, the phone resumes the stopped host session, answers its prompt, interrupts, changes its mode and stops it, all on the host', async () => {
    const sid = sids.ssh
    expect(sid).toBeTruthy()
    const mid = () => `qm-mobile-${crypto.randomBytes(6).toString('hex')}`
    await waitFor(async () => (await h.host('/companion')).linked, 180_000, 'the host to link the companion\'s listener door').catch(fail)
    // Stopped on the Mac first; the phone's own stop comes at the end, the Mac still away.
    const term = await h.c.mac('POST', `/api/v1/sessions/${sid}/terminate`, { force: true })
    expect(term.status, JSON.stringify(term.json)).toBeLessThan(300)
    await waitFor(async () => (await hostRow(sid))?.process_status === 'stopped', 60_000, 'the host session to stop').catch(fail)
    h.c.sleepMac()
    await waitFor(async () => { const r = await h.phone('GET', `/api/v1/sessions/${sid}`); return r.status === 200 && r.json.viaHost === true ? r.json : null }, WINDOWS.takeoverMs + 60_000, 'the companion to answer from the host').catch(fail)
    // Resume: a send to the stopped session starts it again on the host.
    const sent = await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND phone back', messageId: mid() })
    expect(sent.status, JSON.stringify(sent.json)).toBe(202)
    expect(sent.json).toMatchObject({ viaHost: true })
    await waitAnswer('ssh', sid, 'echo: ROUND phone back', 'the phone\'s send to resume the session on the host')
    expect((await hostRow(sid))?.process_status).not.toBe('stopped')
    // A prompt shows on the phone and its answer runs the tool on the host.
    const before = await answered('ssh', sid, 'echo: ran make check')
    expect((await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: 'please run make check', messageId: mid() })).status).toBe(202)
    const d = await waitFor(async () => { const r = await h.phone('GET', `/api/v1/sessions/${sid}`); return r.json.pendingPermissions?.length ? r.json : null }, 90_000, 'the prompt on the phone').catch(fail)
    const a = await h.phone('POST', `/api/v1/sessions/${sid}/permission`, { requestId: d.pendingPermissions[0].requestId, allow: true })
    expect(a.status, JSON.stringify(a.json)).toBe(200)
    expect(a.json).toMatchObject({ status: 'resolved', viaHost: true })
    await waitFor(async () => (await answered('ssh', sid, 'echo: ran make check')) > before, 90_000, 'the host to run the tool').catch(fail)
    // An interrupt of a running turn.
    const gate = path.join(h.c.base, 'never-released-bridge')
    const interruptsBefore = await answered('ssh', sid, 'echo: interrupted')
    expect((await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: `please hold until ${gate}`, messageId: mid() })).status).toBe(202)
    await waitFor(async () => { const r = await h.phone('GET', `/api/v1/sessions/${sid}`); return r.json.session?.process_status === 'running' }, 60_000, 'the held turn to run').catch(fail)
    const stop = await h.phone('POST', `/api/v1/sessions/${sid}/interrupt`, {})
    expect(stop.status, JSON.stringify(stop.json)).toBe(200)
    expect(stop.json).toMatchObject({ status: 'interrupted', viaHost: true })
    await waitFor(async () => (await answered('ssh', sid, 'echo: interrupted')) > interruptsBefore, 60_000, 'the held turn to end on the interrupt').catch(fail)
    await waitFor(async () => (await hostRow(sid))?.process_status !== 'running', 60_000, 'the interrupted turn to end on the host').catch(fail)

    // A machine credential (a host's bridge token) is not a person's device: no stop, no mode change.
    const machine = { token: h.companion!.tokens.otherMachine }
    expect((await h.phone('POST', `/api/v1/sessions/${sid}/terminate`, { force: true }, machine)).status).toBe(401)
    expect((await h.phone('PATCH', `/api/v1/sessions/${sid}`, { mode: 'bypass' }, machine)).status).toBe(401)
    // A session caller is held to its own mode, as on the Mac (delegated-mode.ts modeChangeRefusal):
    // this default-mode session cannot raise anything to bypass through the phone's door.
    const above = await h.phone('PATCH', `/api/v1/sessions/${sid}`, { mode: 'bypass' }, { headers: { 'x-walnut-caller-sid': sid } })
    expect(above.status, JSON.stringify(above.json)).toBe(403)
    expect(above.json.error?.code ?? above.json.code ?? above.json.error).toBe('mode_above_caller')
    expect((await hostRow(sid))?.mode).toBe('default')

    // A mode change: the host keeps it on its own row.
    const mode = await h.phone('PATCH', `/api/v1/sessions/${sid}`, { mode: 'accept' })
    expect(mode.status, JSON.stringify(mode.json)).toBe(200)
    expect(mode.json).toMatchObject({ viaHost: true, session: { claudeSessionId: sid, mode: 'accept' } })
    await waitFor(async () => (await hostRow(sid))?.mode === 'accept', 30_000, 'the host row to keep the mode').catch(fail)

    // A stop, answered once the host stopped it, then a send that resumes it at once.
    const stopped = await h.phone('POST', `/api/v1/sessions/${sid}/terminate`, { force: true })
    expect(stopped.status, JSON.stringify(stopped.json)).toBe(200)
    expect(stopped.json).toMatchObject({ viaHost: true })
    expect((await hostRow(sid))?.process_status).toBe('stopped')
    const again = await h.phone('POST', `/api/v1/sessions/${sid}/messages`, { text: 'ROUND phone again', messageId: mid() })
    expect(again.status, JSON.stringify(again.json)).toBe(202)
    await waitAnswer('ssh', sid, 'echo: ROUND phone again', 'the phone\'s send to resume the session it stopped')
  }, 600_000)
})
