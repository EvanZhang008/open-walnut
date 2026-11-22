/**
 * A standby target on another host (docs/reference/standby-copy.md, "A target on another
 * host"), reached through that host's daemon over Walnut's own link (src/core/hosts/link.ts):
 * no port, credential or daemon command of its own.
 *
 *   chunks     staged on this machine's disk first (remote-spool.ts: the batch reads at the disk's
 *              pace, so its database pins end soon after its moment), then fs.writePart, one
 *              1 MiB chunk a part: the daemon checks the part's sha256 (the chunk's name) and only
 *              then renames it into chunks/, so a chunk is there whole or not at all, and a batch
 *              cut off part way leaves every chunk it sent for the next
 *   the batch  an upload (BatchUpload: the files that differ from the target's batch) written
 *              into the target the same way, then `walnut standby receive apply` run there as a
 *              background job (remote-apply.ts, `exec.run`), followed through its status file:
 *              the same StandbyTarget.commit a local target runs
 *   reads      `walnut standby receive init` (makes the target owner-only, finishes an apply a
 *              kill cut off, and exports its chunk list and current files when this side lacks
 *              them), read back with fs.readRange
 *
 * The machine there needs the walnut program (`standby.walnut`, default `walnut`).
 *
 * A dropped link is dialled again and the command sent again for up to `linkWaitMs`; only
 * commands that do the same thing twice are sent twice. An apply whose answer was lost is
 * judged by what the target holds afterwards, never by sending it again.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { linkFailureKind, markLinkFailure } from '../../providers/link-failure.js'
import { MAX_UPLOAD_FRAME_BYTES } from '../../providers/ssh-upload-budget.js'
import { SCRIPT_MAX_TIMEOUT_MS } from '../../providers/host-script-core.js'
import { runScriptOnHost } from '../hosts/host-script.js'
import { HOST_EXEC_DETACH_CAPABILITY, workSurvives } from '../hosts/work-survives.js'
import { statusFileName } from './apply-status.js'
import { sha256 } from './chunks.js'
import { INCOMING, RECEIVE_MARK, type ApplyAnswer, type InitAnswer, type ManifestRef, type TargetExport, type VerifyAnswer } from './receive.js'
import { runApplyJob, type ApplyJobLink, type JobProbe } from './remote-apply.js'
import { ChunkSpool } from './remote-spool.js'
import { chunkIds, type BatchFile, type BatchManifest, type BatchUpload, type CommitResult, type StandbyState, type StandbyTransport } from './types.js'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

/** What this needs of a daemon link (DaemonConnection). A refusal comes back as `{ok: false}`. */
export interface DaemonLink {
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  hasCapability?(name: string): boolean
}

export interface RemoteTargetOptions {
  /** The link to the standby host's daemon; asked again after one drops (`link(host)` in the server). */
  connect(): Promise<DaemonLink>
  /** The target directory there (absolute). */
  dir: string
  /** The walnut program there, as a program and its arguments (default ['walnut']). */
  walnut?: string[]
  /** How long a dropped link is waited for before the batch fails (default 2 min). */
  linkWaitMs?: number
  /** Chunks in flight at once (default 8): enough to keep a slow link busy. */
  window?: number
  /** Where chunks wait to go, on this machine (the home's `tmp/standby-spool`). */
  spoolDir: string
  /** Bytes the spool's disk keeps free (default: 2 GiB or 1% of the disk, the larger). */
  spoolReserveBytes?: number
  /** The spool disk's free and total bytes (tests). */
  statfs?(dir: string): Promise<{ free: number; total: number }>
  /** How often a running apply's status is read (default 2 s, then 5 s). */
  applyPollMs?: number
  /** How long a running apply may go without a new heartbeat before the host is asked about it (default 20 s). */
  applyLateMs?: number
  /** Variables for the receive runs there (tests: a kill point). */
  env?: Record<string, string>
}

/** The host answered `{ok: false}`: the command ran and was refused. */
export class RemoteRefusal extends Error {
  readonly code: string
  readonly have: number | undefined
  constructor(cmd: string, reply: Record<string, unknown>) {
    super(`${cmd}: ${typeof reply.error === 'string' ? reply.error : 'refused'}`)
    this.name = 'RemoteRefusal'
    this.code = typeof reply.code === 'string' ? reply.code : ''
    this.have = typeof reply.have === 'number' ? reply.have : undefined
  }
}

