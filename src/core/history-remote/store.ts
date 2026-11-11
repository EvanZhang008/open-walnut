/**
 * The remote history tier's storage: any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO
 * and the like), reached with the AWS SDK the server already ships. Credentials come only
 * from the AWS chain (env, the default profile, SSO, an instance role, credential_process)
 * or a named profile of ~/.aws (a 0600 file): never from config.yaml, and nothing here logs
 * them. Requests send a checksum only when asked (`WHEN_REQUIRED`): an upload carries its
 * Content-MD5, which every S3-compatible store checks, and no store needs the SDK's
 * chunked checksum encoding.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Writable, type Readable } from 'node:stream'
import type { HistoryRemoteConfig } from '../types.js'
import type { FetchStore, OffloadStore } from '../../providers/transcript-offload.js'

export const DEFAULT_REMOTE_DAYS = 180
export const DEFAULT_REMOTE_PREFIX = 'walnut-history'
/**
 * A request with no answer, or a socket quiet, `networkMs` long fails (the SDK only warns
 * unless told to throw); a whole operation, retries included, gets `networkMs` plus its bytes
 * at `minRate` per second. Mutable for tests only.
 */
export const remoteTimeouts = { networkMs: 60_000, connectMs: 15_000, minRate: 128 * 1024 }

/**
 * One operation's deadline, retries and a download's body included: past it the request is
 * destroyed and the operation fails, so nothing holds a session's lock or a pass forever.
 * `extend` moves it once the size is known (a download's length).
 */
export function opDeadline(bytes = 0): { signal: AbortSignal; extend(bytes: number): void; done(): void; race<T>(p: Promise<T>): Promise<T> } {
  const ac = new AbortController()
  let t: ReturnType<typeof setTimeout> | undefined
  const arm = (n: number) => {
    if (t) clearTimeout(t)
    const ms = opMs(n)
    t = setTimeout(() => ac.abort(Object.assign(new Error(`remote storage did not finish in ${Math.round(ms / 1000)} s`), { name: 'TimeoutError' })), ms)
    t.unref?.()
  }
  arm(bytes)
  // Not every step reads the signal (a credential_process the SDK waits on before any request
  // does not): the deadline also ends the wait itself, whatever it is waiting on.
  const race = <T,>(p: Promise<T>): Promise<T> => {
    p.catch(() => {})
    if (ac.signal.aborted) return Promise.reject(ac.signal.reason)
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(ac.signal.reason)
      ac.signal.addEventListener('abort', stop, { once: true })
      p.then((v) => { ac.signal.removeEventListener('abort', stop); resolve(v) }, (e) => { ac.signal.removeEventListener('abort', stop); reject(e) })
    })
  }
  return { signal: ac.signal, extend: arm, done: () => { if (t) clearTimeout(t) }, race }
}

const opMs = (bytes: number) => remoteTimeouts.networkMs + Math.ceil((bytes / remoteTimeouts.minRate) * 1000)

/** Run one SDK call under its own deadline. */
async function within<T>(bytes: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const d = opDeadline(bytes)
  try { return await d.race(fn(d.signal)) } finally { d.done() }
}

export interface ResolvedRemote {
  enabled: boolean
  days: number
  bucket: string
  region: string
  endpoint?: string
  forcePathStyle: boolean
  prefix: string
  auth: { method: 'aws_chain' | 'profile'; profile?: string }
}

/** The tier as set: on only with `enabled`, a bucket, and days above 0. */
export function resolveRemote(cfg: HistoryRemoteConfig | undefined | null): ResolvedRemote {
  const c = cfg ?? {}
  const d = Number(c.days)
  const days = c.days === undefined || c.days === null || !Number.isFinite(d) || d < 0 ? DEFAULT_REMOTE_DAYS : Math.floor(d)
  const endpoint = typeof c.endpoint === 'string' && c.endpoint.trim() ? c.endpoint.trim().replace(/\/+$/, '') : undefined
  const bucket = typeof c.bucket === 'string' ? c.bucket.trim() : ''
  const method = c.auth?.method === 'profile' && c.auth.profile ? 'profile' : 'aws_chain'
  return {
    enabled: c.enabled === true && !!bucket && days > 0,
    days,
    bucket,
    region: (typeof c.region === 'string' && c.region.trim()) || (endpoint ? 'auto' : 'us-west-2'),
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: c.force_path_style ?? !!endpoint,
    prefix: ((typeof c.prefix === 'string' && c.prefix.trim()) || DEFAULT_REMOTE_PREFIX).replace(/^\/+|\/+$/g, ''),
    auth: method === 'profile' ? { method, profile: c.auth!.profile } : { method },
  }
}

