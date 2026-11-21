/**
 * Approvals end to end on a real server (src/web/routes/approvals-v1.ts): `walnut approve`'s
 * loop (core/approvals/cli-core.ts) through the real ops against a person answering over HTTP.
 *
 *  - Approve -> exit 0, Deny -> 1, nobody -> 2, and the answer is used once;
 *  - only a person answers: a session, a CLI automation and a session on another host are
 *    refused (403 human_only), the guard tests/core/agent-parity-ratchet.test.ts lists;
 *  - the person answers with a tap on any device they are signed in on (this computer's window,
 *    the Mac app, a paired phone), bound to the digest it showed; an older app's key id and
 *    signature are not needed and not read (2026-11-21); an expired one is refused.
 * Nothing but the Claude CLI would be mocked, and no session runs here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-approvals-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/index.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { runApprove } from '../../src/core/approvals/cli-core.js'
import { opFailure } from '../../src/commands/approve.js'

let base = ''
const execFileP = promisify(execFile)

function curlArgs(urlPath: string, body: unknown, headers: Record<string, string>): string[] {
  return ['-s', '--noproxy', '*', '-X', 'POST', '-H', 'content-type: application/json',
    ...Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]),
    '-d', JSON.stringify(body), '-w', '\n%{http_code}', `${base}${urlPath}`]
}

function parseCurl(stdout: string) {
  const cut = stdout.lastIndexOf('\n')
  return { status: Number(stdout.slice(cut + 1)), body: JSON.parse(stdout.slice(0, cut) || '{}') as Record<string, any> }
}

/** A request from a process in no session: curl, a child of this test (which is also the server). */
async function curl(urlPath: string, body: unknown, headers: Record<string, string> = {}) {
  const { stdout } = await execFileP('curl', curlArgs(urlPath, body, headers))
  return parseCurl(stdout)
}

/** Withdraw an ask a check made, so the file stays under the cap on open approvals. */
async function withdraw(r: { body: any }): Promise<void> {
  if (r.body?.approval?.id) await http('POST', `/api/v1/approvals/${r.body.approval.id}/cancel`, { token: r.body.waitToken })
}

/** The start line a dtach master records for itself (dtach-master.ts START_FN). */
async function masterStart(pid: number): Promise<string> {
  const { START_FN } = await import('../../src/web/terminal/dtach-master.js')
  const { stdout } = await execFileP('/bin/sh', ['-c', `${START_FN}; walnut_st "\${1}"`, 'sh', String(pid)])
  return stdout.trim()
}

/** When `pid` started, as the daemon records it on a Mac (`ps -o lstart=`; tests compare the same form on Linux). */
async function startOf(pid: number): Promise<string> {
  const { stdout } = await execFileP('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', LANG: 'C' } })
  return stdout.trim()
}

/**
 * This machine's daemon, as the approvals route asks it (`caller.check`, caller-proof-v1): the
 * sessions it runs, each with the start time it read at spawn, judged with the daemon's own verdict
 * (`proofFor`) on a real `ps` snapshot. The daemon's command itself is driven in
 * tests/providers/daemon-caller-proof-twins-e2e.test.ts.
 */
const daemonSessions = new Map<string, { pid: number; start?: string | null }>()
const daemonAsked: string[] = []
beforeAll(async () => {
  // The person is at hand (single-use-fence.ts has its own tests).
  ;(await import('../../src/core/approvals/single-use-fence.js'))._setFenceDepsForTest({ activity: async () => ({ lastSeenAt: Date.now(), streaming: false }) })
  const { _setInSessionForTesting } = await import('../../src/core/approvals/caller-proof.js')
  const { PS_TREE_ARGS, parseProcessTree, proofFor } = await import('../../src/providers/caller-proof-core.js')
  _setInSessionForTesting(async (sid, pid, at) => {
    daemonAsked.push(sid)
    const { stdout } = await execFileP('ps', PS_TREE_ARGS, { env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, maxBuffer: 8 * 1024 * 1024 })
    const own = daemonSessions.get(sid)
    return proofFor(parseProcessTree(stdout), pid, at, own ? [own] : [], () => null)
  })
})
afterAll(async () => {
  const { _setInSessionForTesting } = await import('../../src/core/approvals/caller-proof.js')
  _setInSessionForTesting(null)
})

/**
 * Record `pid` as session `sid`'s live CLI, the way this machine's daemon does: the session record
 * names the pid, and the daemon holds it with the start time it read at spawn (`start` overrides
 * that, for a pid given out again; `key` is the daemon's name for it, an ACP runtime id).
 */
