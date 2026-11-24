/**
 * What the person at a host-judge cluster's Mac does, and what the e2e files read of it
 * (host-judge-cluster.ts): the switch, a send, a stop, a legacy start, and the reads of a session on
 * the Mac. One set for every file that drives the Mac this way (the legacy resume ones, the restart
 * in a hand-over's window). `get` gives the cluster once it runs (a beforeAll sets it).
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { expect } from 'vitest'
import { HOST_KEY, waitFor } from './replica-cluster.js'
import { turnsWith } from './replica-cluster-reads.js'
import type { HostJudgeCluster, ProbeEvent } from './host-judge-cluster.js'

export function hostJudgeSteps(get: () => HostJudgeCluster) {
  const say = (why: string) => `${why}\n--- mac ---\n${get().macLog().slice(-8000)}\n--- replica ---\n${get().c.logs().replica.slice(-8000)}`
  const fail = (err: unknown): never => { throw new Error(say(String(err))) }
  const macEvents = async (s: string): Promise<ProbeEvent[]> => (await get().mac(`/events?sid=${s}`)) as ProbeEvent[]
  const channelEvents = async (s: string) => (await macEvents(s)).filter((e) => e.source === 'host-channel')
  const resultsOn = (events: ProbeEvent[], text: string) => events.filter((e) => e.name === 'session:result' && String(e.data?.result ?? '').includes(text))
  const macRow = async (s: string) => { const r = await get().c.mac('GET', `/api/sessions/${s}`); return r.status === 200 ? (r.json.session ?? r.json) as Record<string, any> : null }
  const parses = async (s: string): Promise<number> => (await get().mac(`/parses?sid=${s}`)).parses as number
  const handover = async (s: string) => (await get().mac(`/handover?sid=${s}`)) as { pending: boolean; onDisk: boolean | null }
  /** The live mock CLI of `s` on this machine: its command line (null: none runs). */
  const cliArgs = (s: string): string | null => {
    let ps = ''
    try { ps = execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8', maxBuffer: 64 << 20 }) } catch { return null }
    const mock = path.join(get().c.base, 'bin', 'mock-claude.cjs')
    return ps.split('\n').find((l) => l.includes(mock) && l.includes(s)) ?? null
  }
  const setSwitch = async (on: boolean) => {
    const r = await get().c.mac('PUT', '/api/config', { experimental: { host_runs_sessions: on } })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    // Held for two seconds: a host report read just before the write can set the old value again for
    // a moment (leader-side.ts noteHost reads the switch too).
    let since = 0
    await waitFor(async () => {
      if ((await get().mac(`/side?host=${HOST_KEY}`)).judges !== on) { since = 0; return false }
      since ||= Date.now()
      return Date.now() - since >= 2_000
    }, 60_000, `the Mac to ${on ? 'hand' : 'stop handing'} starts to the host`, 200).catch(fail)
  }
  const send = async (s: string, text: string) => {
    const r = await get().c.mac('POST', `/api/v1/sessions/${s}/messages`, { text })
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
  }
  /** A native session stopped and at rest: no CLI of it on the machine, and the Mac's runner holds no live process of it. */
  const stop = async (s: string) => {
    const r = await get().c.mac('POST', `/api/v1/sessions/${s}/terminate`, { force: true })
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
    await waitFor(async () => (await macRow(s))?.process_status === 'stopped' && !cliArgs(s) && !(await get().mac(`/holds?sid=${s}`)).live, 60_000, `session ${s} to stop and its CLI to end`).catch(fail)
  }
  /** A native session started on the host the legacy way (the switch off), answered: its id. */
  const startLegacy = async (title: string, message: string, cwd: string): Promise<string> => {
    const t = await get().c.mac('POST', '/api/tasks', { title, project: 'Acme' })
    expect(t.status, JSON.stringify(t.json)).toBe(201)
    const st = await get().c.mac('POST', `/api/v1/tasks/${t.json.task.id}/start`, { host: HOST_KEY, cwd, mode: 'bypass', message })
    expect(st.status, JSON.stringify(st.json)).toBe(202)
    const sid = st.json.sessionId as string
    await waitFor(() => turnsWith(get().c, sid, message) > 0, 120_000, `the legacy session ${title} to answer`).catch(fail)
    expect(await get().mac(`/judge?sid=${sid}`)).toEqual({ judge: 'legacy', host: null })
    return sid
  }
  /** No host refused a line of a session it judges, on any Mac leader so far. */
  const noRefusals = () => {
    const mac = get().macLog()
    expect(mac).not.toMatch(/host-run session: its host kept refusing its lines/)
    expect(mac).not.toMatch(/refused the send/)
  }
  return { say, fail, macEvents, channelEvents, resultsOn, macRow, parses, handover, cliArgs, setSwitch, send, stop, startLegacy, noRefusals }
}