/** One part of an upload (the daemon's upload budget, ssh-upload-budget.ts). */
/** One fs.writePart part: a daemon frame's cap (ssh-upload-budget.ts), so no part outlasts a keepalive at the bulk pace. */
const PART_BYTES = MAX_UPLOAD_FRAME_BYTES
const READ_BYTES = 4 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 60_000
const SHORT_RUN_MS = 2 * 60_000
const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const nonce = () => crypto.randomBytes(6).toString('hex')
const closedError = () => new Error('the standby target was closed (the standby stopped or its settings changed)')

export interface RemoteStats {
  /** Daemon commands answered, and those sent again after a dropped link. */
  commands: number
  resent: number
  /** Payload bytes written there (chunks and uploads, before base64). */
  sentBytes: number
  /** How long the last apply ran there, its answer's way back included (ms). */
  lastApplyMs: number
  /** Bytes staged in the spool, the most it held at once, and the time its writes took (ms). */
  spooledBytes: number
  spoolPeakBytes: number
  spoolWriteMs: number
}

export class RemoteStandbyTarget implements StandbyTransport {
  readonly stats: RemoteStats = { commands: 0, resent: 0, sentBytes: 0, lastApplyMs: 0, spooledBytes: 0, spoolPeakBytes: 0, spoolWriteMs: 0 }
  /** The last command gave up on a link that stayed down (the runner skips its retries then). */
  unreachable = false
  /** The last apply's answer (its verify pass and the drift reports waiting). */
  lastApply: ApplyAnswer | null = null
  /** The batch the target held when last read or made (undefined: not read yet). */
  seen: { batch: number; takenAt: string } | null | undefined = undefined
  /** The spool's total when the batch under way started, and the batch being applied there. */
  private batchSpoolStart = 0
  private applying: number | null = null
  private link: DaemonLink | null = null
  /** The target's current files as last read or made, and the manifest file they came from. */
  private base: { ref: ManifestRef; files: BatchFile[] } | null = null
  /** Chunk ids the target holds (null: not read yet, or dropped after a failure). */
  private held: Set<string> | null = null
  private viewed: { state: StandbyState; files: BatchFile[] } | null = null
  /** Chunks waiting to go, on this machine's disk. */
  private readonly spool: ChunkSpool
  private closed = false
  private readonly dir: string
  private readonly incoming: string

  constructor(private readonly o: RemoteTargetOptions) {
    if (!path.isAbsolute(o.dir)) throw new Error(`the standby directory on the host must be absolute: ${o.dir}`)
    this.dir = path.resolve(o.dir)
    this.incoming = path.join(this.dir, INCOMING)
    this.spool = new ChunkSpool({
      root: o.spoolDir, window: o.window ?? 8, reserveBytes: o.spoolReserveBytes, statfs: o.statfs,
      send: async (id, data) => {
        await this.writeFile(path.join(this.dir, 'chunks', id.slice(0, 2), id), data)
        this.held?.add(id)
      },
    })
  }

  private async conn(): Promise<DaemonLink> {
    if (this.link) return this.link
    try {
      this.link = await this.o.connect()
    } catch (err) {
      // A host Walnut does not know never comes: say so at once.
      if (err instanceof Error && err.name === 'UnknownHostError') throw err
      // No route now: wait for it like a dropped one.
      throw markLinkFailure(err instanceof Error ? err : new Error(String(err)), 'no-link')
    }
    return this.link
  }

