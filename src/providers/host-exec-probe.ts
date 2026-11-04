/**
 * wait_for's looks at a host (host-exec-wait.ts): a port counts when anything listens on it at any
 * local address, 127.0.0.1, ::1 and every address of this host's interfaces (2026-11-04 review: a
 * server bound to its container address was missed); a file is looked at off the loop with a
 * deadline, so a stuck NFS or SMB mount never holds it, and one that does not answer is named in
 * the answer instead of reading as "not yet".
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { WaitFor } from './host-exec-pattern.js'

export const PORT_PROBE_MS = 500
export const FILE_LOOK_MS = 1_000
/** At most this many file looks may hang (past their own deadline) before a new path gets 'busy'. */
const FILE_LOOKS_MAX = 2
/** At most this many in flight at all: node's thread pool has 4, and one stays free for the rest of the daemon. */
const FILE_LOOKS_IN_FLIGHT = 3

/** A wait_for.file names the task's directory ($WALNUT_TASK_DIR, ${WALNUT_TASK_DIR}). */
const TASK_DIR_REF = /\$\{?WALNUT_TASK_DIR\b/

/**
 * Why a wait_for cannot wait on this host, or null: a file under $WALNUT_TASK_DIR where this host
 * has no task directory for the task would be taken as written and never appear (exec.run refuses
 * such a line the same way).
 */
export function waitRefusal(waitFor: WaitFor, taskDir: string | null): string | null {
  if (taskDir || waitFor.file === undefined || !TASK_DIR_REF.test(waitFor.file)) return null
  return 'this host has no task directory for this task, so WALNUT_TASK_DIR is unset here and wait_for.file could never appear'
}

/** A wait_for.file on this host: `~` is home, $WALNUT_TASK_DIR the task's directory, else relative to the job's cwd. */
export function resolveWaitFile(file: string, place: { cwd: string; home: string; taskDir: string | null }): string {
  let f = file
  if (place.taskDir) f = f.replace(/^\$\{?WALNUT_TASK_DIR\}?(?=\/|$)/, place.taskDir)
  if (f === '~') return place.home
  if (f.startsWith('~/')) return path.join(place.home, f.slice(2))
  return path.resolve(place.cwd, f)
}

let addressCache: { at: number; list: string[] } | null = null

/** Every address this host listens on locally: loopback, then each interface's (an IPv6 link-local one with its scope). */
export function localAddresses(): string[] {
  if (addressCache && Date.now() - addressCache.at < 5_000) return addressCache.list
  const out = new Set(['127.0.0.1', '::1'])
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family === 'IPv4' || (a.family as unknown) === 4) out.add(a.address)
        else out.add(/^fe80:/i.test(a.address) ? `${a.address}%${name}` : a.address)
      }
    }
  } catch { /* loopback only */ }
  addressCache = { at: Date.now(), list: [...out] }
  return addressCache.list
}

/** Linux's socket tables: a listener is read there, never connected to. */
const SOCKET_TABLES = ['/proc/net/tcp', '/proc/net/tcp6']

/** An address as /proc/net/tcp{,6} writes it (hex, each 32-bit word in host order), in the form os.networkInterfaces() gives. */
function tableAddress(hex: string): string | null {
  const bytes: number[] = []
  for (let w = 0; w < hex.length / 8; w += 1) for (const i of [6, 4, 2, 0]) bytes.push(parseInt(hex.slice(w * 8 + i, w * 8 + i + 2), 16))
  if (bytes.some((b) => Number.isNaN(b))) return null
  if (bytes.length === 4) return bytes.join('.')
  if (bytes.length !== 16) return null
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join('.')
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16))
  try { return new URL(`http://[${groups.join(':')}]/`).hostname.slice(1, -1) } catch { return null }
}

type ReadText = (p: string) => Promise<string>
/** A table set past this size (about 7 000 sockets) is reused between looks. */
const TABLE_REUSE_BYTES = 1_000_000
const readText: ReadText = (p) => fs.promises.readFile(p, 'utf8')

/** The socket tables as last read, and the read in flight: one at a time, however many waits look (per reader, for tests). */
let tables: { read: ReadText; at: number; ms: number; size: number; texts: Array<string | null> } | null = null
let tableRead: { read: ReadText; pending: Promise<Array<string | null>> } | null = null