/** Object names of this machine: one folder per host, so two machines never share a name. */
export function hostKeyPrefix(r: ResolvedRemote, host = os.hostname()): string {
  const h = host.toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9._-]+/g, '-').slice(0, 64) || 'host'
  return `${r.prefix}/${h}`
}

type S3Mod = typeof import('@aws-sdk/client-s3')

/**
 * One client per setting, kept: its credentials are memoized, so a credential source that never
 * answers is waited on once (each call ends at its deadline), never started again per pass.
 */
const clients = new Map<string, Promise<{ s3: S3Mod; c: InstanceType<S3Mod['S3Client']> }>>()
function client(r: Pick<ResolvedRemote, 'region' | 'endpoint' | 'forcePathStyle' | 'auth'>) {
  const key = JSON.stringify([r.region, r.endpoint ?? '', r.forcePathStyle, r.auth.method, r.auth.profile ?? '', remoteTimeouts])
  let c = clients.get(key)
  if (!c) {
    if (clients.size >= 8) clients.delete(clients.keys().next().value!)
    c = makeClient(r)
    c.catch(() => clients.delete(key))
    clients.set(key, c)
  }
  return c
}

async function makeClient(r: Pick<ResolvedRemote, 'region' | 'endpoint' | 'forcePathStyle' | 'auth'>) {
  const s3: S3Mod = await import('@aws-sdk/client-s3')
  const { fromIni, fromNodeProviderChain } = await import('@aws-sdk/credential-providers')
  const credentials = r.auth.method === 'profile' ? fromIni({ profile: r.auth.profile }) : fromNodeProviderChain()
  const c = new s3.S3Client({
    region: r.region,
    credentials,
    ...(r.endpoint ? { endpoint: r.endpoint } : {}),
    forcePathStyle: r.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: remoteTimeouts.connectMs, requestTimeout: remoteTimeouts.networkMs, socketTimeout: remoteTimeouts.networkMs, throwOnRequestTimeout: true },
  })
  return { s3, c }
}

const notFound = (e: unknown) => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } }
  return x?.name === 'NotFound' || x?.name === 'NoSuchKey' || x?.$metadata?.httpStatusCode === 404
}

/** A store for uploads and checks against the bucket set now. */
export async function remoteStore(r: ResolvedRemote): Promise<OffloadStore & FetchStore & { remove(key: string): Promise<void> }> {
  const { s3, c } = await client(r)
  /** Stream one object into `sink` under one deadline, which grows with its length once that is known. */
  const read = async (use: typeof c, bucket: string, key: string, sink: () => NodeJS.WritableStream) => {
    const d = opDeadline()
    try {
      await d.race((async () => {
        const out = await use.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: d.signal })
        if (!out.Body) throw new Error('empty answer')
        d.extend(Number(out.ContentLength ?? 0))
        await pipeline(out.Body as Readable, sink(), { signal: d.signal })
      })())
    } finally { d.done() }
  }
  const getVia = async (remote: { bucket: string; endpoint?: string; region?: string }, key: string, dst: string) => {
    // An object kept in another bucket (the setting changed since) is read where it was put, with these credentials.
    const other = remote.bucket !== r.bucket || (remote.endpoint ?? '') !== (r.endpoint ?? '')
    const use = other ? (await client({ ...r, region: remote.region || r.region, endpoint: remote.endpoint, forcePathStyle: remote.endpoint ? true : r.forcePathStyle })).c : c
    await read(use, remote.bucket, key, () => {
      const out = fs.createWriteStream(dst, { mode: 0o600 })
      // pipeline() reports its errors; heard here too, so one before it takes the stream is never uncaught.
      out.on('error', () => {})
      return out
    })
  }
  return {
    bucket: r.bucket,
    ...(r.endpoint ? { endpoint: r.endpoint } : {}),
    region: r.region,
    async put(key, file, info) {
      // The answer comes only after the whole body: its wait grows with the size.
      await within(info.size, (abortSignal) => c.send(new s3.PutObjectCommand({
        Bucket: r.bucket, Key: key, Body: fs.createReadStream(file), ContentLength: info.size,
        ContentMD5: Buffer.from(info.md5, 'hex').toString('base64'), ContentType: 'application/gzip',
        Metadata: { sha256: info.sha256 },
      }), { abortSignal, requestTimeout: opMs(info.size) }))
    },
    async head(key) {
      try {
        const h = await within(0, (abortSignal) => c.send(new s3.HeadObjectCommand({ Bucket: r.bucket, Key: key }), { abortSignal }))
        return { size: Number(h.ContentLength ?? -1), ...(h.ETag ? { etag: h.ETag } : {}) }
      } catch (e) { if (notFound(e)) return null; throw e }
    },
    async readHash(key) {
      const sha = createHash('sha256')
      let size = 0
      try {
        await read(c, r.bucket, key, () => new Writable({ write(chunk: Buffer, _e, cb) { size += chunk.length; sha.update(chunk); cb() } }))
      } catch (e) { if (notFound(e)) return null; throw e }
      return { size, sha256: sha.digest('hex') }
    },
    get: getVia,
    async remove(key) { await within(0, (abortSignal) => c.send(new s3.DeleteObjectCommand({ Bucket: r.bucket, Key: key }), { abortSignal })) },
  }
}

