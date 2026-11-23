/**
 * A promotion swaps a home around this machine's daemon, which keeps writing in it
 * (src/core/leader/switch/promote.ts; home-manifest isMachineRuntimePath).
 *
 * The installed layout: the daemon's dir is `<HOME>/.cache/open-walnut` and its journal root,
 * leader book, streams and samples are in the data home's `tmp/` (daemon-standalone.ts keeps
 * them there for the daemon on its production dir, which a test must never use; here the
 * same places are given by WALNUT_JOURNAL_DIR, WALNUT_STREAMS_DIR, WALNUT_HOST_VITALS_DIR).
 * A real daemon (the standalone twin, on bun) holds a leader book and an offline slice of a
 * Walnut, and runs a session whose CLI prints a numbered line every 5 ms into the stream the
 * daemon writes in the home. Then the home is promoted twice, both shapes a switch meets:
 *   - the first switch's target, a folder holding only this machine's daemon state;
 *   - a switch back's target, a handed-over home full of leader data with its marker.
 * Each time: the daemon's files are at the path it reads (the same file, not a new one), the
 * daemon still answers from them, and the stream holds every numbered line, none missing,
 * the ones printed during the promotion included. The old leader data is in
 * `<home>.before-<switch>`, with no daemon file in it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import YAML from 'yaml'
import { testBun } from '../../../helpers/bun-runtime.js'
import { promoteCopy, promotedBy } from '../../../../src/core/leader/switch/promote.js'

const ROOT = path.resolve(__dirname, '../../../..')
const BUN = testBun()
const d = BUN ? describe : describe.skip
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const keyOf = (home: string) => createHash('sha1').update(home).digest('hex').slice(0, 16)

const SID = 'aaaaaaaa-6666-4666-8666-666666666666'
const WALNUT = 'wpromoteruntime01'

/** A CLI that prints a numbered line every 5 ms, forever. */
const MOCK_CLI = `
const fs = require('fs')
const sid = process.argv[2]
fs.appendFileSync(process.argv[3], process.pid + '\\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
let n = 0
setInterval(() => out({ type: 'system', subtype: 'status', session_id: sid, tick: ++n }), 5)
process.stdin.on('data', () => {})
`

let base = ''
let account = ''
let home = ''
let daemonDir = ''
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let leaderHome = ''

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

let rpcId = 1
function cmd(body: Record<string, unknown>): Promise<Record<string, any>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws!.off('message', on); reject(new Error(`cmd ${String(body.cmd)} timed out`)) }, 20_000)
    const on = (data: WebSocket.Data) => {
      try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(t); ws!.off('message', on); resolve(m) } } catch { /* not json */ }
    }
    ws!.on('message', on)
    ws!.send(JSON.stringify({ id, ...body }))
  })
}

const streamFile = () => path.join(home, 'tmp', 'streams', `${SID}.jsonl`)
const leaderBook = () => path.join(home, 'tmp', 'leader', `leader-${keyOf(leaderHome)}.json`)
const sliceFile = () => path.join(home, 'tmp', 'offline-host', `slice-${keyOf(leaderHome)}.json`)

/** The numbered lines of the stream at the path the daemon reads. */
function ticks(): number[] {
  let text = ''
  try { text = fs.readFileSync(streamFile(), 'utf8') } catch { return [] }
  const out: number[] = []
  for (const line of text.split('\n')) {
    const m = /"tick":(\d+)/.exec(line)
    if (m) out.push(Number(m[1]))
  }
  return out
}

/** A standby copy as the target leaves it: leader data only, files 0400, dirs 0500. */
function makeCopy(standby: string, files: Record<string, string>): void {
  const copy = path.join(standby, 'copy')
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(copy, rel)), { recursive: true })
    fs.writeFileSync(path.join(copy, rel), body)
  }
  const ro = (p: string) => {
    if (fs.statSync(p).isDirectory()) { for (const e of fs.readdirSync(p)) ro(path.join(p, e)); fs.chmodSync(p, 0o500) } else fs.chmodSync(p, 0o400)
  }
  ro(copy)
}

