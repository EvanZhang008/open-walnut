/**
 * Work this server's own stop cuts short is never read as a host going away, and a task move
 * (engine switch) it cuts short is paused for the next boot, never failed (2026-11-12: three moves
 * from this Mac died 1 to 2 s after a deploy began, each recorded as "Walnut is not connected to
 * this Mac right now." and each asked for again by hand). server-stopping.ts holds the flag.
 *
 * Each rule enumerates its members from the source (comments left out), so a new member that
 * skips the rule fails:
 *  1. every module that reads TransferHostOfflineError also handles TransferServerStoppingError;
 *  2. in the transfer client, every daemon command leaves through sendOn and every "offline"
 *     comes from noLink, both of which read the stop;
 *  3. every catch in src/core/transfer/ that does not rethrow handles interruptedByShutdown first,
 *     or is listed with why a stop cannot reach it;
 *  4. engine-switch.ts: fail() pauses before it writes and restore() puts nothing back while
 *     stopping, every catch throws what fail() answers and hands restore() its error, and the
 *     failures outside a catch are the listed ones;
 *  5. every write of a failed engine_switch is a listed one;
 *  6. every long transfer step (pack, copy, relay, apply, a task's work, a workspace) runs under a
 *     link wait (transfer/link-wait.ts), so a dropped link to either host is waited out (2026-11-12:
 *     the link to a dev host dropped every few minutes while a move uploaded), or is listed with
 *     the bound it keeps instead; so does every sender of fs.writePart and every caller of a file
 *     write in parts (2026-11-12: a move failed on "daemon command lost: fs.writePart", a member
 *     the first list of steps did not name), and the whole engine switch run is under the wait;
 *  7. only the leader resumes switches at boot (a replica holds a copy of the leader's tasks).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
/** Source without its comments, newlines kept (so line numbers still point at the file). */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, pre: string) => pre + ' '.repeat(m.length - pre.length))
}
const read = (rel: string) => code(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}
const SOURCES = walk(path.join(ROOT, 'src')).map((f) => ({ rel: path.relative(ROOT, f), text: code(fs.readFileSync(f, 'utf8')) }))
const lineOf = (src: string, at: number) => src.slice(0, at).split('\n').length

/** The index just past the `}` that closes the block opened at `open` (a `{`). */
function blockEnd(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return i + 1
  }
  throw new Error(`no end for the block at ${open}`)
}

/** Every `catch (...) {` block of `src`, as [start, bodyStart, end) ranges. */
function catchBlocks(src: string): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  for (const m of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{/g)) {
    const open = m.index! + m[0].length - 1
    out.push([m.index!, open, blockEnd(src, open)])
  }
  return out
}

/** The body of the function declared as `head` (its first `{` to its end). */
function body(src: string, head: string): string {
  const at = src.indexOf(head)
  expect(at, head).toBeGreaterThanOrEqual(0)
  const open = src.indexOf('{', src.indexOf(')', at))
  return src.slice(open, blockEnd(src, open))
}

