/**
 * One process per machine holds the permission. The witnesses already treat another process
 * of the same machine as another machine (rules.ts: a renew, handover or cancel counts only
 * from the incarnation that holds the record), so two processes can never both act. This lock
 * keeps a second process from even asking, lets the next process take over at once after a
 * crash, and tells an old process that comes back after another took over to stop.
 *
 * Each taking writes a new generation: `<path>.g<n>`, linked into place complete (a link fails
 * when the name exists, so of all processes that try generation n, exactly one gets it). The
 * owner is the newest generation. Nothing is ever renamed over or emptied, so a process that
 * judged generation n stale can only ever try n + 1, which fails once someone else took it.
 * The newest generation is never deleted (giving the lock up links a newer one that names no
 * process; a taker clears only older ones), so a number is never taken twice while it counts.
 * The owner beats in a file of its own (`<path>.g<n>.<token>.beat`). Generation n is stale
 * when its process is gone, or when its owner has not beaten for staleAfterMs on the machine's
 * monotonic clock (a stopped or hung process; the machine's own sleep does not count, so a
 * laptop that slept does not lose it). An owner holds while its generation is the newest and
 * still names it.
 *
 * Every step is asynchronous file work: nothing here blocks the event loop.
 */
import * as nodeFs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { randomBytes } from 'node:crypto'
import { systemClocks } from './system-clock.js'

export interface LockOwner {
  token: string
  pid: number
  /** Which clock `takenAt` and the beats are on: compared only between owners on the same one. */
  clock: string
  takenAt: number
  gen: number
  /** The owner's process namespace (Linux /proc/self/ns/pid; '' elsewhere): its pid means something only in the same one. */
  ns?: string
  /** The machine's boot (Linux /proc/sys/kernel/random/boot_id; '' elsewhere): another one means the owner died with it. */
  boot?: string
  /** Wall clock at taking: the last resort when neither the pid nor the clock compares. */
  takenWall?: number
}

export type LockFs = Pick<typeof nodeFs, 'link' | 'rename' | 'readFile' | 'readdir' | 'unlink' | 'open' | 'mkdir' | 'readlink'>

export interface InstanceLockOptions {
  path: string
  /** Default 20 s. */
  staleAfterMs?: number
  /** Default 5 s; at most half of staleAfterMs. */
  beatEveryMs?: number
  pid?: number
  isAlive?: (pid: number) => boolean
  /** The machine's shared monotonic clock (every process reads the same value). */
  clock?: { kind: string; now: () => number }
  fs?: LockFs
  /** Called once, when a check finds a newer generation, or its own gone. */
  onLost?: (by: LockOwner | null) => void
}

export type AcquireResult = { ok: true; lock: InstanceLock } | { ok: false; owner: LockOwner | null; reason: string }

type Opts = Required<Omit<InstanceLockOptions, 'onLost'>> & Pick<InstanceLockOptions, 'onLost'>