/** Every file under `dir`, relative. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    let names: fs.Dirent[] = []
    try { names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }) } catch { return }
    for (const e of names) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else out.push(r)
    }
  }
  walk('')
  return out.sort()
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-promote-runtime-'))
  account = path.join(base, 'machine-b')
  home = path.join(account, '.open-walnut')
  daemonDir = path.join(account, '.cache', 'open-walnut')
  leaderHome = path.join(base, 'machine-a', '.open-walnut')
  fs.mkdirSync(daemonDir, { recursive: true, mode: 0o700 })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: account,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_JOURNAL_DIR: path.join(home, 'tmp'),
    WALNUT_STREAMS_DIR: path.join(home, 'tmp', 'streams'),
    WALNUT_HOST_VITALS_DIR: path.join(home, 'tmp', 'host-vitals'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(base, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(daemonDir, 'spawn-journal.jsonl'),
  }
  for (const k of ['VITEST', 'VITEST_MODE', 'VITEST_WORKER_ID', 'VITEST_POOL_ID', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_HOME', 'OPEN_WALNUT_HOME']) delete env[k]
  proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', process.env.DEBUG_DAEMON ? 'pipe' : 'ignore'], cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[daemon] ${b}`))
  await waitFor(() => fs.existsSync(path.join(daemonDir, 'daemon.port')) && fs.existsSync(path.join(daemonDir, 'daemon.pid')), 90_000, 'the daemon')
  const port = Number(fs.readFileSync(path.join(daemonDir, 'daemon.port'), 'utf8').trim())
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.once('open', () => resolve(s))
    s.once('error', reject)
  })
  // The Walnut that leads from machine A: its leader book and its offline slice on this host.
  expect((await cmd({ cmd: 'leader.configure', home: leaderHome, walnutId: WALNUT, backup: false })).ok).toBe(true)
  const slice = { v: 1, home: leaderHome, hash: 'h1', asOf: Date.now(), host: 'machine-b', sessions: [], tasks: [], requests: [] }
  expect((await cmd({ cmd: 'host.slice', slice })).ok).toBe(true)
  // A session whose output the daemon streams into the home.
  const mock = path.join(base, 'mock-cli.cjs')
  fs.writeFileSync(mock, MOCK_CLI)
  const r = await cmd({ cmd: 'start', sid: SID, cwd: base, message: 'go', args: [process.execPath, mock, SID, path.join(base, 'mock-pids.txt')], origin: { home: leaderHome, task: 'tpromote-0001' } })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  await waitFor(() => ticks().length > 20, 30_000, 'the stream in the home')
}, 180_000)

afterAll(() => {
  try { ws?.close() } catch { /* closed */ }
  const pids: number[] = []
  try { pids.push(...fs.readFileSync(path.join(base, 'mock-pids.txt'), 'utf8').split('\n').map((l) => parseInt(l, 10)).filter((n) => n > 1)) } catch { /* none */ }
  try { pids.push(parseInt(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8'), 10)) } catch { /* none */ }
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  const open = (p: string) => { try { fs.chmodSync(p, 0o700) } catch { /* gone */ } }
  const walk = (p: string) => { open(p); try { if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e)) } catch { /* gone */ } }
  if (base && fs.existsSync(base)) { walk(base); fs.rmSync(base, { recursive: true, force: true }) }
})

