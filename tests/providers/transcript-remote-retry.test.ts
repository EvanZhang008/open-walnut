/**
 * A session whose history is only in remote storage, when the fetch fails (2026-11-19: the
 * storage's setting was lost, so every fetch used credentials the storage refused):
 *
 * - reads after a failed fetch take that failure as their answer for a while, instead of asking
 *   the storage again on every read (it was about a hundred fetches an hour for one session);
 * - a start of the session (resume, or a fresh start under its id) asks again, and refuses when
 *   the history cannot come back and its transcript is not here, instead of starting over empty;
 * - an upload records how it reached the bucket (a profile name), so a fetch reaches it again
 *   after the setting is lost or names another bucket.
 * Against a fake S3 server with the real AWS SDK store, as transcript-offload.test.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MANIFEST_SUFFIX, RemoteHistoryError, archiveTranscripts, ensurePlain, restoreForStart, restoreSession, restoreSessionAnywhere, setArchiveLog, setRemoteFetcher } from '../../src/providers/transcript-archive.js'
import { REMOTE_RETRY_FIRST_MS, REMOTE_RETRY_MS, noteRemoteFailure, recentRemoteFailure, resetRemoteFailures } from '../../src/providers/transcript-remote-retry.js'
import { OFFLOAD_KEEP_MS, fetchRemoteArchive, offloadArchived } from '../../src/providers/transcript-offload.js'
import { recordedAuth, remoteStore, remoteTimeouts, resolveRemote } from '../../src/core/history-remote/store.js'
import { fetchLocalArchive } from '../../src/core/history-remote/service.js'
import { startFakeS3, type FakeS3 } from '../helpers/fake-s3.js'
import { classifyDeliveryFailure } from '../../src/providers/delivery-failure.js'

const DAY = 86_400_000
const LATER = Date.now() + 300 * DAY
const TIER = { olderThanMs: 180 * DAY, now: LATER, keyPrefix: 'walnut-history/test-host' }

let s3: FakeS3
const envKeys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'AWS_SESSION_TOKEN', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_EC2_METADATA_DISABLED',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN'] as const
const savedEnv: Record<string, string | undefined> = {}
const savedTimeouts = { ...remoteTimeouts }
beforeAll(async () => {
  for (const k of envKeys) savedEnv[k] = process.env[k]
  s3 = await startFakeS3('walnut-test-history')
})
afterAll(async () => {
  await s3.close()
  for (const k of envKeys) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
})

let root: string
let projects: string
let proj: string
const cwd = '/Users/someone/repo'
const logged: string[] = []
beforeEach(() => {
  // The fake server ignores signatures; the SDK needs some credentials to sign with.
  process.env.AWS_ACCESS_KEY_ID = 'AKIAFAKEFAKEFAKE'
  process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret'
  delete process.env.AWS_PROFILE
  delete process.env.AWS_SESSION_TOKEN
  // The default chain must find nothing but these keys: no instance role, container or web identity.
  process.env.AWS_EC2_METADATA_DISABLED = 'true'
  for (const k of ['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN']) delete process.env[k]
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-remote-retry-'))
  projects = path.join(root, 'projects')
  proj = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(proj, { recursive: true })
  // No shared AWS files of the machine running the test.
  process.env.AWS_CONFIG_FILE = path.join(root, 'aws-config')
  process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(root, 'aws-credentials')
  s3.objects.clear()
  s3.requests.length = 0
  Object.assign(s3.faults, { dropNextPut: 0, corruptNextGet: 0, failAll: false, opaqueEtag: false, hang: false, stallBody: false })
  logged.length = 0
  setArchiveLog((m) => { logged.push(m) })
})
afterEach(() => {
  setRemoteFetcher(null)
  resetRemoteFailures()
  Object.assign(remoteTimeouts, savedTimeouts)
  fs.rmSync(root, { recursive: true, force: true })
})

const setting = (extra: Record<string, unknown> = {}) => resolveRemote({ enabled: true, bucket: s3.bucket, endpoint: s3.url, region: 'us-east-1', ...extra })
const useFetcher = (r = setting()) => setRemoteFetcher(async (dir, sid) => { await fetchRemoteArchive(dir, sid, await remoteStore(r)) })
const gets = () => s3.requests.filter((q) => q.method === 'GET').length

const line = (i: number) => JSON.stringify({ type: 'assistant', uuid: `u-${i}`, message: { content: `reply ${i} é中 ${'x'.repeat(200)}` } }) + '\n'
function writeAt(p: string, body: string, mtimeMs: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
}
/** A session archived, uploaded and removed here: only its manifest is left. */
async function offloaded(sid: string, r = setting()) {
  const mtime = Date.now() - 5 * DAY
  const main = Array.from({ length: 300 }, (_, i) => line(i)).join('')
  writeAt(path.join(proj, `${sid}.jsonl`), main, mtime)
  writeAt(path.join(proj, sid, 'subagents', 'agent-a1.jsonl'), line(9000), mtime)
  const opts = { olderThanMs: 60 * DAY, now: Date.now() + 100 * DAY }
  await archiveTranscripts([projects], opts)
  await archiveTranscripts([projects], opts)
  await offloadArchived([projects], { ...TIER, store: await remoteStore(r) })
  await offloadArchived([projects], { ...TIER, now: LATER + OFFLOAD_KEEP_MS, store: await remoteStore(r) })
  expect(fs.existsSync(path.join(proj, `${sid}.jsonl`)) || fs.existsSync(path.join(proj, `${sid}.jsonl.gz`))).toBe(false)
  expect(manifestOf(sid).remote.offloadedAt).toBeGreaterThan(0)
  return main
}
const manifestOf = (sid: string) => JSON.parse(fs.readFileSync(path.join(proj, sid + MANIFEST_SUFFIX), 'utf8'))