/**
 * Test the setting: write, check, read back and remove one small object under the prefix.
 * Answers what failed in plain words; never the credentials.
 */
export async function testRemote(r: ResolvedRemote): Promise<{ ok: boolean; step?: string; error?: string; ms: number }> {
  const started = Date.now()
  if (!r.bucket) return { ok: false, step: 'settings', error: 'No bucket is set.', ms: 0 }
  const key = `${r.prefix}/.walnut-test/${randomBytes(8).toString('hex')}.txt`
  const body = `walnut history storage check ${new Date().toISOString()}\n`
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-remote-test-'))
  let step = 'connect'
  try {
    const store = await remoteStore(r)
    const file = path.join(dir, 'probe.txt')
    await fsp.writeFile(file, body)
    step = 'upload'
    await store.put(key, file, { size: Buffer.byteLength(body), md5: createHash('md5').update(body).digest('hex'), sha256: createHash('sha256').update(body).digest('hex') })
    step = 'check'
    const h = await store.head(key)
    if (!h || h.size !== Buffer.byteLength(body)) throw new Error('the uploaded object is not there with its size')
    step = 'download'
    const back = path.join(dir, 'back.txt')
    await store.get(r, key, back)
    if ((await fsp.readFile(back, 'utf8')) !== body) throw new Error('the object read back differs')
    step = 'remove'
    await store.remove(key)
    return { ok: true, ms: Date.now() - started }
  } catch (e) {
    return { ok: false, step, error: plainError(e), ms: Date.now() - started }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

/** An SDK error in a line a person can act on. */
export function plainError(e: unknown): string {
  const x = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } }
  const name = x?.name ?? ''
  if (/CredentialsProviderError|Could not load credentials/i.test(`${name} ${x?.message ?? ''}`)) return 'No AWS credentials were found (the AWS chain, or the named profile in ~/.aws).'
  if (name === 'NoSuchBucket') return 'The bucket does not exist.'
  if (name === 'AccessDenied' || x?.$metadata?.httpStatusCode === 403) return 'Access denied: the credentials may not use this bucket.'
  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') return 'The storage refused the credentials.'
  return (x?.message || String(e)).slice(0, 300)
}

/** Walnut's own lifecycle rule: its prefix only, so a bucket's other rules are none of its business. */
export const LIFECYCLE_RULE_ID = 'walnut-history-standard-ia'

/**
 * One-click setup on AWS S3 (no custom endpoint): private, encrypted and cheap to keep.
 * A new bucket is made with all public access blocked and default encryption (SSE-S3). A
 * bucket that exists keeps its own settings: its public access settings and its default
 * encryption are read and left as they are (one with none gets SSE-S3), and of its lifecycle
 * rules only Walnut's own (LIFECYCLE_RULE_ID, on the history prefix: Standard-IA after 30
 * days) is added or replaced, every other rule kept. Idempotent.
 */
export async function setupAwsBucket(r: ResolvedRemote): Promise<{ created: boolean; steps: string[] }> {
  if (r.endpoint) throw new Error('One-click setup is for AWS S3; set up a custom endpoint\'s bucket in its own console.')
  return setupBucket(r)
}