/** Both tables, read at most once at a time; a read that takes long is reused for a while (a host with many sockets). */
async function readTables(ms: number, read: ReadText): Promise<Array<string | null> | null> {
  const now = Date.now()
  // Only a large table (a host with many sockets) is reused, for five times what its read cost, so
  // such a host spends at most a sixth of a look's time reading; a small one is read fresh each
  // look, so a port that just began listening is seen at the next look.
  if (tables && tables.read === read && tables.size > TABLE_REUSE_BYTES && now - tables.at < Math.min(5_000, tables.ms * 5)) return tables.texts
  if (!tableRead || tableRead.read !== read) {
    const started = Date.now()
    const pending: Promise<Array<string | null>> = Promise.all(SOCKET_TABLES.map((p) => read(p).catch(() => null)))
    const mine = { read, pending }
    tableRead = mine
    void pending.then((texts) => { tables = { read, at: Date.now(), ms: Date.now() - started, size: texts.reduce((n, t) => n + (t?.length ?? 0), 0), texts } }, () => {})
      .finally(() => { if (tableRead === mine) tableRead = null })
  }
  // Never past the look's own time: a file read waits for a free thread, which a stuck mount can hold.
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms) })
  try { return await Promise.race([tableRead.pending, late]) } finally { clearTimeout(timer) }
}

/** A LISTEN row's remote address (all zeros) and state, as the table writes them after the local address. */
const LISTEN_TAIL = [' 00000000:0000 0A ', ' 00000000000000000000000000000000:0000 0A ']

/**
 * The local addresses with a socket listening on `port` (0.0.0.0 and :: for every address), from
 * this host's socket tables; null on a host without them (not Linux), when they cannot be read, or
 * when the read takes longer than `ms`. Rows are found by text, not split one by one: a host with
 * 200 000 sockets took 423 ms to split (2026-11-04 review).
 */
export async function tableListeners(port: number, read: ReadText = readText, ms = PORT_PROBE_MS): Promise<string[] | null> {
  const texts = await readTables(ms, read)
  if (!texts || texts.every((t) => t === null)) return null
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
  const out: string[] = []
  texts.forEach((text, k) => {
    if (!text) return
    const needle = `:${hexPort}${LISTEN_TAIL[k]}`
    const width = k === 0 ? 8 : 32
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      const a = tableAddress(text.slice(at - width, at))
      if (a) out.push(a)
    }
  })
  return out
}

/** Tests: forget the tables last read. */
export function resetTablesForTest(): void { tables = null; tableRead = null }

let wslCache: boolean | null = null
/**
 * WSL: a Windows program's port is reachable at 127.0.0.1 there (mirrored networking) but is not
 * in Linux's socket tables, so a table that names no listener does not mean none.
 */
