/**
 * A Walnut call that got no answer, counted by the client that saw it: the Walnut MCP server
 * (walnut-mcp-stdio.ts) and the `walnut` CLI (wn-cli.ts). The session hook (usage-watch/
 * session-hook.ts) counts a failed call only while the server reads the session's lines live, and
 * a call gets no answer exactly while the server or this host's daemon is away: 2026-11-24 audit,
 * all 9 such failures the error read missed fell inside a deploy restart (server_stopping to
 * server listening), 5 of them `no_daemon`, which the table never held. So the client keeps them
 * and hands them to the hub with the next call that gets through, as `tools.list` with
 * `report.no_answer` (capability-router.ts), the way it reports a short tool list. Only op names,
 * codes, the client and how long ago: never an argument or a word of the answer.
 *
 * Every client of a session keeps them in the session's one spool (noAnswerSpoolFile), and any of
 * them tells it with its next call that gets through (2026-11-25 audit: 7 of 11 such failures
 * missed. The Mac's `walnut tools call`, which reaches its server over HTTP, kept none of its 5: with
 * the server and its in-process daemon both restarting, it had nowhere to say it. And a session whose
 * failed call was its MCP server's and whose next working call was its CLI's, or a later process's,
 * never told the first.) The clients: the host's Walnut MCP server (walnut-mcp-stdio.ts) and the
 * hub's own `open-walnut mcp` mount (mcp/tools.ts) of Main, the VPs and the asks; the in-session CLI
 * (wn-cli.ts) and the hub's installed CLI (commands/tools.ts, guide.ts, mcp-client.ts through
 * providers/session-no-answer.ts), which is a Mac session's `walnut`. A guard keeps every such
 * client on this file (tests/core/usage-watch/no-answer-clients-guard.test.ts).
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The codes of a call no Walnut answered: the daemon gone or unreachable, the server down or silent,
 * or its answer broken off (`request_failed`, the Mac CLI's: a reset while the server restarts). The
 * code is the one the agent read, so the session hook's row of the same failure matches it (record.ts).
 */
export const NO_ANSWER_CODES: ReadonlySet<string> = new Set(['no_daemon', 'daemon_unreachable', 'hub_unreachable', 'hub_timeout', 'request_failed'])

export interface NoAnswer {
  op: string
  code: string
  client: 'mcp' | 'cli'
  /** How long before the report the call failed (a duration, so no two clocks are compared). */
  ms: number
  /** The failure's own id: a report sent twice (a slow answer that still landed) counts it once. */
  id?: string
}

/** At most this many in one report, and kept by one session's spool; older ones go first. */
export const NO_ANSWER_MAX = 50
/** A failure older than this when it could be told is no longer told. */
export const NO_ANSWER_MAX_AGE_MS = 24 * 3_600_000

const OP_RE = /^[a-z][a-z0-9_]{0,63}$/
export const NO_ANSWER_ID_RE = /^[a-z0-9]{6,40}$/

interface Kept { at: number; op: string; code: string; client: 'mcp' | 'cli'; id: string }

/** The id of a line an older client wrote without one: the same for every reader of it. */
function idOf(at: number, op: string, code: string, client: string): string {
  return createHash('sha1').update(`${at}|${op}|${code}|${client}`).digest('hex').slice(0, 16)
}

const newId = (): string => randomBytes(8).toString('hex')

function keptOf(v: unknown): Kept | null {
  const r = v as Partial<Kept> | null
  if (!r || typeof r.at !== 'number' || !Number.isFinite(r.at) || typeof r.op !== 'string' || !OP_RE.test(r.op)) return null
  if (typeof r.code !== 'string' || !NO_ANSWER_CODES.has(r.code) || (r.client !== 'mcp' && r.client !== 'cli')) return null
  const id = typeof r.id === 'string' && NO_ANSWER_ID_RE.test(r.id) ? r.id : idOf(r.at, r.op, r.code, r.client)
  return { at: r.at, op: r.op, code: r.code, client: r.client, id }
}

/** What is still told: within its age, the last NO_ANSWER_MAX. Only these are ever kept again or told. */
function fresh(items: readonly Kept[], now: number): Kept[] {
  return items.filter((k) => now - k.at <= NO_ANSWER_MAX_AGE_MS).slice(-NO_ANSWER_MAX)
}

