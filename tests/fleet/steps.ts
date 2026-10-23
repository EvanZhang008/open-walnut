/**
 * The session flows the fleet files share: a task with a session on a host, a turn
 * that writes its task through `walnut tools call task_update` after a delay (so a
 * fault can land mid-turn), and reads of what each side recorded.
 */
import { expect } from 'vitest'
import { waitFor } from '../helpers/replica-cluster.js'
import { HOST_WORK, type Fleet } from './fleet.js'

export interface HostSession { host: string; taskId: string; sid: string }

/** A task on the Mac, in project Acme; its id. */
export async function makeTask(f: Fleet, title: string): Promise<string> {
  const made = await f.mac.call('POST', '/api/tasks', { title, project: 'Acme' })
  expect(made.status, made.text).toBe(201)
  return made.json.task.id as string
}

/** Starts the task's session on `host` with `message` as its first turn; returns once the Mac took the start. */
export async function startSession(f: Fleet, host: string, taskId: string, message: string): Promise<HostSession> {
  const st = await f.mac.call('POST', `/api/v1/tasks/${taskId}/start`, { host, cwd: HOST_WORK, mode: 'default', message })
  expect(st.status, st.text).toBe(202)
  return { host, taskId, sid: st.json.sessionId as string }
}

/** A task on the Mac and a session for it on `host`, whose first turn has answered on the host. */
export async function startHostSession(f: Fleet, host: string, title: string, message: string): Promise<HostSession> {
  const s = await startSession(f, host, await makeTask(f, title), message)
  await waitFor(async () => (await results(f, s, `echo: ${message}`)) > 0, 90_000, `the session on ${host} to answer`)
  // The host answers a session's calls while the Mac is away only once its copy names the
  // session; the Mac pushes that copy with the start (host-slice.ts pushStartingSession).
  await waitFor(() => f.hostSliceHolds(host, s.sid), 10_000, `${host}'s copy to name the session`)
  return s
}

/** How many of the session's turns on the host ended with a reply holding `text`. */
export async function results(f: Fleet, s: HostSession, text: string): Promise<number> {
  return (await f.hostStream(s.host, s.sid)).filter((l) => l.type === 'result' && String(l.result).includes(text)).length
}

/** How many turns of the session the host's CLI has started. */
export const runningTurns = async (f: Fleet, s: HostSession) =>
  (await f.hostStream(s.host, s.sid)).filter((l) => l.type === 'system' && l.subtype === 'session_state_changed' && l.state === 'running').length

/** Sends the update turn and waits until the host's CLI runs it; its write comes `afterS` seconds later. */
export async function startUpdateTurn(f: Fleet, s: HostSession, title: string, afterS: number): Promise<void> {
  const before = await runningTurns(f, s)
  const sent = await f.mac.call('POST', `/api/v1/sessions/${s.sid}/messages`, { text: `please update ${s.taskId} title ${title} after ${afterS}s` })
  expect(sent.status, sent.text).toBe(202)
  await waitFor(async () => (await runningTurns(f, s)) > before, 60_000, `the CLI on ${s.host} to start the update turn`)
}

/** Waits until `n` update turns of the session have ended on the host. */
export async function updateTurnsEnded(f: Fleet, s: HostSession, n: number, timeoutMs = 120_000): Promise<void> {
  await waitFor(async () => (await results(f, s, 'echo: updated')) >= n, timeoutMs, `update turn ${n} to end on ${s.host}`)
}

/** The host journal's task-fields records that set the session task's title to `title`. */
export async function journaledTitle(f: Fleet, s: HostSession, title: string): Promise<Array<Record<string, any>>> {
  return (await f.hostJournal(s.host)).records.filter((r) => r.kind === 'task-fields' && r.taskId === s.taskId && r.fields?.title?.value === title)
}

/** The Mac's `queued fields applied` log lines for the task: one per record it applied. */
export function appliedLines(f: Fleet, taskId: string): string[] {
  return f.mac.logLines(/offline handover: queued fields applied/).filter((l) => l.includes(taskId))
}

/** What the session's `walnut` calls answered on the host, short. */
export async function attemptsSummary(f: Fleet, s: HostSession): Promise<string> {
  const a = await f.hostAttempts(s.host, s.sid)
  return JSON.stringify(a.map((x) => ({ code: x.code, said: String(x.stdout || x.stderr).replace(/\s+/g, ' ').slice(0, 140) })))
}

/**
 * The Mac's SSH to `host` runs through a ControlMaster (started or reused), not one
 * connection per command. 2026-10-23: a control path of 87 to 100 characters could
 * not be bound (ssh adds 17 while it binds), and the host ran without one.
 */
export function expectControlMaster(f: Fleet, host: string): void {
  const said = f.mac.logLines(/ControlMaster/).map((l) => JSON.parse(l) as Record<string, any>).filter((j) => j.host === host)
  expect(said.map((j) => j.message), JSON.stringify(said.map((j) => `${j.message} ${j.error ?? ''}`))).not.toContain('DaemonConnection: ControlMaster failed, falling back to individual connections')
  expect(said.some((j) => /SSH ControlMaster (started|reused)/.test(j.message))).toBe(true)
}
