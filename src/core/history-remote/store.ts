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
import type { Readable } from 'node:stream'
import type { HistoryRemoteConfig } from '../types.js'
import type { FetchStore, OffloadStore } from '../../providers/transcript-offload.js'

export const DEFAULT_REMOTE_DAYS = 180
export const DEFAULT_REMOTE_PREFIX = 'walnut-history'
const NETWORK_TIMEOUT_MS = 60_000

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

async function client(r: Pick<ResolvedRemote, 'region' | 'endpoint' | 'forcePathStyle' | 'auth'>) {
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
    requestHandler: { requestTimeout: NETWORK_TIMEOUT_MS },
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
  const getVia = async (remote: { bucket: string; endpoint?: string; region?: string }, key: string, dst: string) => {
    // An object kept in another bucket (the setting changed since) is read where it was put, with these credentials.
    const other = remote.bucket !== r.bucket || (remote.endpoint ?? '') !== (r.endpoint ?? '')
    const use = other ? (await client({ ...r, region: remote.region || r.region, endpoint: remote.endpoint, forcePathStyle: remote.endpoint ? true : r.forcePathStyle })).c : c
    const out = await use.send(new s3.GetObjectCommand({ Bucket: remote.bucket, Key: key }))
    if (!out.Body) throw new Error('empty answer')
    await pipeline(out.Body as Readable, fs.createWriteStream(dst, { mode: 0o600 }))
  }
  return {
    bucket: r.bucket,
    ...(r.endpoint ? { endpoint: r.endpoint } : {}),
    region: r.region,
    async put(key, file, info) {
      await c.send(new s3.PutObjectCommand({
        Bucket: r.bucket, Key: key, Body: fs.createReadStream(file), ContentLength: info.size,
        ContentMD5: Buffer.from(info.md5, 'hex').toString('base64'), ContentType: 'application/gzip',
        Metadata: { sha256: info.sha256 },
      }))
    },
    async head(key) {
      try {
        const h = await c.send(new s3.HeadObjectCommand({ Bucket: r.bucket, Key: key }))
        return { size: Number(h.ContentLength ?? -1), ...(h.ETag ? { etag: h.ETag } : {}) }
      } catch (e) { if (notFound(e)) return null; throw e }
    },
    get: getVia,
    async remove(key) { await c.send(new s3.DeleteObjectCommand({ Bucket: r.bucket, Key: key })) },
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

/**
 * One-click setup on AWS S3 (no custom endpoint): make the bucket private, encrypted and
 * cheap to keep. Creates it when missing; blocks all public access; turns on default
 * encryption (SSE-S3); moves objects to Standard-IA after 30 days. Idempotent.
 */
export async function setupAwsBucket(r: ResolvedRemote): Promise<{ created: boolean; steps: string[] }> {
  if (r.endpoint) throw new Error('One-click setup is for AWS S3; set up a custom endpoint\'s bucket in its own console.')
  if (!r.bucket) throw new Error('No bucket is set.')
  const { s3, c } = await client(r)
  const steps: string[] = []
  let created = false
  try {
    await c.send(new s3.HeadBucketCommand({ Bucket: r.bucket }))
  } catch (e) {
    if (!notFound(e)) throw e
    await c.send(new s3.CreateBucketCommand({
      Bucket: r.bucket,
      ...(r.region && r.region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: r.region as never } } : {}),
    }))
    created = true
    steps.push('created the bucket')
  }
  await c.send(new s3.PutPublicAccessBlockCommand({
    Bucket: r.bucket,
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
  }))
  steps.push('blocked all public access')
  await c.send(new s3.PutBucketEncryptionCommand({
    Bucket: r.bucket,
    ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: true }] },
  }))
  steps.push('turned on default encryption (SSE-S3)')
  await c.send(new s3.PutBucketLifecycleConfigurationCommand({
    Bucket: r.bucket,
    LifecycleConfiguration: { Rules: [{ ID: 'walnut-history-standard-ia', Status: 'Enabled', Filter: { Prefix: `${r.prefix}/` }, Transitions: [{ Days: 30, StorageClass: 'STANDARD_IA' }] }] },
  }))
  steps.push('moves history to Standard-IA after 30 days')
  return { created, steps }
}