function told(items: readonly Kept[], now: number): NoAnswer[] {
  return items.map((k) => ({ op: k.op, code: k.code, client: k.client, ms: Math.max(0, now - k.at), id: k.id }))
}

/**
 * A long-lived client's failures held in memory, only for a spool it cannot write (an outside caller
 * with no session, or a folder that is not this user's own): the MCP server (walnut-mcp-stdio.ts).
 */
export class NoAnswerLog {
  private items: Kept[] = []

  note(op: string, code: string, client: 'mcp' | 'cli', now = Date.now()): void {
    const k = keptOf({ at: now, op, code, client, id: newId() })
    if (!k) return
    this.items.push(k)
    if (this.items.length > NO_ANSWER_MAX) this.items.splice(0, this.items.length - NO_ANSWER_MAX)
  }

  get size(): number { return this.items.length }

  /** The report to send now (empty: nothing to tell), and a way to keep them when it did not go. */
  take(now = Date.now()): { report: NoAnswer[]; putBack: () => void } {
    const taken = fresh(this.items, now)
    this.items = []
    return {
      report: told(taken, now),
      putBack: () => { this.items = [...taken, ...this.items].slice(-NO_ANSWER_MAX) },
    }
  }
}

/**
 * A session's failures, kept in a file beside this host's daemon socket, one per session
 * (`no-answer/<session id>.ndjson`), until the server took a report of them, whichever client of
 * the session sends it. Nothing lives only in a process's memory: a line leaves the file only once
 * the server took it, so a process that ends at any point loses none, and two clients that send the
 * same lines are counted once by their ids (usage-watch/record.ts). The directory may sit under a
 * shared /tmp: the file is this user's own regular file, opened without following a link, and a bad
 * line is skipped.
 */
export function noAnswerSpoolFile(socketPath: string, sid: string): string | null {
  if (!socketPath || !/^[A-Za-z0-9_-]{1,80}$/.test(sid)) return null
  return path.join(path.dirname(socketPath), 'no-answer', `${sid}.ndjson`)
}

/** A spool past this is cut to its last NO_ANSWER_MAX lines when it is written (a night of calls with the server down). */
const SPOOL_COMPACT_BYTES = 16 * 1024
/** At most this much of a spool's end is read: a file that grew past it anyway is read by its tail. */
const SPOOL_READ_BYTES = 64 * 1024

function ownFile(fd: number): fs.Stats | null {
  const st = fs.fstatSync(fd)
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  return st.isFile() && (uid < 0 || st.uid === uid) ? st : null
}

/**
 * The spool's folder is this user's own real folder that no one else can open (a shared /tmp: a link
 * or a folder another user made there is never written into; 2026-11-24 review), as the demo
 * gateway's folder is checked (gateway-core.ts demoGatewaySocketPath).
 */
function ownPrivateDir(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir)
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1
    return !st.isSymbolicLink() && st.isDirectory() && (uid < 0 || st.uid === uid) && (st.mode & 0o077) === 0
  } catch { return false }
}

/** The lines a spool file holds (its last SPOOL_READ_BYTES), oldest first; [] for none. */
function readSpool(file: string): Kept[] {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const st = ownFile(fd)
    if (!st) return []
    // From one byte before the tail: a tail that starts right after a newline keeps its first line.
    const from = Math.max(0, st.size - SPOOL_READ_BYTES - 1)
    const buf = Buffer.alloc(st.size - from)
    const n = fs.readSync(fd, buf, 0, buf.length, from)
    let text = buf.subarray(0, n).toString('utf-8')
    // Read from its middle: up to the first newline is a part of a line (or that newline alone).
    if (from > 0) text = text.slice(text.indexOf('\n') + 1)
    return text.split('\n').flatMap((l) => {
      try { const k = keptOf(JSON.parse(l)); return k ? [k] : [] } catch { return [] }
    }).sort((a, b) => a.at - b.at)
  } catch { return [] } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* closed */ } }
  }
}

/** Append lines to the spool (created when missing); its size after, or -1 when nothing was written. */
function appendLines(file: string, items: readonly Kept[]): number {
  if (!items.length) return -1
  let fd: number | undefined
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    if (!ownPrivateDir(path.dirname(file))) return -1
    const c = fs.constants
    fd = fs.openSync(file, c.O_WRONLY | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW ?? 0), 0o600)
    if (!ownFile(fd)) return -1
    fs.writeSync(fd, items.map((k) => `${JSON.stringify(k)}\n`).join(''))
    return fs.fstatSync(fd).size
  } catch { return -1 } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* closed */ } }
  }
}

