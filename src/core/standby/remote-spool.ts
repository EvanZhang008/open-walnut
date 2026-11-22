/**
 * The chunks a batch sends to a standby host, held on this machine's disk until they went
 * (remote-transport.ts). A batch reads its files and its databases at the disk's pace and ends
 * its database pins (sqlite-pin.ts) once they are read, whatever the link's pace: over a slow
 * link the first batch takes an hour to send, and a pin held that long keeps the leader's WAL
 * from being checkpointed. The link then sends from here, `window` chunks at a time, and each
 * chunk's file goes once the host has it.
 *
 * Before each chunk is written the disk's free space is read: a chunk that would leave less than
 * the reserve free is refused (SpoolFull), so the batch is void and the disk is never filled.
 * The chunks held already still go. Each spool keeps a folder of its own, named by its process;
 * a folder whose process is gone (a leader killed mid-batch) is removed by the next spool
 * (scratch.ts, which also removes another process's folder left untouched for a day).
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { SPOOL_NAME, removeDeadOwners } from './scratch.js'

export interface SpoolOptions {
  /** The spools' folder on this machine (rebuildable: `tmp/standby-spool` in the home). */
  root: string
  /** Chunks in flight at once. */
  window: number
  /** Send one chunk; resolves once the host has it. */
  send(id: string, data: Buffer): Promise<void>
  /** Bytes the disk keeps free (default: 2 GiB or 1% of the disk, the larger). */
  reserveBytes?: number
  /** The disk's free and total bytes (tests). */
  statfs?(dir: string): Promise<{ free: number; total: number }>
}

/** Staging a chunk would leave the disk with less than the reserve free. */
export class SpoolFull extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpoolFull'
  }
}

const GiB = 1024 ** 3
const gb = (n: number) => `${(n / GiB).toFixed(1)} GB`

async function diskSpace(dir: string): Promise<{ free: number; total: number }> {
  const s = await fs.statfs(dir)
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
}

export class ChunkSpool {
  readonly stats = { spooledBytes: 0, peakBytes: 0, writeMs: 0 }
  /** The first chunk that did not go; later puts throw it. */
  failed: unknown = null
  private readonly dir: string
  private ready: Promise<void> | null = null
  private queue: Array<{ id: string; size: number }> = []
  private queued = new Set<string>()
  private onDisk = 0
  private inflight = new Set<Promise<void>>()
  private waiters: Array<() => void> = []
  private closed = false

  constructor(private readonly o: SpoolOptions) {
    this.dir = path.join(o.root, `${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  }

  private prepare(): Promise<void> {
    this.ready ??= (async () => {
      await removeDeadOwners(this.o.root, SPOOL_NAME)
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    })()
    return this.ready
  }

  /** Waiting to go, or going. */
  has(id: string): boolean {
    return this.queued.has(id)
  }

  /** Bytes held on disk now. */
  get heldBytes(): number {
    return this.onDisk
  }

  async put(id: string, data: Buffer): Promise<void> {
    if (this.failed) throw this.failed
    if (this.queued.has(id)) return
    await this.prepare()
    await this.room(data.length)
    const file = path.join(this.dir, id)
    const t0 = performance.now()
    await fs.writeFile(file, data, { mode: 0o600 }).catch(async (err: NodeJS.ErrnoException) => {
      // Its folder was swept (left untouched for a day: scratch.ts): make it again.
      if (err.code !== 'ENOENT') throw err
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
      await fs.writeFile(file, data, { mode: 0o600 })
    })
    this.stats.writeMs += performance.now() - t0
    if (this.failed) { await fs.rm(file, { force: true }); throw this.failed }
    this.queued.add(id)
    this.queue.push({ id, size: data.length })
    this.onDisk += data.length
    this.stats.spooledBytes += data.length
    this.stats.peakBytes = Math.max(this.stats.peakBytes, this.onDisk)
    this.pump()
  }

  private async room(bytes: number): Promise<void> {
    const { free, total } = await (this.o.statfs ?? diskSpace)(this.o.root)
    const reserve = this.o.reserveBytes ?? Math.max(2 * GiB, total * 0.01)
    if (free - bytes < reserve) {
      throw new SpoolFull(`the disk holding ${this.o.root} has ${gb(free)} free, and staging more of this batch would leave less than the ${gb(reserve)} it keeps free: the batch is void (the chunks staged already still go)`)
    }
  }

  private notify(): void {
    const w = this.waiters
    this.waiters = []
    for (const wake of w) wake()
  }

  private changed(): Promise<void> {
    return new Promise((resolve) => { this.waiters.push(resolve) })
  }

  /** Keep `window` chunks in flight; after a failure, drop the rest. */
  private pump(): void {
    while (!this.failed && this.inflight.size < this.o.window && this.queue.length) {
      const { id, size } = this.queue.shift()!
      const file = path.join(this.dir, id)
      const p: Promise<void> = fs.readFile(file)
        .then((data) => this.o.send(id, data))
        .catch((err) => { this.failed ??= err })
        .finally(async () => {
          await fs.rm(file, { force: true }).catch(() => {})
          this.inflight.delete(p)
          this.queued.delete(id)
          this.onDisk -= size
          this.pump()
          this.notify()
        })
      this.inflight.add(p)
    }
    if (this.failed && this.queue.length) {
      const dropped = this.queue
      this.queue = []
      for (const q of dropped) {
        this.queued.delete(q.id)
        this.onDisk -= q.size
        void fs.rm(path.join(this.dir, q.id), { force: true }).catch(() => {})
      }
      this.notify()
    }
  }

  /** Until nothing waits or goes (a failure drops what waits). */
  async settle(): Promise<void> {
    while (this.queue.length || this.inflight.size) await this.changed()
  }

  /** The failure, cleared: the next batch starts clean. */
  takeFailure(): unknown {
    const err = this.failed
    if (!this.closed) this.failed = null
    return err
  }

  /** Drop what waits, refuse later puts, and remove the folder once the chunks on the wire went. */
  close(err: Error): void {
    if (this.closed) return
    this.closed = true
    this.failed ??= err
    this.pump()
    void this.settle().then(() => fs.rm(this.dir, { recursive: true, force: true })).catch(() => {})
  }
}