/** The setup itself, at whatever endpoint `r` names (tests point it at a fake S3). */
export async function setupBucket(r: ResolvedRemote): Promise<{ created: boolean; steps: string[] }> {
  if (!r.bucket) throw new Error('No bucket is set.')
  const { s3, c } = await client(r)
  // One deadline per call. Typed loosely: the client's send overloads take each command's own types.
  const sendAny = c.send.bind(c) as unknown as (cmd: unknown, o: { abortSignal: AbortSignal }) => Promise<unknown>
  const send = <T = unknown>(cmd: unknown) => within(0, (abortSignal) => sendAny(cmd, { abortSignal }) as Promise<T>)
  const missing = (e: unknown, ...names: string[]) => names.includes((e as { name?: string })?.name ?? '') || notFound(e)
  const steps: string[] = []
  let created = false
  try {
    await send(new s3.HeadBucketCommand({ Bucket: r.bucket }))
  } catch (e) {
    if (!notFound(e)) throw e
    await send(new s3.CreateBucketCommand({
      Bucket: r.bucket,
      ...(r.region && r.region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: r.region as never } } : {}),
    }))
    created = true
    steps.push('created the bucket')
  }
  const block = { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true }
  if (created) {
    await send(new s3.PutPublicAccessBlockCommand({ Bucket: r.bucket, PublicAccessBlockConfiguration: block }))
    steps.push('blocked all public access')
  } else {
    let cur: Partial<typeof block> = {}
    try {
      cur = (await send<{ PublicAccessBlockConfiguration?: Partial<typeof block> }>(new s3.GetPublicAccessBlockCommand({ Bucket: r.bucket }))).PublicAccessBlockConfiguration ?? {}
    } catch (e) { if (!missing(e, 'NoSuchPublicAccessBlockConfiguration')) throw e }
    const all = (Object.keys(block) as (keyof typeof block)[]).every((k) => cur[k] === true)
    steps.push(all ? 'public access is already blocked' : 'left its public access settings as they are (the history objects are private)')
  }
  let alg: string | undefined
  if (!created) {
    try {
      const enc = await send<{ ServerSideEncryptionConfiguration?: { Rules?: { ApplyServerSideEncryptionByDefault?: { SSEAlgorithm?: string } }[] } }>(new s3.GetBucketEncryptionCommand({ Bucket: r.bucket }))
      alg = enc.ServerSideEncryptionConfiguration?.Rules?.find((x) => x.ApplyServerSideEncryptionByDefault?.SSEAlgorithm)?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm
    } catch (e) { if (!missing(e, 'ServerSideEncryptionConfigurationNotFoundError')) throw e }
  }
  if (alg) steps.push(`keeps its default encryption (${alg})`)
  else {
    await send(new s3.PutBucketEncryptionCommand({
      Bucket: r.bucket,
      ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: true }] },
    }))
    steps.push('turned on default encryption (SSE-S3)')
  }
  type Rule = NonNullable<NonNullable<ConstructorParameters<S3Mod['PutBucketLifecycleConfigurationCommand']>[0]['LifecycleConfiguration']>['Rules']>[number]
  let rules: Rule[] = []
  let minSize: string | undefined
  if (!created) {
    try {
      const lc = await send<{ Rules?: Rule[]; TransitionDefaultMinimumObjectSize?: string }>(new s3.GetBucketLifecycleConfigurationCommand({ Bucket: r.bucket }))
      rules = lc.Rules ?? []
      minSize = lc.TransitionDefaultMinimumObjectSize
    } catch (e) { if (!missing(e, 'NoSuchLifecycleConfiguration')) throw e }
  }
  const ours: Rule = { ID: LIFECYCLE_RULE_ID, Status: 'Enabled', Filter: { Prefix: `${r.prefix}/` }, Transitions: [{ Days: 30, StorageClass: 'STANDARD_IA' }] }
  const others = rules.filter((x) => x.ID !== LIFECYCLE_RULE_ID)
  const had = rules.find((x) => x.ID === LIFECYCLE_RULE_ID)
  if (had && JSON.stringify(had) === JSON.stringify(ours)) steps.push('already moves history to Standard-IA after 30 days')
  else {
    await send(new s3.PutBucketLifecycleConfigurationCommand({
      Bucket: r.bucket,
      LifecycleConfiguration: { Rules: [...others, ours] },
      ...(minSize ? { TransitionDefaultMinimumObjectSize: minSize as never } : {}),
    }))
    steps.push(`moves history to Standard-IA after 30 days${others.length ? ` (its ${others.length} other lifecycle ${others.length === 1 ? 'rule' : 'rules'} kept)` : ''}`)
  }
  return { created, steps }
}
