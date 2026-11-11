/**
 * The remote history tier end to end against a fake S3 server (tests/helpers/fake-s3.ts), with
 * the real AWS SDK store (core/history-remote/store.ts): upload and check, the local files kept
 * until a later pass checks again, then removed; opening brings them back checked by hash. The
 * failures: an interrupted upload, an object that does not check out, a local file changed
 * since its upload, a corrupted download, and an open with storage unreachable or no fetcher.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MANIFEST_SUFFIX, RemoteHistoryError, archiveTranscripts, ensurePlain, findNameMatch, plainFindResults, restoreSession, setRemoteFetcher } from '../../src/providers/transcript-archive.js'
import { OFFLOAD_KEEP_MS, fetchRemoteArchive, offloadArchived, remoteTierStatus, type OffloadStore } from '../../src/providers/transcript-offload.js'
import { LIFECYCLE_RULE_ID, remoteStore, remoteTimeouts, resolveRemote, setupBucket, testRemote } from '../../src/core/history-remote/store.js'
import { fetchLocalArchive, remoteStatus, resetTierCount } from '../../src/core/history-remote/service.js'
import { remoteOnlyHere, withRemoteLoading } from '../../src/core/history-remote/loading.js'
import { HostStillLoadingError } from '../../src/core/hosts/remote-read-bound.js'
import { startFakeS3, type FakeS3 } from '../helpers/fake-s3.js'

const DAY = 86_400_000
// Test files are new: the passes run "300 days from now", past the 60-day archive and the 180-day tier.
const LATER = Date.now() + 300 * DAY
const TIER = { olderThanMs: 180 * DAY, now: LATER, keyPrefix: 'walnut-history/test-host' }

let s3: FakeS3
const envKeys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE', 'AWS_SESSION_TOKEN'] as const
const savedEnv: Record<string, string | undefined> = {}
beforeAll(async () => {
  for (const k of envKeys) savedEnv[k] = process.env[k]
  // The fake server ignores signatures; the SDK needs some credentials to sign with.
  process.env.AWS_ACCESS_KEY_ID = 'AKIAFAKEFAKEFAKE'
  process.env.AWS_SECRET_ACCESS_KEY = 'fake-secret'
  delete process.env.AWS_PROFILE
  delete process.env.AWS_SESSION_TOKEN
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
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-offload-'))
  projects = path.join(root, 'projects')
  proj = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  fs.mkdirSync(proj, { recursive: true })
  s3.objects.clear()
  s3.requests.length = 0
  Object.assign(s3.faults, { dropNextPut: 0, corruptNextGet: 0, failAll: false, opaqueEtag: false, hang: false, stallBody: false })
  s3.bucketConfig.clear()
})
afterEach(() => { setRemoteFetcher(null); fs.rmSync(root, { recursive: true, force: true }) })

const setting = () => resolveRemote({ enabled: true, bucket: s3.bucket, endpoint: s3.url, region: 'us-east-1' })
const store = () => remoteStore(setting())
const useFetcher = () => setRemoteFetcher(async (dir, sid) => { await fetchRemoteArchive(dir, sid, await store()) })

const line = (i: number) => JSON.stringify({ type: 'assistant', uuid: `u-${i}`, message: { content: `reply ${i} é中 ${'x'.repeat(200)}` } }) + '\n'
function writeAt(p: string, body: string, mtimeMs: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
}
/** A session archived by both of the archive's steps: only its .gz files and manifest are here. */
async function archived(sid: string) {
  const mtime = Date.now() - 5 * DAY
  const main = Array.from({ length: 300 }, (_, i) => line(i)).join('')
  const agent = Array.from({ length: 100 }, (_, i) => line(i + 1000)).join('')
  writeAt(path.join(proj, `${sid}.jsonl`), main, mtime)
  writeAt(path.join(proj, sid, 'subagents', 'agent-a1.jsonl'), agent, mtime)
  const opts = { olderThanMs: 60 * DAY, now: Date.now() + 100 * DAY }
  await archiveTranscripts([projects], opts)
  await archiveTranscripts([projects], opts)
  expect(fs.existsSync(path.join(proj, `${sid}.jsonl`))).toBe(false)
  expect(fs.existsSync(path.join(proj, `${sid}.jsonl.gz`))).toBe(true)
  return { main, agent }
}
const manifest = (sid: string) => JSON.parse(fs.readFileSync(path.join(proj, sid + MANIFEST_SUFFIX), 'utf8'))
const gz = (rel: string) => path.join(proj, rel + '.gz')

