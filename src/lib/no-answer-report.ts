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
}

/** At most this many in one report, and kept by one client; older ones go first. */
export const NO_ANSWER_MAX = 50
/** A failure older than this when it could be told is no longer told. */
export const NO_ANSWER_MAX_AGE_MS = 24 * 3_600_000

const OP_RE = /^[a-z][a-z0-9_]{0,63}$/

interface Kept { at: number; op: string; code: string; client: 'mcp' | 'cli' }

function keptOf(v: unknown): Kept | null {
  const r = v as Partial<Kept> | null
  if (!r || typeof r.at !== 'number' || !Number.isFinite(r.at) || typeof r.op !== 'string' || !OP_RE.test(r.op)) return null
  if (typeof r.code !== 'string' || !NO_ANSWER_CODES.has(r.code) || (r.client !== 'mcp' && r.client !== 'cli')) return null
  return { at: r.at, op: r.op, code: r.code, client: r.client }
}

/** What is still told: within its age, the last NO_ANSWER_MAX. Only these are ever kept again. */
function fresh(items: readonly Kept[], now: number): Kept[] {
  return items.filter((k) => now - k.at <= NO_ANSWER_MAX_AGE_MS).slice(-NO_ANSWER_MAX)
}

function told(items: readonly Kept[], now: number): NoAnswer[] {
  return items.map((k) => ({ op: k.op, code: k.code, client: k.client, ms: Math.max(0, now - k.at) }))
}

/** A long-lived client's failures (the MCP server), held in memory until a call gets through. */
export class NoAnswerLog {
  private items: Kept[] = []

  note(op: string, code: string, client: 'mcp' | 'cli', now = Date.now()): void {
    const k = keptOf({ at: now, op, code, client })
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
 * A one-shot client's failures (the CLI), kept in a file beside this host's daemon socket, one per
 * session (`no-answer/<session id>.ndjson`), until a later call of the same session gets through.
 * The directory may sit under a shared /tmp: the file is this user's own regular file, opened
 * without following a link, and a bad line is skipped.
 */
export function noAnswerSpoolFile(socketPath: string, sid: string): string | null {
  if (!socketPath || !/^[A-Za-z0-9_-]{1,80}$/.test(sid)) return null
  return path.join(path.dirname(socketPath), 'no-answer', `${sid}.ndjson`)
}

const SPOOL_MAX_BYTES = 64 * 1024

function ownRegularFile(fd: number): boolean {
  const st = fs.fstatSync(fd)
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  return st.isFile() && (uid < 0 || st.uid === uid) && st.size <= SPOOL_MAX_BYTES
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

/** Keep one failure in the session's spool; true when it was kept. Never throws: counting never fails a call. */
export function spoolNoAnswer(file: string | null, op: string, code: string, client: 'mcp' | 'cli' = 'cli', now = Date.now()): boolean {
  const k = keptOf({ at: now, op, code, client })
  if (!file || !k) return false
  let fd: number | undefined
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    if (!ownPrivateDir(path.dirname(file))) return false
    const c = fs.constants
    fd = fs.openSync(file, c.O_WRONLY | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW ?? 0), 0o600)
    if (!ownRegularFile(fd)) return false
    fs.writeSync(fd, `${JSON.stringify(k)}\n`)
    return true
  } catch { return false /* a count only */ } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* closed */ } }
  }
}

/**
 * Take what the session's spool holds: its report, and `putBack` to keep it when the report did
 * not go. Taken by a rename first, so two calls ending together tell each failure once.
 */
export function takeSpooledNoAnswers(file: string | null, now = Date.now()): { report: NoAnswer[]; putBack: () => void } {
  const none = { report: [] as NoAnswer[], putBack: () => {} }
  if (!file || !ownPrivateDir(path.dirname(file))) return none
  const taking = `${file}.${process.pid}.taking`
  try { fs.renameSync(file, taking) } catch { return none }
  let fd: number | undefined
  let items: Kept[] = []
  try {
    fd = fs.openSync(taking, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    if (ownRegularFile(fd)) {
      items = fs.readFileSync(fd, 'utf-8').split('\n').flatMap((l) => {
        try { const k = keptOf(JSON.parse(l)); return k ? [k] : [] } catch { return [] }
      })
    }
  } catch { /* nothing to tell */ } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* closed */ } }
    try { fs.rmSync(taking, { force: true }) } catch { /* gone */ }
  }
  // Only what is still told goes back: a spool that only ever grew would pass its size and be lost whole.
  const kept = fresh(items, now)
  return {
    report: told(kept, now),
    putBack: () => { for (const k of kept) spoolNoAnswer(file, k.op, k.code, k.client, k.at) },
  }
}

/** Whether the session's spool holds anything (one stat after a call that got through). */
export function spoolHoldsNoAnswers(file: string | null): boolean {
  if (!file) return false
  try { return fs.lstatSync(file).isFile() } catch { return false }
}

/**
 * Whether a Walnut server gave this answer: it is ok, and not this host's daemon's own while its
 * Walnut is away (offline-host-core.ts answers a read or a `tools.list` itself then, `offline: true`).
 * A call answered so is no sign the hub is back, and a report answered so went nowhere: it is kept
 * for the next call a server answers.
 */
export function hubAnswered(r: { ok: boolean; result?: unknown } | null | undefined): boolean {
  return r?.ok === true && (r.result as { offline?: unknown } | null | undefined)?.offline !== true
}

/** Tell what the session's spool holds with `send`; kept again unless a Walnut server took it. Never throws. */
export async function tellSpooledNoAnswers(
  file: string | null,
  send: (report: NoAnswer[]) => Promise<{ ok: boolean; result?: unknown }>,
): Promise<void> {
  if (!spoolHoldsNoAnswers(file)) return
  const { report, putBack } = takeSpooledNoAnswers(file)
  if (!report.length) return
  try {
    if (!hubAnswered(await send(report))) putBack()
  } catch { putBack() }
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
    if (k) out.push({ op: k.op, code: k.code, client: k.client, ms })
  }
  return out
}