/** The machine's monotonic clock where it can be read, else the wall clock (which a sleep or a set clock moves). */
export function sharedLockClock(): { kind: string; now: () => number } {
  const sys = systemClocks()
  return sys ? { kind: `${sys.kind}-mono`, now: sys.mono } : { kind: 'wall', now: () => Date.now() }
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const genPath = (path: string, gen: number) => `${path}.g${String(gen).padStart(12, '0')}`
const beatPath = (path: string, o: { gen: number; token: string }) => `${genPath(path, o.gen)}.${o.token}.beat`

export class InstanceLock {
  private lost = false
  private timer: ReturnType<typeof setInterval> | null = null
  /** The newest beat that was written and then found the lock still ours, on the shared clock. */
  private lastBeat: number

  /** @internal use acquireInstanceLock */
  constructor(readonly owner: LockOwner, private readonly o: Opts) {
    // The first beat was written before the generation was linked (tryTake).
    this.lastBeat = owner.takenAt
  }

  /**
   * In memory, cheap: false from the first check that found the lock taken over, and also once
   * no beat has gone through for staleAfterMs - beatEveryMs (beats that fail to write, a
   * process that was stopped): from staleAfterMs on, another process may judge it stale and
   * take it, so this one stops a beat before that.
   */
  held(): boolean {
    return !this.lost && this.o.clock.now() - this.lastBeat < this.o.staleAfterMs - this.o.beatEveryMs
  }

  /** Look again: is our generation still the newest, and still ours? */
  async check(): Promise<boolean> {
    if (this.lost) return false
    const top = await newest(this.o)
    if (this.lost) return false
    if (top && top.gen === this.owner.gen && top.owner?.token === this.owner.token) return true
    this.markLost(top?.owner ?? null)
    return false
  }

  /** Say we are alive, then check (the check runs even when the beat could not be written). */
  async beat(): Promise<boolean> {
    if (this.lost) return false
    const at = this.o.clock.now()
    let wrote = false
    try {
      await writeAtomic(this.o.fs, beatPath(this.o.path, this.owner), JSON.stringify({ token: this.owner.token, at, wall: Date.now() }), false)
      wrote = true
    } finally {
      if ((await this.check()) && wrote) this.lastBeat = Math.max(this.lastBeat, at)
    }
    return this.held()
  }

  /** Beat every beatEveryMs until lost or released (the timer does not keep the process up). */
  start(): void {
    if (this.timer || this.lost) return
    this.timer = setInterval(() => { void this.beat().catch(() => { /* the next beat tries again; staleness decides */ }) }, this.o.beatEveryMs)
    this.timer.unref?.()
  }

  /**
   * Give it up, while it is still ours: a newer generation that names no process (pid 0, stale
   * at once), so the next taker needs no wait and no number is reused.
   */
  async release(): Promise<void> {
    this.stopTimer()
    if (this.lost || !(await this.check())) return
    this.lost = true
    const free: LockOwner = { token: `released-${this.owner.token}`, pid: 0, clock: this.owner.clock, takenAt: this.o.clock.now(), gen: this.owner.gen + 1, takenWall: Date.now() }
    await linkComplete(this.o.fs, this.o.path, free).catch(() => false)
    await this.o.fs.unlink(beatPath(this.o.path, this.owner)).catch(() => {})
  }

  private markLost(by: LockOwner | null): void {
    // Two checks at once can both find it taken: tell once.
    if (this.lost) return
    this.lost = true
    this.stopTimer()
    this.o.onLost?.(by)
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

async function readText(fs: LockFs, path: string): Promise<string | null> {
  try {
    return (await fs.readFile(path, 'utf8')) as string
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** `durable`: fsync before the rename (a beat needs none: a beat lost to a power cut only looks older). */
async function writeAtomic(fs: LockFs, path: string, text: string, durable = true): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  const fh = await fs.open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(text)
    if (durable) await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.rename(tmp, path)
}

function parseOwner(text: string | null, gen: number): LockOwner | null {
  if (text === null) return null
  try {
    const o = JSON.parse(text) as LockOwner
    if (typeof o.token === 'string' && o.token && Number.isSafeInteger(o.pid) && typeof o.clock === 'string' && Number.isFinite(o.takenAt) && o.gen === gen) return o
  } catch { /* not a lock file */ }
  return null
}

/** The newest generation, with its owner (null: unreadable, which counts as stale), or null when none exists. */
async function newest(o: Pick<Opts, 'fs' | 'path'>): Promise<{ gen: number; owner: LockOwner | null } | null> {
  const dir = nodePath.dirname(o.path)
  const base = nodePath.basename(o.path)
  let names: string[]
  try {
    names = (await o.fs.readdir(dir)) as string[]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const gens = names.map((n) => (n.startsWith(`${base}.g`) && /^\d{12}$/.test(n.slice(base.length + 2)) ? Number(n.slice(base.length + 2)) : -1)).filter((g) => g > 0)
  // Highest first; a generation deleted between the listing and the read is skipped.
  for (const gen of gens.sort((a, b) => b - a)) {
    const text = await readText(o.fs, genPath(o.path, gen))
    if (text !== null) return { gen, owner: parseOwner(text, gen) }
  }
  return null
}

/**
 * Take the lock: at once when there is none or the newest is stale, else refused naming the
 * owner. A few rounds at most when other processes take it at the same time.
 */
export async function acquireInstanceLock(opts: InstanceLockOptions): Promise<AcquireResult> {
  const o: Opts = {
    path: opts.path,
    staleAfterMs: opts.staleAfterMs ?? 20_000,
    beatEveryMs: opts.beatEveryMs ?? 5_000,
    pid: opts.pid ?? process.pid,
    isAlive: opts.isAlive ?? processAlive,
    clock: opts.clock ?? sharedLockClock(),
    fs: opts.fs ?? nodeFs,
    onLost: opts.onLost,
  }
  if (!(o.beatEveryMs * 2 <= o.staleAfterMs)) throw new Error('instance lock: beatEveryMs must be at most half of staleAfterMs')
  await o.fs.mkdir(nodePath.dirname(o.path), { recursive: true, mode: 0o700 })
  const ns = await pidNamespace(o.fs)
  const boot = await bootId(o.fs)
  const token = randomBytes(8).toString('hex')
  let seen: LockOwner | null = null
  for (let round = 0; round < 10; round++) {
    const top = await newest(o)
    if (top) {
      seen = top.owner
      if (top.owner && !(await staleness(o, top.owner, ns, boot))) return { ok: false, owner: top.owner, reason: `held by pid ${top.owner.pid}` }
    }
    const me: LockOwner = { token, pid: o.pid, clock: o.clock.kind, takenAt: o.clock.now(), gen: (top?.gen ?? 0) + 1, ns, boot, takenWall: Date.now() }
    if (!(await tryTake(o, me))) continue
    // A process that judged an older generation may have taken a number that a cleanup had
    // freed: it yields to any newer generation it finds.
    const now = await newest(o)
    if (now?.gen !== me.gen) {
      await o.fs.unlink(genPath(o.path, me.gen)).catch(() => {})
      await o.fs.unlink(beatPath(o.path, me)).catch(() => {})
      continue
    }
    if (top) await clearOlder(o, me.gen)
    return { ok: true, lock: new InstanceLock(me, o) }
  }
  return { ok: false, owner: seen, reason: 'other processes kept taking it' }
}

async function tryTake(o: Opts, me: LockOwner): Promise<boolean> {
  // The first beat goes before the file: a taker never sees our generation without it.
  const beat = beatPath(o.path, me)
  await writeAtomic(o.fs, beat, JSON.stringify({ token: me.token, at: me.takenAt, wall: me.takenWall }), false)
  if (await linkComplete(o.fs, o.path, me)) return true
  await o.fs.unlink(beat).catch(() => {})
  return false
}

/** Write generation `who.gen` complete, then link it into place: false when that generation exists. */
async function linkComplete(fs: LockFs, path: string, who: LockOwner): Promise<boolean> {
  const tmp = `${path}.${who.token}.tmp`
  const fh = await fs.open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(JSON.stringify(who))
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await fs.link(tmp, genPath(path, who.gen))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
      throw new Error(`instance lock: the file system at ${nodePath.dirname(path)} cannot make hard links (${code}); put the lock on a local disk`)
    }
    throw err
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
  // The generation counts once its directory entry is on disk: a power cut must not hand it out again.
  const dir = await fs.open(nodePath.dirname(path), 'r').catch(() => null)
  if (dir) await dir.sync().catch(() => {}).finally(() => dir.close())
  return true
}

/** Remove the generations below `gen`, and their beats (best effort). */
async function clearOlder(o: Opts, gen: number): Promise<void> {
  const dir = nodePath.dirname(o.path)
  const base = nodePath.basename(o.path)
  for (const n of ((await o.fs.readdir(dir).catch(() => [])) as string[])) {
    const m = /^\.g(\d{12})(\..*\.beat)?$/.exec(n.slice(base.length))
    if (n.startsWith(base) && m && Number(m[1]) < gen) await o.fs.unlink(nodePath.join(dir, n)).catch(() => {})
  }
}

/** Linux: which pid namespace this process is in (a container has its own); '' where there is none to read. */
async function pidNamespace(fs: LockFs): Promise<string> {
  if (process.platform !== 'linux') return ''
  try {
    return String(await fs.readlink('/proc/self/ns/pid'))
  } catch {
    return ''
  }
}

/** Linux: this boot's id (every process of one boot reads the same, containers included); '' elsewhere. */
async function bootId(fs: LockFs): Promise<string> {
  if (process.platform !== 'linux') return ''
  try {
    return String(await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  } catch {
    return ''
  }
}

/** Why `owner` no longer holds it, or null while it does. */
async function staleness(o: Opts, owner: LockOwner, ns: string, boot: string): Promise<string | null> {
  if (owner.pid <= 0) return 'given up'
  if (owner.boot && boot && owner.boot !== boot) return 'the machine restarted since'
  // A pid from another namespace (a process in a container beside one outside) says nothing
  // here: such an owner is judged by its beats alone.
  const pidCompares = (owner.ns ?? '') === ns
  if (pidCompares && !o.isAlive(owner.pid)) return `pid ${owner.pid} is gone`
  const beat = parseBeat(await readText(o.fs, beatPath(o.path, owner)), owner.token)
  if (owner.clock === o.clock.kind) {
    const age = o.clock.now() - Math.max(owner.takenAt, beat?.at ?? -Infinity)
    // A beat far ahead of now: the clock started again (the machine restarted).
    if (age > o.staleAfterMs || age < -o.staleAfterMs) return `no beat for ${Math.round(age)} ms`
    return null
  }
  if (pidCompares) return null
  // Neither its pid nor its clock compares (another namespace on another clock): the wall clock,
  // with a wide limit, so a lock nobody can judge is never stuck for good.
  const wallAge = Date.now() - Math.max(owner.takenWall ?? -Infinity, beat?.wall ?? -Infinity)
  return Math.abs(wallAge) > 3 * o.staleAfterMs ? `no beat for ${Math.round(wallAge)} ms by the wall clock` : null
}

function parseBeat(text: string | null, token: string): { at: number; wall?: number } | null {
  if (text === null) return null
  try {
    const b = JSON.parse(text) as { token?: string; at?: number; wall?: number }
    return b.token === token && Number.isFinite(b.at) ? { at: b.at!, ...(Number.isFinite(b.wall) ? { wall: b.wall! } : {}) } : null
  } catch {
    return null
  }
}