describe('reads after a failed fetch', () => {
  it('take that failure as their answer: many reads ask the storage nothing more and log it once', async () => {
    await offloaded('s-storm')
    useFetcher()
    s3.faults.failAll = true
    const plain = path.join(proj, 's-storm.jsonl')
    expect(await ensurePlain(plain)).toBe(false)
    const asked = s3.requests.length
    expect(asked).toBeGreaterThan(0)
    for (let i = 0; i < 25; i++) expect(await ensurePlain(plain)).toBe(false)
    expect(s3.requests.length).toBe(asked)
    expect(logged.filter((m) => m.includes('s-storm') && m.includes('remote storage failed'))).toHaveLength(1)
    // The answer names the first failure, and nothing moved meanwhile.
    await expect(restoreSession(proj, 's-storm')).rejects.toThrow(RemoteHistoryError)
    expect(fs.existsSync(path.join(proj, 's-storm' + MANIFEST_SUFFIX))).toBe(true)
    expect(fs.existsSync(plain)).toBe(false)
  })

  it('ask again once the wait is over, and a success forgets the failure', async () => {
    const main = await offloaded('s-later')
    useFetcher()
    s3.faults.failAll = true
    const plain = path.join(proj, 's-later.jsonl')
    expect(await ensurePlain(plain)).toBe(false)
    s3.faults.failAll = false
    expect(await ensurePlain(plain)).toBe(false)
    // The failure, aged past the wait: the next read fetches.
    noteRemoteFailure(path.join(proj, 's-later'), 'earlier failure', Date.now() - REMOTE_RETRY_MS - 1)
    expect(await ensurePlain(plain)).toBe(true)
    expect(fs.readFileSync(plain, 'utf8')).toBe(main)
  })

  it('wait a minute after the first failure, twice as long after each next one, ten minutes at most', () => {
    const key = '/p/s-wait'
    let t = 1_000_000
    noteRemoteFailure(key, 'f1', t)
    expect(recentRemoteFailure(key, t + REMOTE_RETRY_FIRST_MS - 1)).not.toBeNull()
    expect(recentRemoteFailure(key, t + REMOTE_RETRY_FIRST_MS)).toBeNull()
    const waits: number[] = []
    let prev = REMOTE_RETRY_FIRST_MS
    for (let i = 0; i < 6; i++) {
      t += prev // the next read that asks again fails again
      noteRemoteFailure(key, `f${i + 2}`, t)
      let w = 0
      while (recentRemoteFailure(key, t + w)) w += 1_000
      waits.push(w)
      prev = w
    }
    expect(waits).toEqual([120_000, 240_000, 480_000, 600_000, 600_000, 600_000])
    // A failure long after the last starts again from a minute.
    t += 3 * REMOTE_RETRY_MS
    noteRemoteFailure(key, 'again', t)
    expect(recentRemoteFailure(key, t + REMOTE_RETRY_FIRST_MS)).toBeNull()
  })

  it('a failure of one session never holds back another', async () => {
    await offloaded('s-one')
    const main = await offloaded('s-two')
    useFetcher()
    s3.faults.failAll = true
    expect(await ensurePlain(path.join(proj, 's-one.jsonl'))).toBe(false)
    s3.faults.failAll = false
    expect(await ensurePlain(path.join(proj, 's-two.jsonl'))).toBe(true)
    expect(fs.readFileSync(path.join(proj, 's-two.jsonl'), 'utf8')).toBe(main)
  })
})