describe('remote history tier (fake S3)', () => {
  it('uploads and checks, keeps the local files until a later pass, then removes them; opening brings them back byte for byte', async () => {
    const body = await archived('s-a')
    const localGz = fs.readFileSync(gz('s-a.jsonl'))

    const first = await offloadArchived([projects], { ...TIER, store: await store() })
    expect(first).toMatchObject({ uploaded: 1, offloaded: 0, waiting: 1, failed: 0 })
    const m1 = manifest('s-a')
    expect(m1.remote.files).toHaveLength(2)
    expect(m1.remote.offloadedAt).toBeUndefined()
    // Uploaded under a name holding its hash, with the very bytes of the local file.
    const key = m1.remote.files.find((f: { rel: string }) => f.rel === 's-a.jsonl').key
    expect(key).toMatch(/^walnut-history\/test-host\/-Users-someone-repo\/s-a\.jsonl\.[0-9a-f]{16}\.gz$/)
    expect(s3.objects.get(key)!.equals(localGz)).toBe(true)
    // The first step removes nothing.
    expect(fs.existsSync(gz('s-a.jsonl'))).toBe(true)
    expect(await remoteOnlyHere('s-a', cwd, [projects])).toBe(false)

    // Not yet OFFLOAD_KEEP_MS later: still waiting.
    const early = await offloadArchived([projects], { ...TIER, now: m1.remote.uploadedAt + 60_000, store: await store() })
    expect(early).toMatchObject({ uploaded: 0, offloaded: 0, waiting: 1 })
    expect(fs.existsSync(gz('s-a.jsonl'))).toBe(true)

    const second = await offloadArchived([projects], { ...TIER, now: m1.remote.uploadedAt + OFFLOAD_KEEP_MS, store: await store() })
    expect(second).toMatchObject({ offloaded: 1, failed: 0 })
    expect(second.freedBytes).toBeGreaterThan(0)
    expect(fs.existsSync(gz('s-a.jsonl'))).toBe(false)
    expect(fs.existsSync(gz('s-a/subagents/agent-a1.jsonl'))).toBe(false)
    expect(manifest('s-a').remote.offloadedAt).toBeGreaterThan(0)
    expect(await remoteOnlyHere('s-a', cwd, [projects])).toBe(true)
    expect(await remoteTierStatus([projects])).toMatchObject({ uploaded: 1, remoteOnly: 1 })
    // The status route never waits on the count past its deadline: no count yet answers `counting`,
    // the scan goes on, and the next ask reads it.
    resetTierCount()
    const off = { session: { history_remote: { enabled: false } } }
    const before = await remoteStatus(off as never, { roots: [projects], waitMs: 0 })
    expect(before).toMatchObject({ counting: true, uploaded: 0 })
    expect(before.countedAt).toBeUndefined()
    // The next ask joins the scan already running and gets its count.
    expect(await remoteStatus(off as never, { roots: [projects], waitMs: 30_000 })).toMatchObject({ counting: false, uploaded: 1, remoteOnly: 1 })
    expect(await remoteStatus(off as never, { roots: [projects], waitMs: 0 })).toMatchObject({ counting: false, uploaded: 1 })

    // Opening: fetched, checked, decompressed.
    useFetcher()
    expect(await ensurePlain(path.join(proj, 's-a.jsonl'))).toBe(true)
    expect(fs.readFileSync(path.join(proj, 's-a.jsonl'), 'utf8')).toBe(body.main)
    expect(fs.readFileSync(path.join(proj, 's-a/subagents/agent-a1.jsonl'), 'utf8')).toBe(body.agent)
    expect(fs.existsSync(path.join(proj, 's-a' + MANIFEST_SUFFIX))).toBe(false)
    // Walnut never removes a remote object.
    expect(s3.objects.has(key)).toBe(true)
    expect(s3.requests.some((r) => r.method === 'DELETE')).toBe(false)
  })

  it('an interrupted upload records nothing and leaves the local files; the next pass uploads', async () => {
    await archived('s-cut')
    // More cuts than the SDK's own retries: the upload fails.
    s3.faults.dropNextPut = 10
    const r = await offloadArchived([projects], { ...TIER, store: await store() })
    expect(r).toMatchObject({ uploaded: 0, failed: 1 })
    expect(manifest('s-cut').remote).toBeUndefined()
    expect(fs.existsSync(gz('s-cut.jsonl'))).toBe(true)
    s3.faults.dropNextPut = 0
    const again = await offloadArchived([projects], { ...TIER, store: await store() })
    expect(again).toMatchObject({ uploaded: 1, failed: 0 })
    for (const f of manifest('s-cut').remote.files) expect(s3.objects.get(f.key)!.length).toBe(f.gzSize)
    expect(fs.existsSync(gz('s-cut.jsonl'))).toBe(true)
  })

  it('an object that does not check out after its upload is not recorded', async () => {
    await archived('s-etag')
    const real = await store()
    // An ETag that is not the md5 has the object read back; what it reads back is other bytes.
    const lying: OffloadStore = {
      ...real,
      head: async (key) => { const h = await real.head(key); return h ? { ...h, etag: '"' + '0'.repeat(32) + '"' } : h },
      readHash: async (key) => { const h = await real.readHash(key); return h ? { ...h, sha256: '0'.repeat(64) } : h },
    }
    const r = await offloadArchived([projects], { ...TIER, store: lying })
    expect(r.failed).toBe(1)
    expect(r.errors[0]).toMatch(/did not check out/)
    expect(manifest('s-etag').remote).toBeUndefined()
    expect(fs.existsSync(gz('s-etag.jsonl'))).toBe(true)
  })

  it('a local file changed since its upload is never removed', async () => {
    await archived('s-chg')
    const r1 = await offloadArchived([projects], { ...TIER, store: await store() })
    expect(r1.uploaded).toBe(1)
    fs.appendFileSync(gz('s-chg.jsonl'), Buffer.from([0]))
    const r2 = await offloadArchived([projects], { ...TIER, now: LATER + OFFLOAD_KEEP_MS, store: await store() })
    expect(r2).toMatchObject({ offloaded: 0, failed: 1 })
    expect(r2.errors[0]).toMatch(/changed since its upload/)
    expect(fs.existsSync(gz('s-chg.jsonl'))).toBe(true)
    expect(manifest('s-chg').remote.offloadedAt).toBeUndefined()
  })

  it('a session with a plain copy here, or not old enough, is left alone', async () => {
    await archived('s-young')
    const young = await offloadArchived([projects], { ...TIER, now: Date.now(), store: await store() })
    expect(young).toMatchObject({ uploaded: 0, failed: 0 })
    fs.writeFileSync(path.join(proj, 's-young.jsonl'), 'a new line\n')
    const plain = await offloadArchived([projects], { ...TIER, store: await store() })
    expect(plain).toMatchObject({ uploaded: 0, failed: 0 })
    expect(s3.objects.size).toBe(0)
  })

  async function offloaded(sid: string) {
    const body = await archived(sid)
    await offloadArchived([projects], { ...TIER, store: await store() })
    await offloadArchived([projects], { ...TIER, now: LATER + OFFLOAD_KEEP_MS, store: await store() })
    expect(await remoteOnlyHere(sid, cwd, [projects])).toBe(true)
    return body
  }

  it('a corrupted download is refused, nothing is put in place, and the next open succeeds', async () => {
    const body = await offloaded('s-bad')
    useFetcher()
    s3.faults.corruptNextGet = 1
    await expect(restoreSession(proj, 's-bad')).rejects.toBeInstanceOf(RemoteHistoryError)
    expect(fs.readdirSync(proj).filter((n) => n.includes('walnut-tmp'))).toEqual([])
    expect(await remoteOnlyHere('s-bad', cwd, [projects])).toBe(true)
    expect(await ensurePlain(path.join(proj, 's-bad.jsonl'))).toBe(true)
    expect(fs.readFileSync(path.join(proj, 's-bad.jsonl'), 'utf8')).toBe(body.main)
  })

  it('opening with storage unreachable, or with no way to fetch, fails plainly and touches nothing', async () => {
    await offloaded('s-off')
    await expect(restoreSession(proj, 's-off')).rejects.toThrow(/in remote storage, and this host cannot fetch it now/)
    // A reader (the daemon's file commands) gets no plain file and reads on as for a missing one.
    expect(await ensurePlain(path.join(proj, 's-off.jsonl'))).toBe(false)
    useFetcher()
    s3.faults.failAll = true
    await expect(restoreSession(proj, 's-off')).rejects.toBeInstanceOf(RemoteHistoryError)
    s3.faults.failAll = false
    expect(await remoteOnlyHere('s-off', cwd, [projects])).toBe(true)
    expect(manifest('s-off').remote.offloadedAt).toBeGreaterThan(0)
    expect(await ensurePlain(path.join(proj, 's-off.jsonl'))).toBe(true)
  })

  it('the server fetches only for a project dir of its own machine', async () => {
    await offloaded('s-svc')
    const cfg = { session: { history_remote: { enabled: true, bucket: s3.bucket, endpoint: s3.url, region: 'us-east-1' } } }
    await expect(fetchLocalArchive('/etc', 's-svc', { config: cfg, roots: [projects] })).rejects.toThrow(/not a session of this machine/)
    await expect(fetchLocalArchive(proj, 's-svc', { config: cfg, roots: [projects] })).resolves.toBe(2)
    expect(fs.existsSync(gz('s-svc.jsonl'))).toBe(true)
  })

  it('Test connection writes, reads back and removes one object; a wrong bucket says so', async () => {
    const ok = await testRemote(setting())
    expect(ok).toMatchObject({ ok: true })
    expect(s3.objects.size).toBe(0)
    expect(s3.requests.map((r) => r.method)).toEqual(['PUT', 'HEAD', 'GET', 'DELETE'])
    const bad = await testRemote(resolveRemote({ enabled: true, bucket: 'nope', endpoint: s3.url, region: 'us-east-1' }))
    expect(bad).toMatchObject({ ok: false, step: 'upload' })
    expect(bad.error).toMatch(/bucket does not exist/i)
  })
})