async function asDaemonSession(sid: string, pid: number, start?: string | null, key = sid): Promise<void> {
  const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
  daemonSessions.set(key, { pid, start: start === undefined ? await startOf(pid) : start })
  await updateSessionRecord(sid, { pid, process_status: 'idle' })
}

/**
 * A request from inside a session: a shell stands for the session's own process (its CLI), and
 * runs curl as its child once `register` has recorded the shell's pid as the session's, the way a
 * session's Python script runs `walnut approve`.
 */
async function curlInSession(register: (pid: number) => Promise<void>, urlPath: string, body: unknown, headers: Record<string, string> = {}) {
  const child = spawn('sh', ['-c', 'read go; "$@"', 'sh', 'curl', ...curlArgs(urlPath, body, headers)], { stdio: ['pipe', 'pipe', 'ignore'] })
  let stdout = ''
  child.stdout!.on('data', (d) => { stdout += String(d) })
  const done = new Promise<void>((resolve) => child.on('close', () => resolve()))
  await register(child.pid!)
  child.stdin!.end('go\n')
  await done
  return parseCurl(stdout)
}

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

/** The CLI's loop, its ops through the real executor as a terminal on this machine would call them. */
function approve(what: string, opts: { timeoutMs?: number } = {}) {
  const said: string[] = []
  const out: string[] = []
  const code = runApprove({ what, timeoutMs: opts.timeoutMs ?? 60_000, json: true, cwd: '/work/repo', command: 'deploy.sh' }, {
    call: async (name, args) => {
      const r = await executeOp(name, args, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
      return r.ok ? { ok: true, result: r.result } : opFailure(r.message)
    },
    say: (l) => said.push(l),
    out: (l) => out.push(l),
  })
  return { code, said, out }
}

async function pendingNamed(what: string) {
  for (let i = 0; i < 100; i++) {
    const r = await http('GET', '/api/v1/approvals')
    const a = (r.body.approvals as Array<Record<string, any>>).find((x) => x.what === what)
    if (a) return a
    await new Promise((res) => setTimeout(res, 50))
  }
  throw new Error(`no pending approval "${what}"`)
}

/** `n` copies of one request at once, all from one session's own shell: their HTTP statuses. */
async function statusesInSession(register: (pid: number) => Promise<void>, n: number, urlPath: string, body: unknown, headers: Record<string, string> = {}) {
  const one = curlArgs(urlPath, body, headers).filter((a) => a !== '\n%{http_code}' && a !== '-w')
  const script = 'read go; for i in $(seq 1 "$N"); do curl -o /dev/null -w "%{http_code}\\n" "$@" & done; wait'
  const child = spawn('sh', ['-c', script, 'sh', ...one], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, N: String(n) } })
  let stdout = ''
  child.stdout!.on('data', (d) => { stdout += String(d) })
  const done = new Promise<void>((resolve) => child.on('close', () => resolve()))
  await register(child.pid!)
  child.stdin!.end('go\n')
  await done
  return stdout.trim().split('\n').map(Number)
}

beforeAll(async () => {
  // A throwaway server makes no test objects unless told to (core/test-run.ts).
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await stopServer()
  delete process.env.WALNUT_TEST_RUN_MARK
})

