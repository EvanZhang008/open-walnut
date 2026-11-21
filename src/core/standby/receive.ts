/**
 * The receiving side of a standby target on another host (remote-transport.ts): what
 * `walnut standby receive <op> <dir>` runs on the standby machine, asked by the leader through
 * that machine's daemon (`exec.script`). Every op works on a target directory of this machine
 * with the same StandbyTarget a local target uses, so the rules do not change with the place:
 * every chunk and every file checked, one step to switch, a kill or a full disk leaves the batch
 * before whole.
 *
 *   init      make the target (owner-only), finish an apply a kill cut off, and, when asked,
 *             export its chunk list and current files into `.incoming/` for the leader to read
 *   apply     make a batch current from an upload the leader wrote into `.incoming/` (a
 *             BatchUpload: the files that differ from this target's current batch), then verify
 *   verify    find, save and repair direct edits of the copy (verify.ts)
 *   reported  mark one drift report as handed to Walnut Health
 *
 * Each op prints one line, RECEIVE_MARK and its JSON answer, and nothing in the answer is the
 * copy's content. It reads and writes only `dir`: never this machine's own Walnut home.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { CHUNK_ID, sha256 } from './chunks.js'
import { reportPendingDrift, type DriftReport } from './drift.js'
import { StandbyTarget, type CommitHooks } from './target.js'
import { currentFiles, manifestPath, readState, writeDurable, type TargetPaths } from './target-files.js'
import { compareBatchPaths, type BatchFile, type BatchManifest, type BatchUpload, type CommitResult, type StandbyState } from './types.js'
import { verifyStandby, type VerifyResult } from './verify.js'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

export const RECEIVE_MARK = 'walnut-standby-receive: '
export const INCOMING = '.incoming'
/** An upload or export the leader left behind (its link went) is removed after this long. */
const INCOMING_STALE_MS = 60 * 60_000

/** The current manifest file's identity: the leader keeps its parsed files while this holds. */
export interface ManifestRef { n: number; size: number; mtimeMs: number; ino: number }

export interface InitAnswer { state: StandbyState; manifest: ManifestRef | null; exported?: { path: string; size: number } }
export interface ApplyAnswer { commit: CommitResult; manifest: ManifestRef | null; verify?: VerifyResult; pending?: DriftReport[] }
export interface VerifyAnswer { verify: VerifyResult; pending: DriftReport[] }
export interface TargetExport { chunks?: string[]; files?: BatchFile[] }

/** A file the leader names must lie in the target's `.incoming/`, and nowhere else. */
function incomingFile(t: TargetPaths, file: string): string {
  const dir = path.join(t.root, INCOMING)
  const abs = path.resolve(file)
  if (path.dirname(abs) !== dir || !/^[A-Za-z0-9._-]+$/.test(path.basename(abs))) throw new Error(`${file} is not a file of ${dir}`)
  return abs
}

async function manifestRef(t: TargetPaths, state: StandbyState): Promise<ManifestRef | null> {
  if (!state.current) return null
  const st = await fs.stat(manifestPath(t, state.current.manifest))
  return { n: state.current.manifest, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }
}

async function sweepIncoming(dir: string, now: number): Promise<void> {
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const p = path.join(dir, name)
    const st = await fs.lstat(p).catch(() => null)
    if (st && now - st.mtimeMs > INCOMING_STALE_MS) await fs.rm(p, { recursive: true, force: true }).catch(() => {})
  }
}

async function chunkList(t: TargetPaths): Promise<string[]> {
  const out: string[] = []
  for (const sub of await fs.readdir(t.chunks).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(sub)) continue
    for (const name of await fs.readdir(path.join(t.chunks, sub)).catch(() => [] as string[])) if (CHUNK_ID.test(name)) out.push(name)
  }
  return out
}

/** The drift reports not yet handed to Walnut Health. */
async function pendingDrift(t: TargetPaths): Promise<DriftReport[]> {
  const out: DriftReport[] = []
  await reportPendingDrift(t, async (r) => { out.push(r); return false })
  return out
}

export const sameManifestRef = (a: ManifestRef | null | undefined, b: ManifestRef | null | undefined): boolean =>
  !!a && !!b && a.n === b.n && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino

/**
 * `files` exports the current batch's files unless they are the ones the leader already holds
 * (`haveManifest`, the manifest file it read them from, unchanged since).
 */