describe('a start of a session kept in remote storage', () => {
  it('asks again whatever a read saw just before, and brings it back', async () => {
    const main = await offloaded('s-open')
    useFetcher()
    s3.faults.failAll = true
    expect(await ensurePlain(path.join(proj, 's-open.jsonl'))).toBe(false)
    s3.faults.failAll = false
    const before = gets()
    expect(await restoreForStart([projects], 's-open')).toBe(path.join(proj, 's-open.jsonl'))
    expect(gets()).toBeGreaterThan(before)
    expect(fs.readFileSync(path.join(proj, 's-open.jsonl'), 'utf8')).toBe(main)
  })

  it('an open that joins a read\'s restore answered by a remembered failure asks the storage itself', async () => {
    const main = await offloaded('s-join')
    useFetcher()
    s3.faults.failAll = true
    expect(await ensurePlain(path.join(proj, 's-join.jsonl'))).toBe(false)
    s3.faults.failAll = false
    const read = restoreSession(proj, 's-join')
    const open = restoreSession(proj, 's-join', { retryRemote: true })
    await expect(read).rejects.toMatchObject({ repeated: true })
    expect(await open).toBe(true)
    expect(fs.readFileSync(path.join(proj, 's-join.jsonl'), 'utf8')).toBe(main)
  })

  it('refuses when the history cannot come back and its transcript is not here, naming why; nothing moves', async () => {
    await offloaded('s-gone')
    useFetcher()
    s3.faults.failAll = true
    const err = await restoreForStart([projects], 's-gone').catch((e) => e)
    expect(err).toBeInstanceOf(RemoteHistoryError)
    expect((err as Error).message).toMatch(/history of session s-gone is kept in remote storage and could not be brought back, so it was not started/)
    expect(fs.readdirSync(proj).filter((n) => n.startsWith('s-gone.'))).toEqual(['s-gone' + MANIFEST_SUFFIX])
    // The refusal, as the server hears it from the daemon, parks the message with its reason:
    // never a retry on every boot and reconnect, each asking the storage again.
    expect(classifyDeliveryFailure(new Error(`Daemon start failed: ${(err as Error).message}`))).toMatchObject({ kind: 'permanent', code: 'history_unavailable' })
    // The old answer for the command that only asks for a path stays: no path.
    expect(await restoreSessionAnywhere([projects], 's-gone')).toBeNull()
    // With no way to fetch at all, the same.
    setRemoteFetcher(null)
    await expect(restoreForStart([projects], 's-gone')).rejects.toThrow(/cannot fetch it now/)
  })

  it('a wait that only ran out passes as it is: the message is tried again, never parked', async () => {
    await offloaded('s-slow')
    const slow = Object.assign(new RemoteHistoryError('the history of s-slow is still coming back from remote storage; try again in a minute'), { passing: true })
    setRemoteFetcher(async () => { throw slow })
    const err = await restoreForStart([projects], 's-slow').catch((e) => e)
    expect(err).toBe(slow)
    expect(classifyDeliveryFailure(new Error(`Daemon start failed: ${(err as Error).message}`)).kind).toBe('transient')
  })

  it('goes on when its transcript is here (written since): the archive stays for a later restore, which keeps both', async () => {
    const old = await offloaded('s-new')
    useFetcher()
    s3.faults.failAll = true
    const plain = path.join(proj, 's-new.jsonl')
    fs.writeFileSync(plain, line(1))
    expect(await restoreForStart([projects], 's-new')).toBe(plain)
    expect(fs.readFileSync(plain, 'utf8')).toBe(line(1))
    expect(fs.existsSync(path.join(proj, 's-new' + MANIFEST_SUFFIX))).toBe(true)
    s3.faults.failAll = false
    expect(await restoreForStart([projects], 's-new')).toBe(plain)
    expect(fs.readFileSync(plain, 'utf8')).toBe(line(1))
    const kept = fs.readdirSync(proj).filter((n) => n.startsWith('s-new.jsonl.walnut-conflict-'))
    expect(kept).toHaveLength(1)
    expect(fs.readFileSync(path.join(proj, kept[0]), 'utf8')).toBe(old)
  })

  it('a session archived nowhere here starts as before', async () => {
    expect(await restoreForStart([projects], 's-fresh')).toBeNull()
    expect(await restoreForStart([projects], '../bad')).toBeNull()
  })
})