/** One promotion while the daemon writes; the checks every promotion must pass. */
async function promoteWhileWriting(switchId: string, files: Record<string, string>): Promise<void> {
  const standby = path.join(base, `standby-${switchId}`)
  makeCopy(standby, files)
  const inode = (f: string) => fs.statSync(f).ino
  const before = { stream: inode(streamFile()), book: inode(leaderBook()), slice: inode(sliceFile()) }
  const startTick = ticks().at(-1)!
  const r = await promoteCopy({ switchId, standbyDir: standby, home, previousHome: leaderHome, reverseStandbyDir: path.join(base, 'machine-a', 'standby') })
  const endOfPromote = Date.now()
  // Lines the CLI printed during the promotion and after it reach the same file.
  await sleep(300)
  const after = ticks()
  expect(promotedBy(home)).toBe(switchId)
  for (const [rel, body] of Object.entries(files)) if (rel !== 'config.yaml') expect(fs.readFileSync(path.join(home, rel), 'utf8')).toBe(body)
  expect(YAML.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).standby.dir).toBe(path.join(base, 'machine-a', 'standby'))
  // The daemon's files: at the path it reads, the same files.
  expect({ stream: inode(streamFile()), book: inode(leaderBook()), slice: inode(sliceFile()) }).toEqual(before)
  // Not one line lost: 1..last with no gap, past the line printed when the promotion began.
  expect(after.at(-1)!).toBeGreaterThan(startTick + 10)
  const gaps = after.filter((n, i) => n !== i + 1)
  expect(gaps.slice(0, 5)).toEqual([])
  // The daemon still answers from them.
  expect((await cmd({ cmd: 'host.slice', home: leaderHome, hash: 'h1', asOf: endOfPromote })).have).toBe(true)
  expect((await cmd({ cmd: 'leader.configure', home: leaderHome, walnutId: WALNUT, backup: false })).ok).toBe(true)
  expect(fs.existsSync(leaderBook())).toBe(true)
  // Nothing of the daemon went with the old folder.
  if (r.movedAside) expect(filesUnder(r.movedAside).filter((f) => /^tmp\/(streams|leader|offline-host|host-vitals)\//.test(f))).toEqual([])
}

d('a promotion swaps a home around the daemon that writes in it', () => {
  it('the first switch: a folder holding only this machine\'s daemon state takes the copy', async () => {
    expect(filesUnder(home).every((f) => f.startsWith('tmp/'))).toBe(true)
    await promoteWhileWriting('s1', {
      'config.yaml': YAML.stringify({ standby: { dir: '/x' } }),
      'notes/a.md': '# a\n',
      'tmp/file-history/k/index.json': '{"path":"a"}',
    })
    // Nothing but daemon state was there: no folder moved aside.
    expect(fs.existsSync(`${home}.before-s1`)).toBe(false)
  }, 120_000)

  it('a switch back: a handed-over home full of leader data, its marker kept in the folder moved aside', async () => {
    fs.mkdirSync(path.join(home, 'local', 'leader-switch'), { recursive: true })
    fs.writeFileSync(path.join(home, 'local', 'leader-switch', 'handed-over.json'), JSON.stringify({ switchId: 's1b', state: 'handed-over' }))
    fs.writeFileSync(path.join(home, 'notes', 'b.md'), '# written while it led\n')
    await promoteWhileWriting('s2', {
      'config.yaml': YAML.stringify({ standby: { dir: '/y' } }),
      'notes/a.md': '# a again\n',
      'notes/c.md': '# c\n',
      'tmp/file-history/k/index.json': '{"path":"b"}',
    })
    const aside = `${home}.before-s2`
    expect(JSON.parse(fs.readFileSync(path.join(aside, 'local', 'leader-switch', 'handed-over.json'), 'utf8')).state).toBe('handed-over')
    expect(fs.readFileSync(path.join(aside, 'notes', 'b.md'), 'utf8')).toBe('# written while it led\n')
    expect(fs.readFileSync(path.join(aside, 'tmp', 'file-history', 'k', 'index.json'), 'utf8')).toBe('{"path":"a"}')
    expect(fs.existsSync(path.join(home, 'notes', 'b.md'))).toBe(false)
  }, 120_000)
})