function tablesIncomplete(): boolean {
  if (wslCache !== null) return wslCache
  try { wslCache = !!process.env.WSL_DISTRO_NAME || /microsoft/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8')) } catch { wslCache = false }
  return wslCache
}

/** Of the listeners a table names, the one this probe counts: an address of `addresses`, in their order, else a wildcard. */
function pickListener(listed: string[], addresses: string[], port: number): string | null {
  const at = (h: string) => (h.includes(':') ? `[${h}]:${port}` : `${h}:${port}`)
  for (const a of addresses) if (listed.includes(a.replace(/%.*$/, ''))) return at(a)
  if (listed.includes('0.0.0.0') && addresses.includes('127.0.0.1')) return at('127.0.0.1')
  if (listed.includes('::') && addresses.includes('::1')) return at('::1')
  return null
}

/**
 * Is something listening on this port at any local address? The address that answered, or null.
 * Where this host has socket tables (Linux) a listener is read from them and never connected to:
 * a server that serves one client and exits (`nc -l` without -k) would take the look as its client
 * and be gone (2026-11-04 reviews: also when a table read just before it listened sent the look on
 * to a connect). The look connects only where there are no tables (a Mac) or they are known to miss
 * listeners (WSL, `incomplete`); tables not read in time are a look that saw nothing. A connect that reached itself is no listener: a port in this
 * host's ephemeral range, looked at often enough, gets the connect's own source port, and TCP's
 * simultaneous open then joins the socket to itself (2026-11-04 review: a wait answered "listening"
 * on a port nothing listened on).
 */
export async function probePort(
  port: number, ms = PORT_PROBE_MS, addresses = localAddresses(),
  connect: (o: { host: string; port: number }) => net.Socket = (o) => net.connect(o),
  table: (port: number) => Promise<string[] | null> = (p) => tableListeners(p, undefined, ms),
  incomplete: () => boolean = tablesIncomplete,
  tablesHere: boolean = process.platform === 'linux',
): Promise<string | null> {
  return (await lookPort(port, ms, addresses, connect, table, incomplete, tablesHere)).at
}

/**
 * probePort's look, and `unread` when it could not look at all: tables this host has were not read
 * in time, or could not be read, so "nothing listens" was never seen (2026-11-05 review: a wait on
 * such a host ran ten minutes and said the port did not listen).
 */
export async function lookPort(
  port: number, ms = PORT_PROBE_MS, addresses = localAddresses(),
  connect: (o: { host: string; port: number }) => net.Socket = (o) => net.connect(o),
  table: (port: number) => Promise<string[] | null> = (p) => tableListeners(p, undefined, ms),
  incomplete: () => boolean = tablesIncomplete,
  tablesHere: boolean = process.platform === 'linux',
): Promise<{ at: string | null; unread?: true }> {
  const listed = await table(port).catch(() => null)
  const read = listed ? pickListener(listed, addresses, port) : null
  if (read) return { at: read }
  if (listed && !incomplete()) return { at: null }
  // Tables this host has, not read in time (a thread pool held by a stuck mount, a huge table): not
  // seen this look, never a connect, which a server taking one client would take as its client
  // (2026-11-05 review: on the node twin with its pool held, a one-shot server got the look as its
  // only client).
  if (!listed && tablesHere && !incomplete()) return { at: null, unread: true }
  return { at: await connectLook(port, ms, addresses, connect) }
}

/** A look by connecting, where there are no tables to read: the address that answered, or null. */
function connectLook(port: number, ms: number, addresses: string[], connect: (o: { host: string; port: number }) => net.Socket): Promise<string | null> {
  const one = (host: string) => new Promise<boolean>((resolve) => {
    const sock = connect({ host, port })
    const done = (ok: boolean) => {
      clearTimeout(timer)
      sock.removeAllListeners()
      sock.on('error', () => { /* a late error after we let go */ })
      sock.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), ms)
    sock.once('connect', () => done(!(sock.localPort === port && sock.localAddress === sock.remoteAddress)))
    sock.once('error', () => done(false))
  })
  return new Promise((resolve) => {
    let left = addresses.length
    let answered = false
    if (!left) resolve(null)
    for (const host of addresses) {
      void one(host).then((ok) => {
        if (answered) return
        if (ok) { answered = true; resolve(host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`) } else if (--left === 0) resolve(null)
      })
    }
  })
}

/**
 * What a look found: the file's size (-1: it exists, and its stat said no size), or why it is not
 * there: 'no', 'denied' (a directory on its path is closed to this user), 'dangling' (a symlink to
 * a path that does not exist: it counts, as `test -e` does, once that path exists).
 */
type Seen = number | 'no' | 'denied' | 'dangling'
/** A look's answer for a directory. */
const DIR = -2
/** The file looks in flight, by path, with when each started and its deadline; a stat on a mount that stopped answering never returns. */
const fileLooks = new Map<string, { look: Promise<Seen>; at: number; ms: number }>()
/** Looks waiting for one in flight to answer (FILE_LOOKS_IN_FLIGHT). */
const slotWaiters = new Set<() => void>()

/** A file look still in flight this long holds its pool thread for good (a mount that stopped answering). */
export const STUCK_LOOK_MS = 5_000

/**
 * File looks in flight for STUCK_LOOK_MS or more: each holds a thread of the pool (a stat on a
 * mount that stopped answering), and node's exit waits for every pool thread, so the JS twin ends
 * itself hard when this is not 0 (daemon-source.ts exitDaemon). An absolute age, not the look's
 * own deadline: a look near a wait's bound gets only 200 ms, and a stat that is merely slow there
 * must not turn an orderly exit into a SIGKILL (2026-11-04 review).
 */
export function stuckFileLooks(now = Date.now(), minAgeMs = STUCK_LOOK_MS): number {
  let n = 0
  for (const l of fileLooks.values()) if (now - l.at >= minAgeMs) n += 1
  return n
}

/**
 * Does the file exist? Asked off the loop, and answered 'unanswered' after `ms` (an NFS or SMB
 * mount that stopped answering holds a stat for minutes, and existsSync held the daemon's loop
 * with it). A look still in flight is not asked again. Once FILE_LOOKS_MAX looks have hung past
 * their deadline a new path is 'busy', and at most FILE_LOOKS_IN_FLIGHT are in flight at all: a
 * look past that waits, within its own deadline, for one of them to answer, and is 'busy' only
 * when none did. So a stuck mount ties up a few of the thread pool's workers, never all, and looks
 * that answer in time never read as stuck (2026-11-04 review: three healthy checks at once made
 * the third 'busy', reported as a stuck network mount).
 */
export async function probeFile(file: string, ms = FILE_LOOK_MS, stat: (p: string) => Promise<unknown> = (p) => fs.promises.stat(p)): Promise<FileLook['state']> {
  return (await lookFile(file, ms, stat)).state
}

/**
 * A file look: probeFile, and the file's size when it exists (an empty file a job made and has not
 * written yet is 0), or `dir` when the path is a directory (whose size says nothing of what it holds).
 */
export type FileLook = { state: 'yes'; size: number | null; dir?: true } | { state: 'no' | 'unanswered' | 'busy' | 'denied' | 'dangling' }

/** Why a stat found no file: closed to this user, a symlink to nothing (lstat finds the link), or not there. */
async function whyNot(file: string, err: unknown, lstat: (p: string) => Promise<{ isSymbolicLink(): boolean }>): Promise<Seen> {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'denied'
  if (code !== 'ENOENT') return 'no'
  try { return (await lstat(file)).isSymbolicLink() ? 'dangling' : 'no' } catch { return 'no' }
}

export async function lookFile(file: string, ms = FILE_LOOK_MS, stat: (p: string) => Promise<unknown> = (p) => fs.promises.stat(p),
  lstat: (p: string) => Promise<{ isSymbolicLink(): boolean }> = (p) => fs.promises.lstat(p)): Promise<FileLook> {
  const until = Date.now() + ms
  let look = fileLooks.get(file)?.look
  while (!look) {
    const now = Date.now()
    let hung = 0
    // A look still unanswered at its own deadline has hung (its caller was told 'unanswered').
    for (const l of fileLooks.values()) if (now - l.at >= l.ms) hung += 1
    if (hung >= FILE_LOOKS_MAX) return { state: 'busy' }
    if (fileLooks.size < FILE_LOOKS_IN_FLIGHT) {
      const asked: Promise<Seen> = stat(file).then((st) => {
        const s = st as { size?: unknown; isDirectory?: () => boolean } | null
        if (typeof s?.isDirectory === 'function' && s.isDirectory()) return DIR
        return typeof s?.size === 'number' ? s.size : -1
      }, (err) => whyNot(file, err, lstat))
      look = asked
      fileLooks.set(file, { look: asked, at: now, ms })
      void asked.finally(() => {
        if (fileLooks.get(file)?.look === asked) fileLooks.delete(file)
        for (const wake of [...slotWaiters]) wake()
      })
      break
    }
    if (now >= until) return { state: 'busy' }
    // Every slot holds a look still in time: wait for one to answer, no longer than this look may take.
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); slotWaiters.delete(done); resolve() }
      const timer = setTimeout(done, until - now)
      slotWaiters.add(done)
    })
    look = fileLooks.get(file)?.look
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, until - Date.now())) })
  try {
    const r = await Promise.race([look.then((seen) => ({ seen })), late])
    // -1: it exists, and its stat said no size; DIR: it is a directory.
    if (r === null) return { state: 'unanswered' }
    if (r.seen === DIR) return { state: 'yes', size: null, dir: true }
    return typeof r.seen === 'number' ? { state: 'yes', size: r.seen >= 0 ? r.seen : null } : { state: r.seen }
  } finally {
    clearTimeout(timer)
  }
}