export async function receiveInit(dir: string, opts: { exportTo?: string; chunks?: boolean; files?: boolean; haveManifest?: ManifestRef | null; now?: number } = {}): Promise<InitAnswer> {
  const target = new StandbyTarget(dir)
  await target.init()
  const t = target.t
  const incoming = path.join(t.root, INCOMING)
  await fs.mkdir(incoming, { recursive: true, mode: 0o700 })
  await sweepIncoming(incoming, opts.now ?? Date.now())
  const state = await readState(t)
  const answer: InitAnswer = { state, manifest: await manifestRef(t, state) }
  if (opts.exportTo) {
    const file = incomingFile(t, opts.exportTo)
    const out: TargetExport = {}
    if (opts.chunks) out.chunks = await chunkList(t)
    if (opts.files && !sameManifestRef(answer.manifest, opts.haveManifest)) out.files = await currentFiles(t, state)
    const gz = await gzip(Buffer.from(JSON.stringify(out)))
    await writeDurable(file, gz, 0o600)
    answer.exported = { path: file, size: gz.length }
  }
  return answer
}

/** The whole manifest from an upload and this target's current batch, checked against the leader's hash. */
export async function composeManifest(t: TargetPaths, upload: BatchUpload): Promise<BatchManifest> {
  if (upload.format !== 'walnut-standby-upload' || upload.version !== 1) throw new Error('not a standby upload this version reads')
  const state = await readState(t)
  const at = state.current?.batch ?? null
  if (upload.base !== at) throw new Error(`the upload is against batch ${upload.base ?? 'none'}, the target holds ${at ?? 'none'}`)
  const files = new Map((upload.base === null ? [] : await currentFiles(t, state)).map((f) => [f.p, f]))
  for (const p of upload.dels) files.delete(p)
  for (const f of upload.puts) files.set(f.p, f)
  const { format, version, batch, takenAt } = upload.head
  const manifest: BatchManifest = { format, version, batch, takenAt, files: [...files.values()].sort(compareBatchPaths) }
  if (sha256(Buffer.from(JSON.stringify(manifest))) !== upload.hash) throw new Error('the rebuilt manifest does not match the leader\'s')
  return manifest
}

export async function receiveApply(dir: string, uploadFile: string, opts: { verify?: boolean; hooks?: CommitHooks } = {}): Promise<ApplyAnswer> {
  const target = new StandbyTarget(dir)
  const t = target.t
  const file = incomingFile(t, uploadFile)
  try {
    const upload = JSON.parse((await gunzip(await fs.readFile(file))).toString('utf8')) as BatchUpload
    const manifest = await composeManifest(t, upload)
    const commit = await target.commit(manifest, opts.hooks)
    const answer: ApplyAnswer = { commit, manifest: await manifestRef(t, await readState(t)) }
    if (opts.verify) {
      answer.verify = await verifyStandby(dir)
      answer.pending = await pendingDrift(t)
    }
    return answer
  } finally {
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

export async function receiveVerify(dir: string, opts: { deep?: boolean } = {}): Promise<VerifyAnswer> {
  const verify = await verifyStandby(dir, { deep: opts.deep })
  return { verify, pending: await pendingDrift(new StandbyTarget(dir).t) }
}

/** Mark the report taken at `at` as handed to Walnut Health; answers how many were marked. */
export async function receiveReported(dir: string, at: string): Promise<{ marked: number }> {
  return { marked: await reportPendingDrift(new StandbyTarget(dir).t, async (r) => r.at === at) }
}

export interface ReceiveOptions {
  export?: string
  chunks?: boolean
  files?: boolean
  /** JSON of a ManifestRef. */
  haveManifest?: string
  upload?: string
  verify?: boolean
  deep?: boolean
  at?: string
}

/** One op of `walnut standby receive <op> <dir>`: its answer (the CLI prints it after RECEIVE_MARK). */
export async function runReceiveOp(op: string, dir: string, o: ReceiveOptions): Promise<unknown> {
  if (op === 'init') {
    return receiveInit(dir, { exportTo: o.export, chunks: o.chunks, files: o.files, haveManifest: o.haveManifest ? JSON.parse(o.haveManifest) as ManifestRef : null })
  }
  if (op === 'apply') {
    if (!o.upload) throw new Error('--upload <file> is required')
    return receiveApply(dir, o.upload, { verify: o.verify })
  }
  if (op === 'verify') return receiveVerify(dir, { deep: o.deep })
  if (op === 'reported') {
    if (!o.at) throw new Error('--at <time> is required')
    return receiveReported(dir, o.at)
  }
  throw new Error(`unknown receive op ${op} (init, apply, verify, reported)`)
}