describe('a server stop is never a host offline', () => {
  it('every reader of TransferHostOfflineError also handles TransferServerStoppingError', () => {
    // part-retry.ts reads the stop as ServerStoppingError, the class TransferServerStoppingError extends.
    const own = new Set(['src/core/transfer/daemon-transfer-client.ts', 'src/core/transfer/transfer-errors.ts', 'src/core/transfer/part-retry.ts'])
    const readers = SOURCES.filter((f) => !own.has(f.rel) && /\bTransferHostOfflineError\b/.test(f.text))
    expect(readers.map((f) => f.rel).sort()).toEqual(expect.arrayContaining([
      'src/core/hosts/host-copy.ts', 'src/core/transfer/transfer.ts', 'src/web/routes/session-upload-v1.ts',
    ]))
    const missing = readers.filter((f) => !/\bTransferServerStoppingError\b/.test(f.text)).map((f) => f.rel)
    expect(missing, 'these read a host as offline without telling this server\'s own stop apart (server-stopping.ts)').toEqual([])
  })

  it('in the transfer client every command goes through sendOn and every offline through noLink', () => {
    const src = read('src/core/transfer/daemon-transfer-client.ts')
    const sends = [...src.matchAll(/\.send\(/g)]
    expect(sends, 'a raw conn.send skips the stop check: use sendOn').toHaveLength(1)
    expect(body(src, 'async function sendOn(')).toContain('.send(')
    const offline = [...src.matchAll(/new TransferHostOfflineError\(/g)]
    expect(offline).toHaveLength(1)
    expect(body(src, 'function noLink(')).toMatch(/isServerStopping\(\)[\s\S]*new TransferHostOfflineError\(/)
    // connectionFor reads the stop before it resolves or dials anything.
    const conn = body(src, 'async function connectionFor(')
    expect(conn.indexOf('isServerStopping()')).toBeLessThan(conn.indexOf('await resolver('))
  })

  it('every catch in src/core/transfer/ that does not rethrow handles interruptedByShutdown first, or is listed', () => {
    // The catches no daemon call reaches, by file and a word of their body.
    const LISTED: Record<string, { marks: string[]; why: string }> = {
      'src/core/transfer/brief.ts': { marks: ['handoff brief model call failed'], why: 'a model call; the transcript tail stands in' },
      'src/core/transfer/source-in-use.ts': { marks: ['{   }', '{   }', '{   }'], why: 'local store reads for a refusal; no daemon call' },
      'src/core/transfer/transfer.ts': {
        marks: ['keepForUser(', 'keepForUser(', 'staged transcript could not be removed', 'return undefined', 'completing the source task failed', '{   }'],
        why: 'task_transfer is an in-memory job a restart ends (transfer-jobs.ts); hostFailure words the stop for the kept task; the rest are cleanup, a torn JSON line, a local read',
      },
    }
    const unlisted: string[] = []
    const used: Record<string, number> = {}
    for (const f of SOURCES.filter((s) => s.rel.startsWith('src/core/transfer/'))) {
      for (const [start, open, end] of catchBlocks(f.text)) {
        const b = f.text.slice(open, end)
        // retry.next (part-retry.ts) throws a stop as it is.
        if (/\bthrow\b/.test(b) || /interruptedByShutdown\(/.test(b) || /\bretry\.next\(/.test(b)) continue
        const flat = b.replace(/\s+/g, ' ')
        const mark = LISTED[f.rel]?.marks.find((m, i) => flat.includes(m.replace(/\s+/g, ' ')) && (used[`${f.rel}#${i}`] ?? 0) === 0 && (used[`${f.rel}#${i}`] = 1))
        if (!mark) unlisted.push(`${f.rel}:${lineOf(f.text, start)}`)
      }
    }
    expect(unlisted, 'a catch that swallows an error this server\'s stop caused reads it as the work\'s own failure').toEqual([])
  })
})

describe('a move a server stop cuts short is paused for the next boot', () => {
  const file = 'src/core/sessions/engine-switch.ts'
  const src = read(file)
  const blocks = catchBlocks(src)
  const inCatch = (at: number) => blocks.some(([s, , e]) => s < at && at < e)

  it('fail() pauses before it writes, and restore() puts nothing back while stopping', () => {
    const f = body(src, 'async function fail(')
    expect(f.indexOf('pauseForRestart(')).toBeGreaterThan(0)
    expect(f.indexOf('pauseForRestart(')).toBeLessThan(f.indexOf('updateTaskRaw('))
    const r = body(src, 'async function restore(')
    expect(r.indexOf('interruptedByShutdown(err)')).toBeGreaterThan(0)
    // Only the start that did not confirm is let go of before it.
    const before = r.slice(0, r.indexOf('interruptedByShutdown(err)'))
    expect(before).not.toMatch(/updateSessionRecord|linkSession|putQueuedRows|releaseMoveHeldRows/)
  })

  it('every catch throws what fail() answers, and hands restore() its error', () => {
    const calls = [...src.matchAll(/\bfail\(/g)].map((m) => m.index!).filter((at) => !/function\s*$/.test(src.slice(at - 12, at)))
    expect(calls.length).toBeGreaterThan(5)
    const bad = calls.filter((at) => inCatch(at) && !/throw await $/.test(src.slice(at - 12, at))).map((at) => `${file}:${lineOf(src, at)}`)
    expect(bad, 'its answer is the pause while this server stops: throw it').toEqual([])
    const restores = [...src.matchAll(/await restore\(([^;]*)\);/g)]
    expect(restores.length).toBeGreaterThan(3)
    for (const m of restores) expect(m[1], `${file}:${lineOf(src, m.index!)}`).toMatch(/, err$/)
  })

  it('the failures outside a catch are the listed ones', () => {
    const outside = [...src.matchAll(/await fail\(/g)].map((m) => m.index!).filter((at) => !inCatch(at))
      .map((at) => src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at)).trim())
    expect(outside).toEqual([
      // noteRefusedAfterWait: a person's pick refused before it ever ran.
      'await fail(req.taskId, state, err);',
      // execute: the session it started from is gone, before the claim (nothing done yet).
      "throw await fail(taskId, state, new EngineSwitchError('The session this switch started from is gone or already replaced', 409, 'switch_stale'));",
    ])
  })

  it('every write of a failed engine_switch is a listed one', () => {
    const allowed: Record<string, { count: number; why: string }> = {
      'src/core/sessions/engine-switch.ts': { count: 4, why: 'fail() (it pauses first), a refused waiting pick, a pick a newer one replaced, a cancel' },
      'src/core/sessions/engine-switch-watch.ts': { count: 2, why: 'a pending wait that ran out; at boot, a cut start that may still run (two CLIs otherwise)' },
    }
    const found: Record<string, number> = {}
    for (const f of SOURCES) {
      if (!/engine_switch|EngineSwitchState/.test(f.text)) continue
      const n = (f.text.match(/state: 'failed'/g) ?? []).length
      if (n) found[f.rel] = n
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(allowed).map(([k, v]) => [k, v.count])))
  })

  it('a paused switch stays `switching`, which the boot resumes after stopping a cut start', () => {
    const restart = read('src/core/sessions/engine-switch-restart.ts')
    expect(restart).not.toMatch(/state: 'failed'/)
    expect(restart).toContain("sw.state !== 'switching'")
    const watch = read('src/core/sessions/engine-switch-watch.ts')
    const resume = body(watch, 'export async function resumeEngineSwitches(')
    expect(resume).toContain("sw.state !== 'pending' && sw.state !== 'switching'")
    // A cut run took over only by the new session's own record, and its unconfirmed start is stopped first.
    expect(resume).toMatch(/tookOver\(/)
    expect(resume.indexOf('endUnconfirmedStarts(')).toBeLessThan(resume.indexOf("state: 'pending'"))
  })

  it('only the leader resumes switches at boot', () => {
    const server = read('src/web/server.ts')
    const call = server.indexOf('m.resumeEngineSwitches()')
    const gate = server.lastIndexOf("if (bootPolicy('one-session-per-task'))", call)
    expect(gate).toBeGreaterThan(0)
    expect(call - gate).toBeLessThan(1500)
    expect(fs.readFileSync(path.join(ROOT, 'src/core/boot-policy.ts'), 'utf8')).toMatch(/job: 'one-session-per-task', leader: true, replica: false/)
  })
})

describe('a long transfer waits out a dropped link', () => {
  const STEP = /\b(relayFile|copyPack|packWorkspace|applyPack|fetchFromHost|moveTaskWork|moveWorkspace)\(/g
  /** Each file that calls a long transfer step, its count, and how a dropped link is handled there. */
  const CALLERS: Record<string, { count: number; way: string }> = {
    'src/core/sessions/engine-switch.ts': { count: 1, way: 'task_move: runEngineSwitch runs the whole run under the link wait' },
    'src/core/transfer/task-work.ts': { count: 7, way: 'inside moveWork, which moveTaskWork runs under withLinkWait' },
    'src/core/transfer/move-resume.ts': { count: 1, way: 'copyNow, the probe pack, called from moveWork only' },
    'src/core/transfer/workspace.ts': { count: 4, way: 'moveWorkspace runs under withLinkWait; copyPack is called from waits only (and start-placement)' },
    'src/core/transfer/transfer.ts': { count: 2, way: 'task_transfer: the transcript relay runs under withLinkWait, the workspace through moveWorkspace' },
    'src/core/sessions/start-placement.ts': { count: 3, way: 'a first start placed on another host: its own deadline (a start never hangs; task-start.ts runs it under noLinkWait), then it starts where the folder is' },
    'src/core/hosts/host-copy.ts': { count: 1, way: 'host_copy: its own deadline and grant gate; a dropped link answers "Copy it again"' },
  }

  it('every caller of a long transfer step is listed with how it handles a dropped link', () => {
    const found: Record<string, number> = {}
    for (const f of SOURCES) {
      if (f.rel === 'src/core/transfer/daemon-transfer-client.ts') continue
      // Calls, not the definitions.
      const n = [...f.text.matchAll(STEP)].filter((m) => !/function\s*$/.test(f.text.slice(Math.max(0, m.index! - 16), m.index!))).length
      if (n) found[f.rel] = n
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(CALLERS).map(([k, v]) => [k, v.count])))
  })

  it('every sender of fs.writePart is listed', () => {
    const SENDERS: Record<string, string> = {
      'src/core/transfer/daemon-transfer-client.ts': 'writePart, the transfer client\'s one sender; its callers are listed below',
      'src/providers/daemon-net-update-io.ts': 'a daemon update\'s upload, one part on its own link; not a step of a move or a transfer',
    }
    const found = SOURCES.filter((f) => /(?:\.send\(|call<[^>]*>\([^)]*?)'fs\.writePart'/.test(f.text)).map((f) => f.rel).sort()
    expect(found).toEqual(Object.keys(SENDERS).sort())
  })

  it('every write of a file in parts is listed with whether it runs under the wait', () => {
    const WRITE = /\b(writePart|writeFileInParts|writeTargetFile)\(/g
    const WRITERS: Record<string, { count: number; way: string }> = {
      'src/core/transfer/daemon-transfer-client.ts': { count: 2, way: 'relayFile and writeFileInParts, each part through partRetry (part-retry.ts)' },
      'src/core/transfer/transfer.ts': { count: 3, way: 'writeTargetFile: in parts that wait inside a wait; task_transfer writes its transcript under withLinkWait' },
      'src/core/sessions/engine-switch-io.ts': { count: 1, way: 'the switch\'s transcript, inside the run runEngineSwitch runs under withLinkWait' },
      'src/core/hosts/host-mcp-images.ts': { count: 1, way: 'one picture for a tool\'s answer, its own deadline; no wait' },
      // The receivers: the daemon twins and the core they share.
      'src/providers/daemon-source.ts': { count: 1, way: 'the receiver' },
      'src/providers/daemon-standalone.ts': { count: 1, way: 'the receiver' },
      'src/providers/transfer-core.ts': { count: 1, way: 'the receiver' },
    }
    const found: Record<string, number> = {}
    for (const f of SOURCES) {
      const n = [...f.text.matchAll(WRITE)].filter((m) => !/function\s*$/.test(f.text.slice(Math.max(0, m.index! - 16), m.index!))).length
      if (n) found[f.rel] = n
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(WRITERS).map(([k, v]) => [k, v.count])))
    const client = read('src/core/transfer/daemon-transfer-client.ts')
    for (const fn of ['export async function relayFile(', 'export async function writeFileInParts(']) expect(body(client, fn)).toContain('partRetry(')
    expect(body(read('src/core/transfer/transfer.ts'), 'export async function writeTargetFile(')).toMatch(/if \(currentLinkWait\(\)\) \{[\s\S]*writeFileInParts\(host, filePath, bytes\)/)
    expect(read('src/core/transfer/transfer.ts')).toContain('withLinkWait(MOVE_LINK_WAIT_MS, () => writeTargetFile(')
  })

  it('the whole engine switch run is under the wait, and the steps with their own deadline leave it', () => {
    expect(body(read('src/core/sessions/engine-switch.ts'), 'export function runEngineSwitch(')).toContain('withLinkWait(MOVE_LINK_WAIT_MS, () => execute(')
    const leavers = SOURCES.filter((f) => /\bnoLinkWait\(/.test(f.text) && f.rel !== 'src/core/transfer/link-wait.ts').map((f) => f.rel).sort()
    expect(leavers).toEqual(['src/core/sessions/endpoint-wait.ts', 'src/core/sessions/task-start.ts'])
    expect(read('src/core/sessions/endpoint-wait.ts')).toContain('noLinkWait(() => probeModelEndpoint(')
    expect(read('src/core/sessions/task-start.ts')).toContain('noLinkWait(() => placeStartByLoad(')
  })

  it('the moves run under the link wait, and the client waits inside one', () => {
    const work = read('src/core/transfer/task-work.ts')
    expect(body(work, 'export async function moveTaskWork(')).toContain('withLinkWait(MOVE_LINK_WAIT_MS, () => moveWork(opts))')
    expect(body(read('src/core/transfer/workspace.ts'), 'export async function moveWorkspace(')).toContain('withLinkWait(MOVE_LINK_WAIT_MS,')
    expect(read('src/core/transfer/transfer.ts')).toContain('withLinkWait(MOVE_LINK_WAIT_MS, () => relayFile(')
    const client = read('src/core/transfer/daemon-transfer-client.ts')
    expect(body(client, 'async function connectionFor(')).toMatch(/currentLinkWait\(\)[\s\S]*awaitLink\(/)
    // A part a lost link cut is not counted as a failed part inside a wait (relay and file writes alike).
    expect(body(read('src/core/transfer/part-retry.ts'), 'export function partRetry(')).toMatch(/if \(wait && \(kind === 'no-link' \|\| kind === 'lost'/)
    // A lost command goes again only when it can run twice: never an apply, a clear, a fetch or a write.
    const resend = read('src/core/transfer/transfer-errors.ts')
    const list = resend.slice(resend.indexOf('RESEND_ON_LOST'))
    for (const never of ['transfer.apply', 'transfer.clear', 'transfer.fetch', 'fs.writePart', 'upload.part']) expect(list).not.toContain(`'${never}'`)
  })
})