describe('walnut approve against a real server', () => {
  it('exits 0 when a person approves, and the record says who asked and who answered', async () => {
    const run = approve('Deploy web to prod')
    const a = await pendingNamed('Deploy web to prod')
    expect(a.mode).toBe('tap')
    expect(a.requester).toMatchObject({ cwd: '/work/repo', command: 'deploy.sh' })
    expect(a.requester.host).toBeTruthy()
    const r = await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve', device: { name: 'Web console', kind: 'web' } })
    expect(r.status).toBe(200)
    expect(await run.code).toBe(0)
    expect(run.said.join('\n')).toContain('Approved on Web console.')
    expect(JSON.parse(run.out[0])).toMatchObject({ id: a.id, status: 'approved' })
    const all = await http('GET', '/api/v1/approvals?status=all')
    expect(all.body.approvals.find((x: any) => x.id === a.id).answer).toMatchObject({ decision: 'approve', mode: 'tap', device: { kind: 'web' } })
  }, 60_000)

  it('exits 1 on Deny', async () => {
    const run = approve('Drop the staging table')
    const a = await pendingNamed('Drop the staging table')
    await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'deny' })
    expect(await run.code).toBe(1)
  }, 60_000)

  it('exits 2 when nobody answers in time, and the card is gone', async () => {
    const run = approve('Nobody looks at this', { timeoutMs: 10_000 })
    const a = await pendingNamed('Nobody looks at this')
    expect(await run.code).toBe(2)
    const r = await http('GET', `/api/v1/approvals/${a.id}`)
    expect(r.body.approval.status).toBe('expired')
    expect((await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve' })).body.code).toBe('already_expired')
  }, 60_000)

  it('only a person answers: a session, a CLI automation and a session on another host are refused', async () => {
    const created = await executeOp('approval_request', { what: 'Rotate the signing key' }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
    expect(created.ok).toBe(true)
    const { approval, waitToken } = created.ok ? created.result as Record<string, any> : ({} as Record<string, any>)
    for (const headers of [
      { 'x-walnut-caller-sid': '11111111-2222-4333-8444-555555555555' },
      { 'x-walnut-caller-kind': 'script' },
      { 'x-walnut-origin': 'host:clouddev' },
    ]) {
      const r = await http('POST', `/api/v1/approvals/${approval.id}/answer`, { decision: 'approve' }, headers)
      expect(r.status, JSON.stringify(headers)).toBe(403)
      expect(r.body.code).toBe('human_only')
    }
    // There is no op that answers one.
    expect((await executeOp('approval_answer', { id: approval.id }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })).ok).toBe(false)
    // The asker uses it once.
    await http('POST', `/api/v1/approvals/${approval.id}/answer`, { decision: 'approve' })
    const first = await executeOp('approval_wait', { id: approval.id, token: waitToken, wait_ms: 0 }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
    expect(first.ok && (first.result as any).used).toBe(true)
    // A retry right away gets the same decision without using it again (store.ts APPROVAL_REREAD_MS).
    const second = await executeOp('approval_wait', { id: approval.id, token: waitToken, wait_ms: 0 }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
    expect(second.ok && (second.result as any)).toMatchObject({ used: false, approval: { status: 'approved' } })
    // Someone else's token reads nothing.
    const other = await executeOp('approval_wait', { id: approval.id, token: 'guess', wait_ms: 0 }, { origin: LOCAL_ORIGIN, apiBase: base, callerMode: 'human' })
    expect(other.ok).toBe(false)
  }, 60_000)

  it('any device the person is signed in on approves with a tap; an older app\'s key and signature are not needed', async () => {
    const run = approve('Publish v1')
    const a = await pendingNamed('Publish v1')
    expect(a.mode).toBe('tap')
    expect(a.signingKeyIds).toBeUndefined()
    // The paired phone, sending what an older app sends with its tap (a key id and a signature): read as a tap.
    const paired = await http('POST', '/api/devices', { name: 'approvals-e2e-phone' })
    expect(paired.status).toBe(201)
    const phone = { authorization: `Bearer ${paired.body.token}` }
    const ok = await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve', digest: a.digest, keyId: 'ak-dcb776df2641b2ff', signature: 'bm90LWEtc2lnbmF0dXJl', device: { name: 'Test iPhone', kind: 'iphone' } }, phone)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.approval.answer).toMatchObject({ decision: 'approve', mode: 'tap', device: { kind: 'iphone' } })
    expect(await run.code).toBe(0)
    // Named by the device the person paired, never by a key or Face ID.
    expect(run.said.join('\n')).toContain('Approved on approvals-e2e-phone.')
    expect(run.said.join('\n')).not.toMatch(/Face ID|Touch ID|signature|signing/)
    // The Mac app's window.
    const mac = approve('Publish v2')
    const b = await pendingNamed('Publish v2')
    const fromMac = await http('POST', `/api/v1/approvals/${b.id}/answer`, { decision: 'approve', digest: b.digest, device: { name: 'Mac app', kind: 'mac-app' } })
    expect(fromMac.status).toBe(200)
    expect(fromMac.body.approval.answer.device).toMatchObject({ kind: 'mac-app' })
    expect(await mac.code).toBe(0)
    // A digest that is not the one this request has: refused (409), and it still waits.
    const third = approve('Publish v3', { timeoutMs: 20_000 })
    const c = await pendingNamed('Publish v3')
    const stale = await http('POST', `/api/v1/approvals/${c.id}/answer`, { decision: 'approve', digest: '0'.repeat(64) }, phone)
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('changed')
    expect((await http('GET', `/api/v1/approvals/${c.id}`)).body.approval.status).toBe('pending')
    await http('POST', `/api/v1/approvals/${c.id}/answer`, { decision: 'deny', digest: c.digest }, phone)
    expect(await third.code).toBe(1)
    // No device is listed or enrolled: the list's keys are empty for an older app, and the enroll route is gone.
    expect((await http('GET', '/api/v1/approvals')).body.keys).toEqual([])
    expect((await http('POST', '/api/v1/approvals/keys', { publicKey: 'x', name: 'x', kind: 'iphone' }, phone)).status).toBe(404)
  }, 60_000)

  it('strict approvals require a session, refuse self-approval, take a tap from the person, and consume once over HTTP', async () => {
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { addTask } = await import('../../src/core/task-manager.js')
    const { task } = await addTask({ title: 'Strict approval test', project: 'Approval tests' })
    const sid = crypto.randomUUID()
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME, { host: '__local__', initialProcessStatus: 'stopped' })
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    const asSession = (pid: number) => asDaemonSession(sid, pid)
    const H = { 'x-walnut-caller-sid': sid, 'x-walnut-origin': LOCAL_ORIGIN }
    const spec = { what: 'Allow one Git push?', detail: JSON.stringify({ session: sid, task: task.id,
      repo: '/work/repo', remote: 'ssh://example.com/private/repo', sha: 'ab'.repeat(20), nonce: crypto.randomBytes(32).toString('hex') }),
      single_use: true, timeout_ms: 300_000 }
    // No session behind it: refused.
    expect((await http('POST', '/api/v1/approvals', spec)).body.code).toBe('strict_approval_required')
    const identity = await http('POST', '/api/v1/approvals', { what: 'Check asker identity' }, H)
    expect(identity.body.approval.requester).toMatchObject({ sessionId: sid, taskId: task.id })
    // A check Walnut cannot make refuses too: this call comes from the server's own process.
    expect((await http('POST', '/api/v1/approvals', spec, H)).body.code).toBe('unverified_session')
    const made = await curlInSession(asSession, '/api/v1/approvals', spec, H)
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    const a = made.body.approval
    expect(a.requester).toMatchObject({ taskId: task.id, sessionId: sid, identity: 'verified' })
    expect(a).toMatchObject({ mode: 'tap', singleUse: true })
    expect(a.signingKeyId).toBeUndefined()
    // The asking session cannot approve its own ask, from the server's view or from its own shell.
    expect((await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve', digest: a.digest }, H)).body.code).toBe('human_only')
    expect((await curlInSession(asSession, `/api/v1/approvals/${a.id}/answer`, { decision: 'approve', digest: a.digest }, H)).body.code).toBe('human_only')
    // The person's tap.
    expect((await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve', digest: a.digest, device: { name: 'Web console', kind: 'web' } })).status).toBe(200)
    const token = made.body.waitToken
    const read = await http('POST', `/api/v1/approvals/${a.id}/wait`, { token, wait_ms: 0 }, H)
    expect(read.body).toMatchObject({ used: false, approval: { status: 'approved' } })
    const envelope = JSON.parse(a.detail)
    expect(envelope).toMatchObject({ version: 'walnut-single-use-v1', sessionId: sid, taskId: task.id, context: spec.detail })
    expect(envelope.signingKeyId).toBeUndefined()
    expect(envelope.nonce).toMatch(/^[0-9a-f]{64}$/)
    const consume = { token, digest: a.digest, detail: spec.detail }
    // Spending it needs the asking session's own process too, checked again: fail closed.
    expect((await http('POST', `/api/v1/approvals/${a.id}/consume`, consume)).body.code).toBe('unverified_session')
    expect((await curl(`/api/v1/approvals/${a.id}/consume`, consume, H)).body.code).toBe('unverified_session')
    expect((await http('POST', `/api/v1/approvals/${a.id}/consume`, consume, H)).body.code).toBe('unverified_session')
    expect((await curlInSession(asSession, `/api/v1/approvals/${a.id}/consume`, { ...consume, detail: spec.detail + 'changed' }, H)).body.code).toBe('changed')
    const statuses = await statusesInSession(asSession, 3, `/api/v1/approvals/${a.id}/consume`, consume, H)
    expect(statuses.filter((c) => c === 200)).toHaveLength(1)
    expect(statuses.filter((c) => c === 409)).toHaveLength(2)
  })

  it('a test run\'s approval shows only to that test run', async () => {
    const T = { 'x-walnut-test-run': 'apr-e2e' }
    const made = await http('POST', '/api/v1/approvals', { what: 'Test-run deploy' }, T)
    expect(made.status).toBe(200)
    expect(made.body.approval.testRun).toBe('apr-e2e')
    const id = made.body.approval.id
    expect((await http('GET', '/api/v1/approvals')).body.approvals.map((a: any) => a.id)).not.toContain(id)
    expect((await http('GET', '/api/v1/approvals', undefined, T)).body.approvals.map((a: any) => a.id)).toContain(id)
    expect((await http('GET', `/api/v1/approvals/${id}`)).status).toBe(404)
    // The person never answers a test run's approval by accident, nor a test run the person's.
    expect((await http('POST', `/api/v1/approvals/${id}/answer`, { decision: 'approve' })).status).toBe(404)
    const real = await http('POST', '/api/v1/approvals', { what: 'Real deploy' })
    expect((await http('POST', `/api/v1/approvals/${real.body.approval.id}/answer`, { decision: 'approve' }, T)).status).toBe(404)
    expect((await http('POST', `/api/v1/approvals/${id}/answer`, { decision: 'approve' }, T)).status).toBe(200)
    await http('POST', `/api/v1/approvals/${real.body.approval.id}/cancel`, { token: real.body.waitToken })
  })
})

describe('who asks: Walnut checks the asking process, never only the session id it names', () => {
  // Every attack is a real process: curl, started by this test, against the real server.
  let other: ReturnType<typeof spawn> | undefined
  afterAll(() => { other?.kill() })

  async function setup() {
    const { createSessionRecord, updateSessionRecord } = await import('../../src/core/session-tracker.js')
    const { addTask } = await import('../../src/core/task-manager.js')
    const { task } = await addTask({ title: 'Identity test task', project: 'Approval tests' })
    // A task has one session at a time, so the other session is another task's.
    const { task: otherTask } = await addTask({ title: 'Identity other task', project: 'Approval tests' })
    // A process outside this test's tree: the forged session's own CLI.
    other = spawn('sleep', ['60'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 100))
    const mine = crypto.randomUUID()
    const theirs = crypto.randomUUID()
    await createSessionRecord(mine, task.id, task.project, WALNUT_HOME, { host: '__local__', initialProcessStatus: 'stopped' })
    await createSessionRecord(theirs, otherTask.id, otherTask.project, WALNUT_HOME, { host: '__local__', initialProcessStatus: 'idle', pid: other.pid! })
    await asDaemonSession(theirs, other.pid!)
    const asMine = (pid: number) => asDaemonSession(mine, pid)
    return { task, mine, theirs, asMine }
  }

  it("a script the session runs is seen inside it; one naming another session's id is not, and gets no single-use approval", async () => {
    const { task, mine, theirs, asMine } = await setup()
    const ok = await curlInSession(asMine, '/api/v1/approvals', { what: 'Identity: inside', command: 'release.py', why: 'Publish 1.2 to the store', request_only: true }, { 'x-walnut-caller-sid': mine })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.approval).toMatchObject({ requestOnly: true, context: { why: 'Publish 1.2 to the store', whyFrom: 'asker' } })
    // What ran it is read from the process table: the session's shell and its own command line.
    expect(ok.body.approval.requester.ranBy).toMatch(/^sh -c read go/)
    expect(ok.body.approval.requester).toMatchObject({ sessionId: mine, taskId: task.id, identity: 'verified' })
    expect(ok.body.approval.requester.process).toBeTruthy()

    // A stopped session's recorded pid may be anything's by now: it proves nothing.
    const { createSessionRecord, updateSessionRecord } = await import('../../src/core/session-tracker.js')
    const { addTask } = await import('../../src/core/task-manager.js')
    const { task: staleTask } = await addTask({ title: 'Identity stale task', project: 'Approval tests' })
    const stale = crypto.randomUUID()
    await createSessionRecord(stale, staleTask.id, staleTask.project, WALNUT_HOME, { host: '__local__', initialProcessStatus: 'stopped' })
    const reused = await curlInSession((pid) => updateSessionRecord(stale, { pid, process_status: 'stopped' }).then(() => undefined),
      '/api/v1/approvals', { what: 'Identity: stale pid' }, { 'x-walnut-caller-sid': stale })
    expect(reused.body.approval.requester).toMatchObject({ sessionId: stale, identity: 'unverified', check: 'unchecked' })
    // A live session whose recorded pid was given out again: the daemon recorded another start time
    // for it, so the process now under that pid is not the session's, whatever it runs.
    const recycled = await curlInSession((pid) => asDaemonSession(stale, pid, 'Mon Jan  1 00:00:00 2001'),
      '/api/v1/approvals', { what: 'Identity: recycled pid' }, { 'x-walnut-caller-sid': stale })
    expect(recycled.body.approval.requester).toMatchObject({ sessionId: stale, identity: 'unverified', check: 'unchecked' })
    await withdraw(recycled)
    // A pid the session record names that the daemon's registry does not (it names the earlier one)
    // has no recorded start time, and proves nothing either.
    const unrecorded = await curlInSession((pid) => updateSessionRecord(stale, { pid, process_status: 'idle' }).then(() => undefined),
      '/api/v1/approvals', { what: 'Identity: no recorded start' }, { 'x-walnut-caller-sid': stale })
    expect(unrecorded.body.approval.requester).toMatchObject({ identity: 'unverified', check: 'unchecked' })
    await withdraw(unrecorded)

    const forged = await curl('/api/v1/approvals', { what: 'Identity: forged' }, { 'x-walnut-caller-sid': theirs })
    expect(forged.status).toBe(200)
    expect(forged.body.approval.requester).toMatchObject({ sessionId: theirs, identity: 'unverified', check: 'outside' })
    // Another session's own script naming this one is outside it too.
    const crossed = await curlInSession(asMine, '/api/v1/approvals', { what: 'Identity: crossed' }, { 'x-walnut-caller-sid': theirs })
    expect(crossed.body.approval.requester).toMatchObject({ sessionId: theirs, identity: 'unverified', check: 'outside' })

    const strict = { what: 'Identity: strict', detail: 'context', single_use: true, timeout_ms: 60_000 }
    const refused = await curl('/api/v1/approvals', strict, { 'x-walnut-caller-sid': theirs })
    expect(refused).toMatchObject({ status: 403, body: { code: 'unverified_session' } })
    const allowed = await curlInSession(asMine, '/api/v1/approvals', strict, { 'x-walnut-caller-sid': mine })
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200)
    // One single-use ask at a time (single-use-fence.ts): withdrawn, so the next test may ask its own.
    await withdraw(allowed)
  }, 60_000)

  it('outside any session: still asks, and says who ran it, with the session unknown', async () => {
    const r = await curl('/api/v1/approvals', { what: 'Identity: outside', cwd: '/work/repo', command: 'cron.sh' })
    expect(r.status).toBe(200)
    const req = r.body.approval.requester
    expect(req.identity).toBe('none')
    expect(req.sessionId).toBeUndefined()
    expect(req.taskId).toBeUndefined()
    expect(req).toMatchObject({ cwd: '/work/repo', command: 'cron.sh' })
    expect(req.process).toBeTruthy()
    expect(req.host).toBeTruthy()
  }, 30_000)

  it("a host's relay is the server's own call; another process claiming one asks as itself, with no session", async () => {
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { addTask } = await import('../../src/core/task-manager.js')
    const { hostOrigin } = await import('../../src/lib/caller-origin.js')
    const { task } = await addTask({ title: 'Identity remote task', project: 'Approval tests' })
    const sid = crypto.randomUUID()
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME, { host: 'devbox', initialProcessStatus: 'idle' })
    // The real relay: the server runs the host's op itself (capability-router.ts), in this process.
    const relayed = await executeOp('approval_request', { what: 'Identity: relayed' }, { origin: hostOrigin('devbox'), callerSid: sid, callerHost: 'devbox', apiBase: base })
    expect(relayed.ok).toBe(true)
    const rr = (relayed.ok ? relayed.result : {}) as Record<string, any>
    expect(rr.approval.requester).toMatchObject({ sessionId: sid, taskId: task.id, identity: 'unverified', check: 'unchecked', host: 'devbox' })
    expect(rr.approval.requester.relayClaimed).toBeUndefined()
    // A relayed single-use ask is not checked yet (the daemon would name its socket's process): refused.
    const relayStrict = await executeOp('approval_request', { what: 'Identity: relayed strict', detail: 'ctx', single_use: true,
      timeout_ms: 60_000 }, { origin: hostOrigin('devbox'), callerSid: sid, callerHost: 'devbox', apiBase: base })
    expect(relayStrict.ok).toBe(false)
    expect(relayStrict.ok ? '' : relayStrict.message).toMatch(/unverified_session|seen inside its session/)
    // With the daemon's word (caller-proof-v1) on the process on its socket, the relay is checked.
    const { handleGatewayCapability } = await import('../../src/core/peers/capability-router.js')
    const viaDaemon = (args: Record<string, unknown>, callerProof?: Record<string, unknown>) =>
      handleGatewayCapability('tools.call', sid, { name: 'approval_request', args, ...(callerProof ? { callerProof } : {}) }, 'devbox')
    const seen = await viaDaemon({ what: 'Identity: relayed, seen' }, { v: 1, verified: true, pid: 4242, process: 'python3', ranBy: 'python3 release.py --token=FAKE-TOKEN-NOT-REAL-zq7w4k9x2m' })
    expect(seen.ok, JSON.stringify(seen)).toBe(true)
    const seenReq = (seen.ok ? seen.result : {}) as Record<string, any>
    expect(seenReq.approval.requester).toMatchObject({ sessionId: sid, identity: 'verified', process: 'python3' })
    expect(seenReq.approval.requester.ranBy).toMatch(/^python3 release\.py/)
    expect(seenReq.approval.requester.ranBy).not.toContain('FAKE-TOKEN-NOT-REAL')
    const outsideRelay = await viaDaemon({ what: 'Identity: relayed, outside' }, { v: 1, verified: false, pid: 4243 })
    expect(((outsideRelay.ok ? outsideRelay.result : {}) as Record<string, any>).approval.requester).toMatchObject({ identity: 'unverified', check: 'outside' })
    const strictSeen = await viaDaemon({ what: 'Identity: relayed strict, seen', detail: 'ctx', single_use: true, timeout_ms: 60_000 }, { v: 1, verified: true, pid: 4242 })
    expect(strictSeen.ok, JSON.stringify(strictSeen)).toBe(true)
    // A stopped session's proof counts for nothing: its process may be gone and its pid anyone's.
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    await updateSessionRecord(sid, { process_status: 'stopped' })
    const stale = await viaDaemon({ what: 'Identity: relayed, stopped session' }, { v: 1, verified: true, pid: 4242 })
    expect(((stale.ok ? stale.result : {}) as Record<string, any>).approval.requester).toMatchObject({ identity: 'unverified', check: 'unchecked' })
    await updateSessionRecord(sid, { process_status: 'idle' })
    // A proof token is this process's own: one named in a header by another process means nothing.
    const fakeToken = await curl('/api/v1/approvals', { what: 'Identity: fake proof token' },
      { 'x-walnut-caller-sid': sid, 'x-walnut-origin': hostOrigin('devbox'), 'x-walnut-caller-proof': 'f'.repeat(48) })
    expect(fakeToken.body.approval.requester).toMatchObject({ relayClaimed: true, identity: 'none' })
    // A local process sending the same headers is not that host.
    const forged = await curl('/api/v1/approvals', { what: 'Identity: claimed relay' },
      { 'x-walnut-caller-sid': sid, 'x-walnut-origin': hostOrigin('devbox'), 'x-walnut-caller-host': 'devbox' })
    expect(forged.status, JSON.stringify(forged.body)).toBe(200)
    const req = forged.body.approval.requester
    expect(req).toMatchObject({ relayClaimed: true, identity: 'none' })
    expect(req.sessionId).toBeUndefined()
    expect(req.taskId).toBeUndefined()
    expect(req.host).not.toBe('devbox')
  }, 30_000)

  it("an ACP engine's session (Codex and the rest) is seen through its worker's process", async () => {
    const { createSessionRecord, updateSessionRecord } = await import('../../src/core/session-tracker.js')
    const { addTask } = await import('../../src/core/task-manager.js')
    const { task } = await addTask({ title: 'Identity ACP task', project: 'Approval tests' })
    const sid = crypto.randomUUID()
    const runtimeId = `acp-${crypto.randomUUID()}`
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME, { host: '__local__', initialProcessStatus: 'idle' })
    await updateSessionRecord(sid, { acpRuntimeId: runtimeId })
    // The daemon knows the worker by the session's ACP runtime id (acp-daemon.ts), and is asked by it.
    const r = await curlInSession((pid) => asDaemonSession(sid, pid, undefined, runtimeId),
      '/api/v1/approvals', { what: 'Identity: acp' }, { 'x-walnut-caller-sid': sid })
    expect(r.body.approval.requester).toMatchObject({ sessionId: sid, identity: 'verified' })
    expect(daemonAsked.at(-1)).toBe(runtimeId)
    // A worker with no start time read yet does not name the process under its pid.
    const unread = await curlInSession((pid) => asDaemonSession(sid, pid, null, runtimeId),
      '/api/v1/approvals', { what: 'Identity: acp, no start' }, { 'x-walnut-caller-sid': sid })
    expect(unread.body.approval.requester).toMatchObject({ sessionId: sid, identity: 'unverified', check: 'unchecked' })
    await withdraw(unread)
    // Nothing a process writes on disk names a session's worker: the daemon's word alone counts.
    const { localDaemonDirChoice, isProductionDaemonDir } = await import('../../src/lib/daemon-dir.js')
    const dir = localDaemonDirChoice().dir
    expect(isProductionDaemonDir(dir)).toBe(false)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'acp-workers.json')
    daemonSessions.delete(runtimeId)
    try {
      const forged = await curlInSession(async (pid) => {
        await fs.writeFile(file, JSON.stringify({ [runtimeId]: { pid, cmd: 'acp-worker.js', start: await startOf(pid) }, [sid]: { pid, start: await startOf(pid) } }))
        await fs.writeFile(path.join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: { [sid]: { pid, startTime: await startOf(pid) } } }))
        await updateSessionRecord(sid, { pid, process_status: 'idle' })
      }, '/api/v1/approvals', { what: 'Identity: acp, forged files' }, { 'x-walnut-caller-sid': sid })
      expect(forged.body.approval.requester).toMatchObject({ sessionId: sid, identity: 'unverified', check: 'unchecked' })
      await withdraw(forged)
    } finally {
      await fs.rm(file, { force: true })
      await fs.rm(path.join(dir, 'sessions.json'), { force: true })
    }
  }, 30_000)

  it("a task terminal Walnut opened names its task only from inside that terminal's shell", async () => {
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { addTask } = await import('../../src/core/task-manager.js')
    const { dtachPidPath } = await import('../../src/web/terminal/spawn.js')
    const { task } = await addTask({ title: 'Identity terminal task', project: 'Approval tests' })
    const sid = crypto.randomUUID()
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME, { host: '__local__', initialProcessStatus: 'stopped' })
    const pidFile = dtachPidPath(sid)
    await fs.mkdir(path.dirname(pidFile), { recursive: true })
    try {
      const inside = await curlInSession(async (pid) => fs.writeFile(pidFile, `${pid}\n${await masterStart(pid)}\n`), '/api/v1/approvals', { what: 'Identity: terminal', terminal_session: sid })
      expect(inside.body.approval.requester).toMatchObject({ taskId: task.id, via: 'terminal', identity: 'verified' })
      expect(inside.body.approval.requester.sessionId).toBeUndefined()
      // The session's second terminal names itself by its key and proves itself by its own record.
      const secondFile = dtachPidPath(`${sid}__term2`)
      try {
        const second = await curlInSession(async (pid) => fs.writeFile(secondFile, `${pid}\n${await masterStart(pid)}\n`), '/api/v1/approvals', { what: 'Identity: second terminal', terminal_session: `${sid}__term2` })
        expect(second.body.approval.requester).toMatchObject({ taskId: task.id, via: 'terminal', identity: 'verified' })
        await withdraw(second)
      } finally {
        await fs.rm(secondFile, { force: true })
      }
      // A pid record naming another start time is a dead terminal's: the process under its pid got
      // the pid later and is not that terminal's shell. A record with no start time proves nothing.
      for (const second of ['ps:Mon Jan 1 00:00:00 2001', 'proc:12', '']) {
        const late = await curlInSession((pid) => fs.writeFile(pidFile, `${pid}\n${second}\n`),
          '/api/v1/approvals', { what: 'Identity: terminal pid reused', terminal_session: sid })
        expect(late.body.approval.requester.taskId).toBeUndefined()
        expect(late.body.approval.requester.identity).toBe('none')
        await withdraw(late)
      }
      // Another shell naming that terminal is not in it.
      other ??= spawn('sleep', ['60'], { stdio: 'ignore' })
      await fs.writeFile(pidFile, `${other.pid}\n${await masterStart(other.pid!)}\n`)
      const outside = await curl('/api/v1/approvals', { what: 'Identity: not terminal', terminal_session: sid })
      expect(outside.body.approval.requester.taskId).toBeUndefined()
      expect(outside.body.approval.requester.identity).toBe('none')
    } finally {
      await fs.rm(pidFile, { force: true })
    }
  }, 30_000)
})
