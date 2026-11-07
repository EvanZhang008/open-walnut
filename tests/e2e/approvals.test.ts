/**
 * Approvals end to end on a real server (src/web/routes/approvals-v1.ts): `walnut approve`'s
 * loop (core/approvals/cli-core.ts) through the real ops against a person answering over HTTP.
 *
 *  - Approve -> exit 0, Deny -> 1, nobody -> 2, and the answer is used once;
 *  - only a person answers or enrolls a device: a session, a CLI automation and a session on
 *    another host are refused (403 human_only), the guard tests/core/agent-parity-ratchet.test.ts lists;
 *  - biometric: with no device it asks for a tap and says why; with an enrolled key, Approve
 *    needs that key's signature over this approval's digest.
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
import { answerMessage, keyIdOf } from '../../src/core/approvals/digest.js'

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
function approve(what: string, opts: { biometric?: boolean; timeoutMs?: number } = {}) {
  const said: string[] = []
  const out: string[] = []
  const code = runApprove({ what, biometric: !!opts.biometric, timeoutMs: opts.timeoutMs ?? 60_000, json: true, cwd: '/work/repo', command: 'deploy.sh' }, {
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
    expect(run.said.join('\n')).toContain('Approved on Web console, with a tap')
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
      const k = await http('POST', '/api/v1/approvals/keys', { publicKey: 'x', name: 'x', kind: 'iphone' }, headers)
      expect(k.status).toBe(403)
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

  it('biometric: asks for a tap when no device signs yet, then needs the enrolled key\'s signature', async () => {
    const tapRun = approve('Publish v1 (no device yet)', { biometric: true })
    const t = await pendingNamed('Publish v1 (no device yet)')
    expect(t.mode).toBe('tap')
    expect(t.downgraded).toMatch(/No device signs approvals yet/)
    await http('POST', `/api/v1/approvals/${t.id}/answer`, { decision: 'approve' })
    expect(await tapRun.code).toBe(0)
    expect(tapRun.said.join('\n')).toContain('No device signs approvals yet')

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    // A first key from this computer is refused: only the paired iPhone app, with its device token.
    const local = await http('POST', '/api/v1/approvals/keys', { publicKey: spki, name: 'Test iPhone', kind: 'iphone' })
    expect(local.status).toBe(403)
    expect(local.body.code).toBe('first_key_from_phone')
    const paired = await http('POST', '/api/devices', { name: 'approvals-e2e-phone' })
    expect(paired.status).toBe(201)
    const phone = { authorization: `Bearer ${paired.body.token}` }
    const enrolled = await http('POST', '/api/v1/approvals/keys', { publicKey: spki, name: 'Test iPhone', kind: 'iphone' }, phone)
    expect(enrolled.status).toBe(200)
    expect(enrolled.body.key).toMatchObject({ id: keyIdOf(spki), status: 'active' })

    const run = approve('Publish v1', { biometric: true })
    const a = await pendingNamed('Publish v1')
    expect(a.mode).toBe('biometric')
    const tap = await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve' })
    expect(tap.status).toBe(403)
    expect(tap.body.code).toBe('biometric_required')
    const signature = crypto.sign('sha256', Buffer.from(answerMessage(a.digest, 'approve')), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
    const ok = await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve', keyId: keyIdOf(spki), signature })
    expect(ok.status).toBe(200)
    expect(await run.code).toBe(0)
    expect(run.said.join('\n')).toContain('Approved on Test iPhone, with Face ID')
    const keys = await http('GET', '/api/v1/approvals/keys')
    expect(keys.body.keys[0].lastUsedAt).toBeTruthy()
  }, 60_000)

  it('strict approvals require a session and a device, refuse self-approval, and consume once over HTTP', async () => {
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { addTask } = await import('../../src/core/task-manager.js')
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const keyId = keyIdOf(spki)
    const { task } = await addTask({ title: 'Strict approval test', project: 'Approval tests' })
    const sid = crypto.randomUUID()
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME, { host: '__local__', initialProcessStatus: 'stopped' })
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    const asSession = (pid: number) => updateSessionRecord(sid, { pid, process_status: 'idle' }).then(() => undefined)
    const H = { 'x-walnut-caller-sid': sid, 'x-walnut-origin': LOCAL_ORIGIN }
    const spec = { what: 'Allow one Git push?', detail: JSON.stringify({ session: sid, task: task.id,
      repo: '/work/repo', remote: 'ssh://example.com/private/repo', sha: 'ab'.repeat(20), nonce: crypto.randomBytes(32).toString('hex') }),
      mode: 'biometric', single_use: true, signing_key_id: keyId, timeout_ms: 300_000 }
    expect((await http('POST', '/api/v1/approvals', spec, H)).body.code).toBe('strict_approval_required')
    const keyFile = `${WALNUT_HOME}/approvals/keys.json`
    await fs.mkdir(`${WALNUT_HOME}/approvals`, { recursive: true })
    await fs.writeFile(keyFile, JSON.stringify({ version: 1, keys: [{ id: keyId, publicKey: spki,
      name: 'Strict test Mac', kind: 'mac-app', status: 'active', createdAt: new Date().toISOString() }] }))
    expect((await http('POST', '/api/v1/approvals', spec)).body.code).toBe('strict_approval_required')
    const identity = await http('POST', '/api/v1/approvals', { what: 'Check asker identity' }, H)
    expect(identity.body.approval.requester).toMatchObject({ sessionId: sid, taskId: task.id })
    expect((await http('GET', '/api/v1/approvals/keys')).body.keys).toContainEqual(expect.objectContaining({ id: keyId, status: 'active' }))
    // A check Walnut cannot make refuses too: this call comes from the server's own process.
    expect((await http('POST', '/api/v1/approvals', spec, H)).body.code).toBe('unverified_session')
    const made = await curlInSession(asSession, '/api/v1/approvals', spec, H)
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    const a = made.body.approval
    expect(a.requester).toMatchObject({ taskId: task.id, sessionId: sid, identity: 'verified' })
    expect(a).toMatchObject({ mode: 'biometric', singleUse: true, signingKeyId: keyId })
    const signature = crypto.sign('sha256', Buffer.from(answerMessage(a.digest, 'approve')), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
    expect((await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve', keyId, signature }, H)).body.code).toBe('human_only')
    expect((await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve' })).body.code).toBe('biometric_required')
    expect((await http('POST', `/api/v1/approvals/${a.id}/answer`, { decision: 'approve', keyId, signature })).status).toBe(200)
    const token = made.body.waitToken
    const read = await http('POST', `/api/v1/approvals/${a.id}/wait`, { token, wait_ms: 0 }, H)
    expect(read.body).toMatchObject({ used: false, approval: { status: 'approved' } })
    const envelope = JSON.parse(a.detail)
    expect(envelope).toMatchObject({ version: 'walnut-single-use-v1', sessionId: sid, taskId: task.id, signingKeyId: keyId, context: spec.detail })
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

  it('a test run\'s approval shows only to that test run, which cannot change the signing devices', async () => {
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
    const k = await http('POST', '/api/v1/approvals/keys', { publicKey: 'x', name: 'x', kind: 'iphone' }, T)
    expect(k.body.code).toBe('test_run')
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
    const asMine = (pid: number) => updateSessionRecord(mine, { pid, process_status: 'idle' }).then(() => undefined)
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

    const forged = await curl('/api/v1/approvals', { what: 'Identity: forged' }, { 'x-walnut-caller-sid': theirs })
    expect(forged.status).toBe(200)
    expect(forged.body.approval.requester).toMatchObject({ sessionId: theirs, identity: 'unverified', check: 'outside' })
    // Another session's own script naming this one is outside it too.
    const crossed = await curlInSession(asMine, '/api/v1/approvals', { what: 'Identity: crossed' }, { 'x-walnut-caller-sid': theirs })
    expect(crossed.body.approval.requester).toMatchObject({ sessionId: theirs, identity: 'unverified', check: 'outside' })

    const { privateKey: _p, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const keyId = keyIdOf(spki)
    const keyFile = `${WALNUT_HOME}/approvals/keys.json`
    await fs.mkdir(`${WALNUT_HOME}/approvals`, { recursive: true })
    const prior = JSON.parse(await fs.readFile(keyFile, 'utf8').catch(() => '{"version":1,"keys":[]}')) as { version: number; keys: unknown[] }
    await fs.writeFile(keyFile, JSON.stringify({ version: 1, keys: [...prior.keys, { id: keyId, publicKey: spki,
      name: 'Identity test Mac', kind: 'mac-app', status: 'active', createdAt: new Date().toISOString() }] }))
    const strict = { what: 'Identity: strict', detail: 'context', mode: 'biometric', single_use: true, signing_key_id: keyId, timeout_ms: 60_000 }
    const refused = await curl('/api/v1/approvals', strict, { 'x-walnut-caller-sid': theirs })
    expect(refused).toMatchObject({ status: 403, body: { code: 'unverified_session' } })
    const allowed = await curlInSession(asMine, '/api/v1/approvals', strict, { 'x-walnut-caller-sid': mine })
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200)
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
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME, { host: 'devbox', initialProcessStatus: 'stopped' })
    // The real relay: the server runs the host's op itself (capability-router.ts), in this process.
    const relayed = await executeOp('approval_request', { what: 'Identity: relayed' }, { origin: hostOrigin('devbox'), callerSid: sid, callerHost: 'devbox', apiBase: base })
    expect(relayed.ok).toBe(true)
    const rr = (relayed.ok ? relayed.result : {}) as Record<string, any>
    expect(rr.approval.requester).toMatchObject({ sessionId: sid, taskId: task.id, identity: 'unverified', check: 'unchecked', host: 'devbox' })
    expect(rr.approval.requester.relayClaimed).toBeUndefined()
    // A relayed single-use ask is not checked yet (the daemon would name its socket's process): refused.
    const keys = JSON.parse(await fs.readFile(`${WALNUT_HOME}/approvals/keys.json`, 'utf8')) as { keys: Array<{ id: string; status: string }> }
    const active = keys.keys.find((k) => k.status === 'active')!
    const relayStrict = await executeOp('approval_request', { what: 'Identity: relayed strict', detail: 'ctx', mode: 'biometric', single_use: true,
      signing_key_id: active.id, timeout_ms: 60_000 }, { origin: hostOrigin('devbox'), callerSid: sid, callerHost: 'devbox', apiBase: base })
    expect(relayStrict.ok).toBe(false)
    expect(relayStrict.ok ? '' : relayStrict.message).toMatch(/unverified_session|seen inside its session/)
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
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { addTask } = await import('../../src/core/task-manager.js')
    const { localDaemonDirChoice, isProductionDaemonDir } = await import('../../src/lib/daemon-dir.js')
    const dir = localDaemonDirChoice().dir
    expect(isProductionDaemonDir(dir)).toBe(false)
    const { task } = await addTask({ title: 'Identity ACP task', project: 'Approval tests' })
    const sid = crypto.randomUUID()
    const runtimeId = `acp-${crypto.randomUUID()}`
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME, { host: '__local__', initialProcessStatus: 'idle' })
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    await updateSessionRecord(sid, { acpRuntimeId: runtimeId })
    const file = path.join(dir, 'acp-workers.json')
    const before = await fs.readFile(file, 'utf8').catch(() => null)
    await fs.mkdir(dir, { recursive: true })
    try {
      // The daemon's worker list names the shell as this session's worker.
      const r = await curlInSession(async (pid) => {
        // The daemon keys its workers by the session's ACP runtime id (acp-daemon.ts).
        await fs.writeFile(file, JSON.stringify({ ...(before ? JSON.parse(before) : {}), [runtimeId]: { pid, cmd: 'acp-worker.js' } }))
      }, '/api/v1/approvals', { what: 'Identity: acp' }, { 'x-walnut-caller-sid': sid })
      expect(r.body.approval.requester).toMatchObject({ sessionId: sid, identity: 'verified' })
    } finally {
      if (before === null) await fs.rm(file, { force: true })
      else await fs.writeFile(file, before)
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
      const inside = await curlInSession((pid) => fs.writeFile(pidFile, `${pid}\n`), '/api/v1/approvals', { what: 'Identity: terminal', terminal_session: sid })
      expect(inside.body.approval.requester).toMatchObject({ taskId: task.id, via: 'terminal', identity: 'verified' })
      expect(inside.body.approval.requester.sessionId).toBeUndefined()
      // Another shell naming that terminal is not in it.
      other ??= spawn('sleep', ['60'], { stdio: 'ignore' })
      await fs.writeFile(pidFile, `${other.pid}\n`)
      const outside = await curl('/api/v1/approvals', { what: 'Identity: not terminal', terminal_session: sid })
      expect(outside.body.approval.requester.taskId).toBeUndefined()
      expect(outside.body.approval.requester.identity).toBe('none')
    } finally {
      await fs.rm(pidFile, { force: true })
    }
  }, 30_000)
})