/**
 * Rewrite the spool to `keep(lines)`. The file is moved aside first, so a client appending meanwhile
 * writes a new one and loses nothing; what is kept is appended to it. A process that ends between the
 * two leaves its `.taking` file, which the next take puts back (reclaimTaking).
 */
function rewrite(file: string, keep: (items: Kept[]) => Kept[]): void {
  const taking = takingName(file)
  try { fs.renameSync(file, taking) } catch { return }
  try {
    // Its time is when it was moved aside, not the spool's last write: what reclaimTaking judges by.
    try { const t = new Date(); fs.utimesSync(taking, t, t) } catch { /* judged by its old time */ }
    appendLines(file, keep(readSpool(taking)))
  } finally {
    try { fs.rmSync(taking, { force: true }) } catch { /* gone */ }
  }
}

function takingName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.taking`
}

/**
 * A file moved aside this long ago is a rewrite whose process ended before it put the lines back: a
 * rewrite is one synchronous step of milliseconds. Judged by time, never by its pid, which another
 * process may reuse or another pid namespace may not see (2026-11-25 review).
 */
const LEFTOVER_MS = 30_000
/** `<file>.<pid>.<hex>.taking`, and `.taking.<pid>`, the name an older reclaim left. */
const TAKING_RE = /^\d+\.[0-9a-f]+\.taking(?:\.\d+)?$/

/** Put back what a process that ended mid-rewrite left aside. */
function reclaimTaking(file: string, now = Date.now()): void {
  const dir = path.dirname(file)
  const base = `${path.basename(file)}.`
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return }
  for (const name of names) {
    if (!name.startsWith(base) || !TAKING_RE.test(name.slice(base.length))) continue
    const left = path.join(dir, name)
    try { if (now - fs.lstatSync(left).mtimeMs < LEFTOVER_MS) continue } catch { continue }
    // Moved once more first, so two takers never both put it back; the new name is one this reads again.
    const mine = takingName(file)
    try { fs.renameSync(left, mine) } catch { continue }
    try { const t = new Date(); fs.utimesSync(mine, t, t) } catch { /* judged by its old time */ }
    appendLines(file, readSpool(mine))
    try { fs.rmSync(mine, { force: true }) } catch { /* gone */ }
  }
}

let sweptAt = 0
/** Spools of sessions that ended (nothing written for longer than a line is told) are removed, once an hour. */
function sweepEnded(dir: string, now: number): void {
  if (now - sweptAt < 3_600_000) return
  sweptAt = now
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return }
  for (const name of names) {
    if (!/\.ndjson(?:\.\d+\.[0-9a-f]+\.taking(?:\.\d+)?|\.sending)?$/.test(name)) continue
    const file = path.join(dir, name)
    try {
      const st = fs.lstatSync(file)
      if (st.isFile() && now - st.mtimeMs > NO_ANSWER_MAX_AGE_MS) fs.rmSync(file, { force: true })
    } catch { /* gone meanwhile */ }
  }
}

/** Keep one failure in the session's spool; true when it was kept. Never throws: counting never fails a call. */
export function spoolNoAnswer(file: string | null, op: string, code: string, client: 'mcp' | 'cli' = 'cli', now = Date.now()): boolean {
  const k = keptOf({ at: now, op, code, client, id: newId() })
  if (!file || !k) return false
  try {
    const size = appendLines(file, [k])
    if (size < 0) return false
    // Only what is still told stays: a spool that only ever grew would pass its size and be read by its tail.
    if (size > SPOOL_COMPACT_BYTES) rewrite(file, (items) => fresh(items, now))
    return true
  } catch { return false /* a count only */ }
}

/**
 * What the session's spool holds: its report (oldest first), and `told` to call once the server
 * took it, which drops those lines (and any too old to tell). Until then they stay in the file.
 */
export function takeSpooledNoAnswers(file: string | null, now = Date.now()): { report: NoAnswer[]; told: () => void } {
  const none = { report: [] as NoAnswer[], told: () => {} }
  if (!file || !ownPrivateDir(path.dirname(file))) return none
  sweepEnded(path.dirname(file), now)
  reclaimTaking(file)
  const report = told(fresh(readSpool(file), now), now)
  if (!report.length) return none
  const sent = new Set(report.map((r) => r.id))
  return { report, told: () => rewrite(file, (items) => items.filter((k) => !sent.has(k.id) && now - k.at <= NO_ANSWER_MAX_AGE_MS)) }
}

/**
 * Whether the session's spool holds anything (one stat after a call that got through), or a rewrite
 * a process that ended left aside.
 */
export function spoolHoldsNoAnswers(file: string | null): boolean {
  if (!file) return false
  try { if (fs.lstatSync(file).isFile()) return true } catch { /* none */ }
  const base = `${path.basename(file)}.`
  try { return fs.readdirSync(path.dirname(file)).some((n) => n.startsWith(base) && TAKING_RE.test(n.slice(base.length))) } catch { return false }
}

/**
 * Whether a Walnut server gave this answer: it is ok, and not this host's daemon's own while its
 * Walnut is away (offline-host-core.ts answers a read or a `tools.list` itself then, `offline: true`).
 * A call answered so is no sign the hub is back, and a report answered so went nowhere: it is kept
 * for the next call a server answers (2026-11-25: a call answered from the daemon's offline copy
 * seconds after a restart told its session's failures into that answer, and they were never counted).
 */
export function hubAnswered(r: { ok: boolean; result?: unknown } | null | undefined): boolean {
  return r?.ok === true && (r.result as { offline?: unknown } | null | undefined)?.offline !== true
}

/** Spools this process is telling now: one report of a spool at a time (2026-11-25 review). */
const sending = new Set<string>()
/** A `.sending` mark older than this is one whose process ended mid-send (a send waits at most a few seconds). */
const SENDING_STALE_MS = 10_000

/**
 * Hold the spool's one send across processes: `<file>.sending`, made only if absent. A mark left by a
 * process that ended is taken over once it is stale. Null when another sender holds it.
 */
function holdSending(file: string, now = Date.now()): (() => void) | null {
  const mark = `${file}.sending`
  const c = fs.constants
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.closeSync(fs.openSync(mark, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW ?? 0), 0o600))
      return () => { try { fs.rmSync(mark, { force: true }) } catch { /* gone */ } }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null
      try {
        const st = fs.lstatSync(mark)
        if (!st.isFile() || now - st.mtimeMs < SENDING_STALE_MS) return null
        fs.rmSync(mark, { force: true })
      } catch { /* gone meanwhile: try again */ }
    }
  }
  return null
}

/**
 * Tell what the session's spool holds with `send`; the lines leave the file only when the server
 * took them. One report of a spool at a time, in this process and across the session's clients: two
 * calls ending together would otherwise both send the same lines, and a server older than the ids
 * counts each (2026-11-25 review). The other caller leaves them for the next call. A send that timed
 * out keeps them, and if it landed after all, the next send of the same lines is counted once (their
 * ids, usage-watch/record.ts). Never throws.
 */
export async function tellSpooledNoAnswers(
  file: string | null,
  send: (report: NoAnswer[]) => Promise<{ ok: boolean; result?: unknown }>,
): Promise<void> {
  if (!file || sending.has(file) || !spoolHoldsNoAnswers(file) || !ownPrivateDir(path.dirname(file))) return
  sending.add(file)
  const release = holdSending(file)
  try {
    if (!release) return
    const { report, told: done } = takeSpooledNoAnswers(file)
    if (!report.length) return
    if (hubAnswered(await send(report))) done()
  } catch { /* kept for the next call */ } finally {
    release?.()
    sending.delete(file)
  }
}

/** The no-answer failures a client's report names (hub side), or [] when it names none. */
export function noAnswersOf(report: unknown): NoAnswer[] {
  const list = (report as { no_answer?: unknown } | null)?.no_answer
  if (!Array.isArray(list)) return []
  const out: NoAnswer[] = []
  for (const v of list.slice(0, NO_ANSWER_MAX)) {
    const r = v as Partial<NoAnswer> | null
    const ms = r?.ms
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > NO_ANSWER_MAX_AGE_MS) continue
    const k = keptOf({ at: 0, op: r?.op, code: r?.code, client: r?.client })
    const id = typeof r?.id === 'string' && NO_ANSWER_ID_RE.test(r.id) ? r.id : undefined
    if (k) out.push({ op: k.op, code: k.code, client: k.client, ms, ...(id ? { id } : {}) })
  }
  return out
}
