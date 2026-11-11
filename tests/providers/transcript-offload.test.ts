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
import { MANIFEST_SUFFIX, RemoteHistoryError, archiveTranscripts, ensurePlain, restoreSession, setRemoteFetcher } from '../../src/providers/transcript-archive.js'
import { OFFLOAD_KEEP_MS, fetchRemoteArchive, offloadArchived, remoteTierStatus, type OffloadStore } from '../../src/providers/transcript-offload.js'
import { remoteStore, resolveRemote, testRemote } from '../../src/core/history-remote/store.js'
import { fetchLocalArchive } from '../../src/core/history-remote/service.js'
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
  Object.assign(s3.faults, { dropNextPut: 0, corruptNextGet: 0, failAll: false })
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
    const lying: OffloadStore = { ...real, head: async (key) => { const h = await real.head(key); return h ? { ...h, etag: '"' + '0'.repeat(32) + '"' } : h } }
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