describe('the loading line while a session downloads', () => {
  it('answers "still loading" when the download outlasts the first wait, and the next request joins it', async () => {
    let runs = 0
    const read = () => { runs++; return new Promise<string>((r) => setTimeout(() => r('history'), 2500)) }
    await expect(withRemoteLoading('k1', true, read)).rejects.toBeInstanceOf(HostStillLoadingError)
    await expect(withRemoteLoading('k1', false, read)).resolves.toBe('history')
    expect(runs).toBe(1)
  })
  it('a session not kept remotely reads as before', async () => {
    await expect(withRemoteLoading('k2', false, async () => 'plain')).resolves.toBe('plain')
    expect(await remoteOnlyHere('nope', cwd, [projects])).toBe(false)
  })
})

describe('review round 1 (2026-11-11): integrity, conflicts, deadlines, setup, find', () => {
  async function offloaded(sid: string) {
    const body = await archived(sid)
    await offloadArchived([projects], { ...TIER, store: await store() })
    await offloadArchived([projects], { ...TIER, now: LATER + OFFLOAD_KEEP_MS, store: await store() })
    expect(await remoteOnlyHere(sid, cwd, [projects])).toBe(true)
    return body
  }
  const flip = (key: string) => { const b = Buffer.from(s3.objects.get(key)!); b[b.length >> 1] ^= 0xff; s3.objects.set(key, b) }

  it('an ETag that looks like an md5 but is not the content\'s (SSE-KMS) has the object read back: it uploads once, and one changed in storage keeps the local files', async () => {
    s3.faults.opaqueEtag = true
    await archived('s-kms')
    const up = await offloadArchived([projects], { ...TIER, store: await store() })
    expect(up).toMatchObject({ uploaded: 1, failed: 0 })
    // The upload's check read the objects back (the ETag is not their md5), and uploaded each once.
    expect(s3.requests.filter((r) => r.method === 'GET').length).toBe(2)
    expect(s3.requests.filter((r) => r.method === 'PUT').length).toBe(2)
    const key = manifest('s-kms').remote.files.find((f: { rel: string }) => f.rel === 's-kms.jsonl').key
    flip(key)
    const r = await offloadArchived([projects], { ...TIER, now: LATER + OFFLOAD_KEEP_MS, store: await store() })
    expect(r).toMatchObject({ offloaded: 0, failed: 1 })
    expect(r.errors[0]).toMatch(/not in remote storage as uploaded/)
    expect(fs.existsSync(gz('s-kms.jsonl'))).toBe(true)
    expect(manifest('s-kms').remote.offloadedAt).toBeUndefined()
  })

  it('an object already under the name with other bytes of the same size is uploaded again', async () => {
    await archived('s-pre')
    const first = await offloadArchived([projects], { ...TIER, now: LATER, store: await store() })
    expect(first.uploaded).toBe(1)
    const m = manifest('s-pre')
    // Forget the upload and spoil the object: the next pass must not take it on its size.
    fs.writeFileSync(path.join(proj, 's-pre' + MANIFEST_SUFFIX), JSON.stringify({ ...m, remote: undefined }))
    for (const f of m.remote.files) flip(f.key)
    const puts = s3.requests.filter((r) => r.method === 'PUT').length
    const again = await offloadArchived([projects], { ...TIER, store: await store() })
    expect(again).toMatchObject({ uploaded: 1, failed: 0 })
    expect(s3.requests.filter((r) => r.method === 'PUT').length).toBe(puts + 2)
    for (const f of manifest('s-pre').remote.files) expect(s3.objects.get(f.key)!.equals(fs.readFileSync(path.join(proj, f.rel + '.gz')))).toBe(true)
  })

  it('a plain file with other bytes written after the offload does not stand in: the archive comes back and both are kept', async () => {
    const body = await offloaded('s-new')
    fs.writeFileSync(path.join(proj, 's-new.jsonl'), 'new unrelated bytes\n')
    useFetcher()
    expect(await restoreSession(proj, 's-new')).toBe(true)
    expect(fs.readFileSync(path.join(proj, 's-new.jsonl'), 'utf8')).toBe('new unrelated bytes\n')
    const conflicts = fs.readdirSync(proj).filter((n) => n.startsWith('s-new.jsonl.walnut-conflict-'))
    expect(conflicts).toHaveLength(1)
    expect(fs.readFileSync(path.join(proj, conflicts[0]), 'utf8')).toBe(body.main)
    expect(fs.readFileSync(path.join(proj, 's-new/subagents/agent-a1.jsonl'), 'utf8')).toBe(body.agent)
    expect(fs.existsSync(path.join(proj, 's-new' + MANIFEST_SUFFIX))).toBe(false)
  })

  it('a plain file holding the recorded bytes (an append after them) stands in: nothing is downloaded for it', async () => {
    const body = await offloaded('s-app')
    fs.writeFileSync(path.join(proj, 's-app.jsonl'), body.main + line(9999))
    useFetcher()
    const gets = () => s3.requests.filter((r) => r.method === 'GET' && r.key.includes('/s-app.jsonl.')).length
    expect(await restoreSession(proj, 's-app')).toBe(true)
    expect(gets()).toBe(0)
    expect(fs.readFileSync(path.join(proj, 's-app.jsonl'), 'utf8')).toBe(body.main + line(9999))
    expect(fs.readdirSync(proj).filter((n) => n.includes('walnut-conflict'))).toEqual([])
  })

  it('a find for <sid>.jsonl matches the manifest of a session only in remote storage and answers its restored transcript', async () => {
    const body = await offloaded('s-find')
    expect(findNameMatch('s-find' + MANIFEST_SUFFIX, 's-find.jsonl')).toBe(true)
    expect(findNameMatch('s-other' + MANIFEST_SUFFIX, 's-find.jsonl')).toBe(false)
    expect(findNameMatch('s-find' + MANIFEST_SUFFIX, 's-find')).toBe(true)
    useFetcher()
    const out = await plainFindResults([path.join(proj, 's-find' + MANIFEST_SUFFIX)], 's-find.jsonl')
    expect(out).toEqual([path.join(proj, 's-find.jsonl')])
    expect(fs.readFileSync(out[0], 'utf8')).toBe(body.main)
    // A manifest a find for something else matched (a substring) is still left out.
    expect(await plainFindResults([path.join(proj, 's-x' + MANIFEST_SUFFIX)], 's-x')).toEqual([])
  })

  describe('a storage that takes requests and never answers', () => {
    const saved = { ...remoteTimeouts }
    beforeEach(() => Object.assign(remoteTimeouts, { networkMs: 400, connectMs: 400 }))
    afterEach(() => Object.assign(remoteTimeouts, saved))

    it('fails a check within its deadline instead of hanging', async () => {
      s3.faults.hang = true
      const t0 = Date.now()
      await expect((await store()).head('walnut-history/x')).rejects.toThrow()
      expect(Date.now() - t0).toBeLessThan(5_000)
      const r = await offloadArchived([projects], { ...TIER, store: await store() })
      expect(r.failed).toBe(0)
      await archived('s-hang')
      const t1 = Date.now()
      const p = await offloadArchived([projects], { ...TIER, store: await store() })
      expect(p).toMatchObject({ uploaded: 0, failed: 1 })
      expect(Date.now() - t1).toBeLessThan(10_000)
    })

    it('a credential source that never answers ends at the deadline too, and is not started again per call', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cred-'))
      const count = path.join(dir, 'count')
      const script = path.join(dir, 'slow-creds.sh')
      fs.writeFileSync(script, `#!/bin/sh\necho x >> ${count}\nsleep 30\n`, { mode: 0o755 })
      fs.writeFileSync(path.join(dir, 'config'), `[profile slow]\ncredential_process = ${script}\n`)
      fs.writeFileSync(path.join(dir, 'credentials'), '')
      const env = { cfg: process.env.AWS_CONFIG_FILE, cred: process.env.AWS_SHARED_CREDENTIALS_FILE }
      process.env.AWS_CONFIG_FILE = path.join(dir, 'config')
      process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(dir, 'credentials')
      try {
        const r = resolveRemote({ enabled: true, bucket: s3.bucket, endpoint: s3.url, region: 'us-east-1', auth: { method: 'profile', profile: 'slow' } })
        for (let i = 0; i < 3; i++) {
          const t0 = Date.now()
          await expect((await remoteStore(r)).head('walnut-history/x')).rejects.toThrow(/did not finish/)
          expect(Date.now() - t0).toBeLessThan(3_000)
        }
        expect(s3.requests).toEqual([])
        // One credential process for every call: the waits share it.
        expect(fs.readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1)
      } finally {
        if (env.cfg === undefined) delete process.env.AWS_CONFIG_FILE; else process.env.AWS_CONFIG_FILE = env.cfg
        if (env.cred === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE; else process.env.AWS_SHARED_CREDENTIALS_FILE = env.cred
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('a download whose body stops is ended and leaves nothing behind', async () => {
      await offloaded('s-stall')
      useFetcher()
      s3.faults.stallBody = true
      const t0 = Date.now()
      await expect(restoreSession(proj, 's-stall')).rejects.toBeInstanceOf(RemoteHistoryError)
      expect(Date.now() - t0).toBeLessThan(10_000)
      expect(fs.readdirSync(proj).filter((n) => n.includes('walnut-tmp'))).toEqual([])
      s3.faults.stallBody = false
      expect(await ensurePlain(path.join(proj, 's-stall.jsonl'))).toBe(true)
    })
  })

  it('Set up on a bucket that exists keeps its encryption and its other lifecycle rules', async () => {
    const kms = '<?xml version="1.0" encoding="UTF-8"?><ServerSideEncryptionConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm><KMSMasterKeyID>alias/team</KMSMasterKeyID></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>'
    const lc = '<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>expire-logs</ID><Filter><Prefix>logs/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>14</Days></Expiration></Rule></LifecycleConfiguration>'
    s3.bucketConfig.set('encryption', kms)
    s3.bucketConfig.set('lifecycle', lc)
    const r = await setupBucket(setting())
    expect(r.created).toBe(false)
    expect(r.steps.join('; ')).toMatch(/keeps its default encryption \(aws:kms\)/)
    expect(r.steps.join('; ')).toMatch(/1 other lifecycle rule kept/)
    expect(s3.bucketConfig.get('encryption')).toBe(kms)
    // Nothing was put over the public access settings of a bucket that exists.
    expect(s3.bucketConfig.has('publicAccessBlock')).toBe(false)
    const after = s3.bucketConfig.get('lifecycle')!
    expect(after).toContain('<ID>expire-logs</ID>')
    expect(after).toContain('<Days>14</Days>')
    expect(after).toContain(`<ID>${LIFECYCLE_RULE_ID}</ID>`)
    // Again: still one rule of ours, the other kept.
    await setupBucket(setting())
    const twice = s3.bucketConfig.get('lifecycle')!
    expect(twice.split(`<ID>${LIFECYCLE_RULE_ID}</ID>`).length).toBe(2)
    expect(twice).toContain('<ID>expire-logs</ID>')
  })

  it('Set up on a bucket with no encryption or rules turns on SSE-S3 and adds only its rule', async () => {
    const r = await setupBucket(setting())
    expect(r.steps.join('; ')).toMatch(/turned on default encryption \(SSE-S3\)/)
    expect(s3.bucketConfig.get('encryption')).toContain('AES256')
    expect(s3.bucketConfig.get('lifecycle')).toContain(`<Prefix>walnut-history/</Prefix>`)
  })
})