  /**
   * Stop: drop the chunks waiting to go and refuse every later call (the runner stopped, or its
   * settings changed). Parts already on the wire finish there; nothing after them is sent.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.spool.close(closedError())
  }

  private open(): void {
    if (this.closed) throw closedError()
  }

  /** One daemon command, sent again over a new link while the link is down (only commands that may run twice). */
  private async call(cmd: string, params: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const until = Date.now() + (this.o.linkWaitMs ?? 120_000)
    for (let attempt = 0; ; attempt++) {
      this.open()
      let reply: Record<string, unknown>
      try {
        reply = await (await this.conn()).send(cmd, params, timeoutMs)
      } catch (err) {
        if (linkFailureKind(err) && Date.now() >= until) this.unreachable = true
        if (!linkFailureKind(err) || Date.now() >= until) throw err
        this.link = null
        this.stats.resent++
        await sleep(Math.min(5_000, 250 * 2 ** attempt))
        continue
      }
      this.unreachable = false
      this.stats.commands++
      if (reply.ok === false) throw new RemoteRefusal(cmd, reply)
      return reply
    }
  }

  /**
   * Write `data` at `remote` with fs.writePart: staged beside it, checked by size and sha256,
   * then renamed into place. A part the daemon lost (a restart) is sent again from what it holds.
   */
  private async writeFile(remote: string, data: Buffer): Promise<void> {
    const sha = sha256(data)
    let restarted = false
    for (let off = 0; ;) {
      const part = data.subarray(off, off + PART_BYTES)
      const final = off + part.length >= data.length
      try {
        await this.call('fs.writePart', { path: remote, offset: off, data: part.toString('base64'), final, size: data.length, sha256: sha })
      } catch (err) {
        if (!(err instanceof RemoteRefusal)) throw err
        if (err.code === 'gap' && err.have !== undefined && err.have >= 0 && err.have < off) { off = err.have; continue }
        // The staging went wrong under it (a torn part): once more from the start.
        if ((err.code === 'checksum_mismatch' || err.code === 'size_mismatch') && !restarted) { restarted = true; off = 0; continue }
        throw err
      }
      this.stats.sentBytes += part.length
      if (final) return
      off += part.length
    }
  }

  private async readFile(remote: string): Promise<Buffer> {
    const parts: Buffer[] = []
    for (let start = 0; ;) {
      const r = await this.call('fs.readRange', { path: remote, start, length: READ_BYTES })
      const data = Buffer.from(typeof r.data === 'string' ? r.data : '', 'base64')
      parts.push(data)
      start += data.length
      if (r.eof === true || !data.length) break
    }
    return Buffer.concat(parts)
  }

  /** The command line of `walnut standby receive <op>` there. */
  private receiveArgv(op: string, args: string[]): string[] {
    const env = Object.entries(this.o.env ?? {}).map(([k, v]) => `${k}=${v}`)
    return [...(env.length ? ['env', ...env] : []), ...(this.o.walnut ?? ['walnut']), 'standby', 'receive', op, this.dir, ...args]
  }

  /** What the background apply needs of this link (remote-apply.ts). */
  private jobLink(): ApplyJobLink {
    return {
      call: (cmd, params, timeoutMs) => this.call(cmd, params, timeoutMs),
      readText: async (file) => {
        try {
          return (await this.readFile(file)).toString('utf8')
        } catch (err) {
          if (err instanceof RemoteRefusal && /\(ENOENT\)/.test(err.message)) return null
          throw err
        }
      },
      probe: (file) => this.receiveAgain<JobProbe>('job', ['--status', file]),
      hasCapability: (name) => this.link?.hasCapability?.(name) ?? false,
      detach: async () => workSurvives(await this.conn(), HOST_EXEC_DETACH_CAPABILITY),
    }
  }

  /** `walnut standby receive <op>` there; its JSON answer. */
  private async receive<T>(op: string, args: string[], timeoutMs = SHORT_RUN_MS): Promise<T> {
    this.open()
    const argv = this.receiveArgv(op, args)
    const run = await runScriptOnHost('standby', { script: 'exec "$@"\n', args: argv, timeoutMs, maxOutputBytes: 8 * 1024 * 1024 }, {
      dial: async () => this.conn(),
    }).catch((err) => { if (linkFailureKind(err)) this.link = null; throw err })
    this.stats.commands++
    const line = run.stdout.split('\n').reverse().find((l) => l.startsWith(RECEIVE_MARK))
    if (!line) {
      const why = run.timedOut ? `it ran past ${Math.round(timeoutMs / 1000)} s and was stopped` : `exit ${run.code ?? 'none'}`
      throw new Error(`standby receive ${op} on the host gave no answer (${why}): ${run.stderr.slice(-500).trim()}`)
    }
    const answer = JSON.parse(line.slice(RECEIVE_MARK.length)) as T & { error?: string }
    if (typeof answer.error === 'string') throw new Error(`standby receive ${op} on the host: ${answer.error}`)
    return answer
  }