describe('the way an upload reached its bucket', () => {
  function writeProfile(name: string) {
    fs.writeFileSync(process.env.AWS_SHARED_CREDENTIALS_FILE!, `[${name}]\naws_access_key_id = AKIAPROFILEFAKE\naws_secret_access_key = profile-secret\n`, { mode: 0o600 })
    fs.writeFileSync(process.env.AWS_CONFIG_FILE!, `[profile ${name}]\nregion = us-east-1\n`, { mode: 0o600 })
  }

  it('is recorded with the upload as a method and a profile name, nothing else', async () => {
    writeProfile('walnut-test-history')
    await offloaded('s-rec', setting({ auth: { method: 'profile', profile: 'walnut-test-history' } }))
    expect(manifestOf('s-rec').remote.auth).toEqual({ method: 'profile', profile: 'walnut-test-history' })
    expect(JSON.stringify(manifestOf('s-rec'))).not.toMatch(/AKIA|secret/)
  })

  it('reaches the bucket again after the setting is lost, where the credentials of the default chain would not', async () => {
    writeProfile('walnut-test-history')
    const main = await offloaded('s-lost', setting({ auth: { method: 'profile', profile: 'walnut-test-history' } }))
    // The setting is gone (2026-11-14: a config write dropped it) and the default chain has nothing.
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    remoteTimeouts.networkMs = 20_000 // a client of its own, not one an earlier test signed in
    useFetcher(resolveRemote(undefined))
    expect(await restoreForStart([projects], 's-lost')).toBe(path.join(proj, 's-lost.jsonl'))
    expect(fs.readFileSync(path.join(proj, 's-lost.jsonl'), 'utf8')).toBe(main)
  })

  it('falls back to the credentials set now when the recorded profile is gone', async () => {
    writeProfile('walnut-test-gone')
    const main = await offloaded('s-moved', setting({ auth: { method: 'profile', profile: 'walnut-test-gone' } }))
    fs.rmSync(process.env.AWS_SHARED_CREDENTIALS_FILE!)
    fs.rmSync(process.env.AWS_CONFIG_FILE!)
    remoteTimeouts.networkMs = 20_002
    // The setting names another bucket now; the default chain (the env keys) still reaches the old one.
    useFetcher(resolveRemote({ enabled: true, bucket: 'another-bucket', region: 'us-east-1' }))
    expect(await restoreForStart([projects], 's-moved')).toBe(path.join(proj, 's-moved.jsonl'))
    expect(fs.readFileSync(path.join(proj, 's-moved.jsonl'), 'utf8')).toBe(main)
  })

  it('a manifest from before the record (no auth) fetches with the setting as before', async () => {
    writeProfile('walnut-test-history')
    await offloaded('s-old', setting({ auth: { method: 'profile', profile: 'walnut-test-history' } }))
    const m = manifestOf('s-old')
    delete m.remote.auth
    fs.writeFileSync(path.join(proj, 's-old' + MANIFEST_SUFFIX), JSON.stringify(m))
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    remoteTimeouts.networkMs = 20_001
    useFetcher(resolveRemote(undefined))
    await expect(restoreForStart([projects], 's-old')).rejects.toBeInstanceOf(RemoteHistoryError)
  })

  it('a fetch under a profile setting with no name says so next to the storage\'s answer', async () => {
    await offloaded('s-hint')
    s3.faults.failAll = true
    const config = { session: { history_remote: { enabled: true, bucket: s3.bucket, endpoint: s3.url, region: 'us-east-1', auth: { method: 'profile' as const } } } }
    await expect(fetchLocalArchive(proj, 's-hint', { config, roots: [projects] })).rejects.toThrow(/names none, so it used the default AWS credentials: name the profile in its settings/)
  })

  it('only a well-formed record is used', () => {
    expect(recordedAuth({ method: 'profile', profile: 'walnut-history' })).toEqual({ method: 'profile', profile: 'walnut-history' })
    expect(recordedAuth({ method: 'aws_chain' })).toEqual({ method: 'aws_chain' })
    expect(recordedAuth({ method: 'profile' })).toBeNull()
    expect(recordedAuth({ method: 'profile', profile: 'x y\n[evil]' })).toBeNull()
    expect(recordedAuth({ method: 'static', key: 'AKIA' })).toBeNull()
    expect(recordedAuth(undefined)).toBeNull()
  })
})