  /** A receive op that does the same thing twice, sent again while the link is down. */
  private async receiveAgain<T>(op: string, args: string[], timeoutMs = SHORT_RUN_MS): Promise<T> {
    const until = Date.now() + (this.o.linkWaitMs ?? 120_000)
    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await this.receive<T>(op, args, timeoutMs)
        this.unreachable = false
        return answer
      } catch (err) {
        if (linkFailureKind(err) && Date.now() >= until) this.unreachable = true
        if (!linkFailureKind(err) || Date.now() >= until) throw err
        this.stats.resent++
        await sleep(Math.min(5_000, 250 * 2 ** attempt))
      }
    }
  }

  /** Forget what this side believes the target holds (after anything failed). */
  private reset(): void {
    this.base = null
    this.held = null
    this.viewed = null
  }

  async current(): Promise<{ state: StandbyState; files: BatchFile[] }> {
    // What a void batch left to send still goes (the next batch need not send it); a failure forgets what the target holds.
    await this.spool.settle()
    this.open()
    if (this.spool.takeFailure()) this.reset()
    const exportTo = path.join(this.incoming, `export-${nonce()}.json.gz`)
    const args = ['--export', exportTo, '--files', ...(this.base ? ['--have-manifest', JSON.stringify(this.base.ref)] : []), ...(this.held ? [] : ['--chunks'])]
    const init = await this.receiveAgain<InitAnswer>('init', args)
    this.see(init.state)
    this.batchSpoolStart = this.spool.stats.spooledBytes
    const got = init.exported ? JSON.parse((await gunzip(await this.readFile(init.exported.path))).toString('utf8')) as TargetExport : {}
    if (got.chunks) this.held = new Set(got.chunks)
    let files: BatchFile[]
    if (got.files) {
      files = got.files
      this.base = init.manifest ? { ref: init.manifest, files } : null
    } else {
      files = init.manifest && this.base ? this.base.files : []
    }
    this.viewed = { state: init.state, files }
    return this.viewed
  }

  async missing(ids: string[]): Promise<Set<string>> {
    if (!this.held) throw new Error('the target was not read yet (current() first)')
    return new Set(ids.filter((id) => !this.held!.has(id)))
  }

  async putChunk(id: string, data: Buffer): Promise<void> {
    this.open()
    if (sha256(data) !== id) throw new Error(`chunk ${id} does not match its hash`)
    await this.spool.put(id, data)
    this.stats.spooledBytes = this.spool.stats.spooledBytes
    this.stats.spoolPeakBytes = this.spool.stats.peakBytes
    this.stats.spoolWriteMs = this.spool.stats.writeMs
  }

  /** Send every chunk staged; throws the first one that failed (and forgets what the target holds). */
  async flush(): Promise<void> {
    await this.spool.settle()
    this.open()
    const err = this.spool.takeFailure()
    if (err) { this.reset(); throw err }
  }

  async commit(manifest: BatchManifest): Promise<CommitResult> {
    await this.flush()
    const viewed = this.viewed
    if (!viewed) throw new Error('the target was not read yet (current() first)')
    this.viewed = null
    const before = new Map(viewed.files.map((f) => [f.p, f]))
    const puts = manifest.files.filter((f) => { const b = before.get(f.p); return !b || JSON.stringify(b) !== JSON.stringify(f) })
    const next = new Set(manifest.files.map((f) => f.p))
    const dels = viewed.files.filter((f) => !next.has(f.p)).map((f) => f.p)
    const { files: _files, ...head } = manifest
    const upload: BatchUpload = {
      format: 'walnut-standby-upload', version: 1, base: viewed.state.current?.batch ?? null, head, puts, dels,
      hash: sha256(Buffer.from(JSON.stringify(manifest))),
    }
    const file = path.join(this.incoming, `upload-${manifest.batch}-${nonce()}.json.gz`)
    try {
      await this.writeFile(file, await gzip(Buffer.from(JSON.stringify(upload))))
    } catch (err) {
      this.reset()
      throw err
    }
    let answer: ApplyAnswer
    const applyStarted = performance.now()
    // One job id per batch: a start sent again never runs the apply twice (remote-apply.ts).
    const jobId = `hx-standby-${sha256(Buffer.from(`${this.dir}\n${manifest.batch}\n${manifest.takenAt}\n${upload.hash}`)).slice(0, 40)}`
    const statusFile = path.join(this.incoming, statusFileName(jobId))
    try {
      this.open()
      this.applying = manifest.batch
      answer = await runApplyJob<ApplyAnswer>(this.jobLink(), {
        jobId, statusFile, pollMs: this.o.applyPollMs, lateMs: this.o.applyLateMs,
        argv: this.receiveArgv('apply', ['--upload', file, '--verify', '--status', statusFile]),
      })
      this.stats.lastApplyMs = performance.now() - applyStarted
      this.applying = null
    } catch (err) {
      this.applying = null
      // Its end could not be followed (the link went, the start was refused): what the target holds
      // now says which. One that still runs there answers "busy": this batch counts as failed, and
      // the next starts from whatever it left.
      const now = await this.receiveAgain<InitAnswer>('init', []).catch(() => null)
      if (now) this.see(now.state)
      const took = now?.state.current?.batch === manifest.batch && now.state.current.takenAt === manifest.takenAt
      this.reset()
      if (!took) throw err
      const changed = puts.filter((f) => { const b = before.get(f.p); return !b || b.h !== f.h || !!b.x !== !!f.x }).length
      this.lastApply = null
      this.seen = { batch: manifest.batch, takenAt: manifest.takenAt }
      return { batch: manifest.batch, written: changed, deleted: dels.length, unchanged: !changed && !dels.length }
    }
    // A batch that changed no content writes no manifest: the target keeps the one it had.
    if (!answer.commit.unchanged && answer.manifest) this.base = { ref: answer.manifest, files: manifest.files }
    this.forgetReplaced(manifest, before, puts, dels)
    this.lastApply = answer
    this.seen = { batch: manifest.batch, takenAt: manifest.takenAt }
    return answer.commit
  }

  private see(state: StandbyState): void {
    this.seen = state.current ? { batch: state.current.batch, takenAt: state.current.takenAt } : null
  }

  /** Where the batch under way stands, for a notice: its apply there, or its chunks sent so far (null: nothing to say). */
  progress(): string | null {
    if (this.applying !== null) return `batch ${this.applying} is being applied there`
    const staged = this.spool.stats.spooledBytes - this.batchSpoolStart
    if (staged <= 0) return null
    return `${mb(staged - this.spool.heldBytes)} of the ${mb(staged)} staged so far went`
  }

  /**
   * The target removed the chunks only the replaced versions used (StandbyTarget's finish):
   * forget them here too, so a file put back to an old version sends its chunks again.
   */
  private forgetReplaced(manifest: BatchManifest, before: Map<string, BatchFile>, puts: BatchFile[], dels: string[]): void {
    if (!this.held) return
    const keep = new Set<string>()
    for (const f of manifest.files) for (const id of chunkIds(f)) keep.add(id)
    for (const p of [...puts.map((f) => f.p), ...dels]) {
      const old = before.get(p)
      if (old) for (const id of chunkIds(old)) if (!keep.has(id)) this.held.delete(id)
    }
  }

  /** A verify pass there; answers its result and the drift reports not yet handed on. */
  verify(opts: { deep?: boolean } = {}): Promise<VerifyAnswer> {
    return this.receiveAgain<VerifyAnswer>('verify', opts.deep ? ['--deep'] : [], opts.deep ? SCRIPT_MAX_TIMEOUT_MS : SHORT_RUN_MS)
  }

  /** Mark the drift report taken at `at` as handed to Walnut Health. */
  async markReported(at: string): Promise<void> {
    await this.receiveAgain<{ marked: number }>('reported', ['--at', at])
  }

  /** The target's state, read there. */
  async state(): Promise<StandbyState> {
    const { state } = await this.receiveAgain<InitAnswer>('init', [])
    this.see(state)
    return state
  }
}
