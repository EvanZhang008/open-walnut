/**
 * Row R17 of docs/plan/walnut-replica-servers-impl.md (section 10, WP14): a host
 * replica at the user's real density, on the replica-cluster harness (every piece a
 * real process: the Mac server, the host daemon twin, the replica):
 *
 *   6,500 tasks, 5,000 sessions (1,000 of them on the host), 3,000 notes, written
 *   into the Mac's stores by a fixed generator (neutral names, no randomness) before
 *   the Mac boots; then:
 *     - the first copy round of tasks and of sessions each finishes in under 10 s
 *       (the Mac's own `replica copy round` line, section 13) and the replica's copy
 *       holds every row;
 *     - with the Mac asleep (SIGSTOP), the board's load from the replica (the task
 *       list the board asks for, the sessions, the notes tree) answers from the
 *       copies in under 3 s, every row there.
 *
 *   The drain of 1 MB conflicting notes (with a stall recorder assertion on the Mac)
 *   needs WP11's note journal: its block runs only when the daemon advertises
 *   `note-journal-v1`, and otherwise says that it was skipped and why.
 *
 * Slow (tests/e2e is never in the quick tier). The large run (tests/setup/large-run.sh)
 * runs it 3 times. REPLICA_SCALE_TWIN picks the daemon twin (default: source).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { BUN, ROOT, startReplicaCluster, waitFor, type ReplicaCluster, type SeedMac, type Twin } from '../helpers/replica-cluster.js'

const TASKS = 6_500
const SESSIONS = 5_000
const HOST_SESSIONS = 1_000
const NOTES = 3_000
/** Notes just under the 1 MB a host copies (larger ones are never written away). */
const BIG_NOTES = 5
const BIG_LINES = 30_000
const bigPath = (i: number) => `Acme big/Big ${i}.md`
const ROUND_MS = 10_000
const BOARD_MS = 3_000
const TWIN: Twin = process.env.REPLICA_SCALE_TWIN === 'standalone' && BUN ? 'standalone' : 'source'
const NOTE_JOURNAL = (ADVERTISED_DAEMON_CAPABILITIES as readonly string[]).includes('note-journal-v1')
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx')

/**
 * The fixed generator: the Mac's stores written the way the Mac writes them (task-db,
 * session-db), the notes as files in its vault. Ids and text are a function of the
 * index only, so every run holds the same data.
 */
const SEED = (src: string) => `
process.umask(0o077)
const c = await import(${JSON.stringify(path.join(src, 'constants.ts'))})
if (!c.WALNUT_HOME.includes('/rcl-')) { process.stderr.write('REFUSING: not a cluster home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const taskDb = await import(${JSON.stringify(path.join(src, 'core/task-db.ts'))})
const sessionDb = await import(${JSON.stringify(path.join(src, 'core/session-db.ts'))})
const fs = await import('node:fs')
const path = await import('node:path')
const put = (db, table, row) => { const cols = Object.keys(row).filter((k) => row[k] !== undefined); db.prepare('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map((x) => '@' + x).join(',') + ')').run(Object.fromEntries(cols.map((x) => [x, row[x]]))) }
const now = Date.UTC(2026, 9, 10, 8, 0, 0)
const t = taskDb.getDb()
t.transaction(() => { for (let i = 0; i < ${TASKS}; i++) put(t, 'tasks', taskDb.taskToRow({ id: 'task-marina-' + i, title: 'Marina task ' + i, status: 'todo', phase: i % 5 === 0 ? 'COMPLETE' : 'TODO', priority: 'none', project: 'acme-' + (i % 40), source: 'local', created_at: new Date(now - i * 60000).toISOString(), updated_at: new Date(now - i * 30000).toISOString(), description: 'Acme notes for the drill. '.repeat(8), tags: [] })) })()
const s = sessionDb.getDb()
s.transaction(() => { for (let i = 0; i < ${SESSIONS}; i++) put(s, 'sessions', sessionDb.sessionToRow({ claudeSessionId: '00000000-0000-4000-8000-' + String(i).padStart(12, '0'), taskId: 'task-marina-' + (i % ${TASKS}), project: 'acme-' + (i % 40), process_status: 'stopped', mode: 'default', startedAt: new Date(now - i * 90000).toISOString(), lastActiveAt: new Date(now - i * 45000).toISOString(), messageCount: i % 50, cwd: '/home/marina/acme', ...(i < ${HOST_SESSIONS} ? { host: 'devbox' } : {}), title: 'Acme session ' + i })) })()
taskDb.closeDb(); sessionDb.closeDb()
for (let i = 0; i < ${NOTES}; i++) {
  const file = path.join(c.NOTES_DIR, 'Acme ' + (i % 30), 'Note ' + i + '.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '# Note ' + i + '\\n\\nThe drill checklist, part ' + i + '. \\u00e9t\\u00e9\\r\\n' + 'Line of the note. '.repeat(10) + '\\n')
}
for (let i = 0; i < ${BIG_NOTES}; i++) {
  const file = path.join(c.NOTES_DIR, 'Acme big', 'Big ' + i + '.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = ['# Big ' + i]
  for (let k = 0; k < ${BIG_LINES}; k++) lines.push('Big ' + i + ' line ' + k + ' of the drill.')
  fs.writeFileSync(file, lines.join('\\n') + '\\n')
}
process.stdout.write('SEEDED\\n')
`

const seedMac: SeedMac = ({ base, env }) => {
  const file = path.join(base, 'seed.mts')
  fs.writeFileSync(file, SEED(path.join(ROOT, 'src')))
  const run = path.join(base, 'seed-run')
  fs.mkdirSync(run, { recursive: true, mode: 0o700 })
  const out = execFileSync(TSX, [file], { cwd: ROOT, env: { ...env, WALNUT_DAEMON_DIR: run }, encoding: 'utf8', timeout: 240_000 })
  if (!out.includes('SEEDED')) throw new Error('the scale seed did not finish: ' + out.slice(-500))
}

/** How many different names match (the tree may carry a note's name and its path). */
const uniq = (text: string, re: RegExp): number => new Set(text.match(re) ?? []).size

/** The Mac's structured log lines (its LOG_DIR is the cluster's Mac daemon dir). */
function macLines(c: ReplicaCluster, message: string): Array<Record<string, any>> {
  const dir = path.join(c.base, 'md')
  const out: Array<Record<string, any>> = []
  for (const n of fs.readdirSync(dir).filter((x) => /^open-walnut-.*\.log$/.test(x))) {
    for (const l of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) {
      if (!l.includes(message)) continue
      try { const o = JSON.parse(l); if (o.message === message) out.push(o) } catch { /* torn */ }
    }
  }
  return out
}

describe(`R17: a host replica at real density (${TWIN} twin)`, () => {
  let c: ReplicaCluster
  let token = ''
  const phone = (p: string) => c.replica('GET', p, { token })

  beforeAll(async () => {
    const t0 = Date.now()
    c = await startReplicaCluster({ twin: TWIN, seedMac })
    process.stdout.write(`replica-scale-e2e: cluster at ${c.base}, up in ${Date.now() - t0} ms\n`)
    token = await c.pairDevice('marina-phone')
  }, 600_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('the first copy rounds of tasks and sessions each finish in under 10 s, and the copy holds every row', async () => {
    const t0 = Date.now()
    await waitFor(() => ((c.stores().taskRows as unknown[]).length >= TASKS ? true : null), 180_000, `the replica's copy to hold ${TASKS} tasks`, 2_000)
    const wallMs = Date.now() - t0
    const first = (kind: string, entries: number) => waitFor(() => macLines(c, 'replica copy round').find((l) => l.kind === kind && l.target === 'host:devbox' && l.entries >= entries) ?? null, 120_000, `the Mac's first ${kind} round`, 1_000)
    const tasks = await first('tasks', TASKS)
    const sessions = await first('sessions', SESSIONS)
    process.stdout.write(`replica-scale-e2e: tasks round ${tasks.ms} ms (need ${tasks.need}), sessions round ${sessions.ms} ms (need ${sessions.need}), copy whole after ${wallMs} ms\n`)
    expect(tasks.need).toBeGreaterThanOrEqual(TASKS)
    expect(tasks.ms).toBeLessThan(ROUND_MS)
    expect(sessions.ms).toBeLessThan(ROUND_MS)
    const ids = new Set((c.stores().taskRows as Array<{ id: string }>).map((r) => r.id))
    for (const i of [0, 1, 3_249, TASKS - 1]) expect(ids.has(`task-marina-${i}`)).toBe(true)
  }, 400_000)

  it('the Mac asleep: the board loads from the copies in under 3 s, every row there', async () => {
    // The notes copy (through the daemon) is whole before the lid closes.
    await waitFor(async () => {
      const r = await phone('/api/notes-v2')
      return r.status === 200 && uniq(r.text, /Note \d+\.md/g) >= NOTES ? true : null
    }, 180_000, `the notes copy to hold ${NOTES} notes`, 2_000)
    c.sleepMac()
    try {
      await c.waitAway(token, 90_000)
      const timed = async (p: string) => { const t = Date.now(); const r = await phone(p); return { r, ms: Date.now() - t } }
      const t0 = Date.now()
      const [list, sessions, tree] = await Promise.all([
        timed('/api/tasks?fields=list&completedWithinDays=7'),
        timed('/api/sessions'),
        timed('/api/notes-v2'),
      ])
      const boardMs = Date.now() - t0
      process.stdout.write(`replica-scale-e2e: away board ${boardMs} ms (tasks ${list.ms}, sessions ${sessions.ms}, notes ${tree.ms}), ${list.r.text.length + sessions.r.text.length + tree.r.text.length} bytes\n`)
      for (const x of [list, sessions, tree]) {
        expect(x.r.status).toBe(200)
        expect(x.r.headers['x-walnut-offline']).toBeDefined()
      }
      expect(boardMs).toBeLessThan(BOARD_MS)
      const open = (list.r.json.tasks as Array<{ id: string }>).filter((t) => t.id.startsWith('task-marina-'))
      // Every open task is on the board (a fifth are complete and older than 7 days: counted, not sent).
      expect(open.length).toBe(TASKS - TASKS / 5)
      expect(Number(list.r.json.completedHidden ?? 0)).toBeGreaterThanOrEqual(TASKS / 5)
      expect((sessions.r.json.sessions as unknown[]).length).toBeGreaterThanOrEqual(SESSIONS)
      expect(uniq(tree.r.text, /Note \d+\.md/g)).toBeGreaterThanOrEqual(NOTES)
    } finally {
      c.wakeMac()
    }
  }, 400_000)

  // The drain of 1 MB conflicting notes needs WP11's note journal (cap note-journal-v1).
  if (!NOTE_JOURNAL) {
    process.stdout.write('replica-scale-e2e: the 1 MB conflicting notes drain is SKIPPED: this tree has no note journal (cap note-journal-v1, WP11); it runs once WP11 lands\n')
  }
  describe.skipIf(!NOTE_JOURNAL)('the drain of 1 MB conflicting notes (the note journal, WP11)', () => {
    it('each note edited on both sides drains to one note and one conflict copy, with no event-loop stall on the Mac', async () => {
      const vault = path.join(c.macData, 'notes')
      await waitFor(async () => {
        const r = await phone('/api/notes-v2')
        return r.status === 200 && uniq(r.text, /Big \d+\.md/g) >= BIG_NOTES ? true : null
      }, 180_000, 'the big notes in the copy', 2_000)
      c.sleepMac()
      try {
        await c.waitAway(token, 90_000)
        // Away for writes too: the quiet window has passed (`away`), not one failed stream
        // (`suspect`, whose writes are still forwarded to the stopped Mac).
        await waitFor(async () => ((await phone('/api/tasks')).headers['x-walnut-offline-why'] === 'away' ? true : null), 60_000, 'the replica to say away', 250)
        for (let i = 0; i < BIG_NOTES; i++) {
          const file = path.join(vault, bigPath(i))
          const base = fs.readFileSync(file, 'utf8')
          const away = base.replace(`Big ${i} line 7 of the drill.`, `Big ${i} line 7, edited away on devbox.`)
          const r = await c.replica('PUT', `/api/notes-v2/content/${encodeURI(bigPath(i))}`, { token, body: { content: away } })
          expect(r.status, r.text.slice(0, 300)).toBeLessThan(300)
          // The same line on the Mac while it sleeps (another editor there): a conflicting hunk.
          fs.writeFileSync(file, base.replace(`Big ${i} line 7 of the drill.`, `Big ${i} line 7, edited on the Mac.`))
        }
      } finally {
        c.wakeMac()
      }
      const wokeAt = new Date().toISOString()
      const copies = () => fs.readdirSync(path.join(vault, 'Acme big')).filter((n) => /^Big \d+ \(conflict .+\)\.md$/.test(n))
      await waitFor(() => (copies().length >= BIG_NOTES ? true : null), 240_000, 'a conflict copy of each big note', 2_000)
      for (let i = 0; i < BIG_NOTES; i++) {
        const note = fs.readFileSync(path.join(vault, bigPath(i)), 'utf8')
        const copy = copies().find((n) => n.startsWith(`Big ${i} (conflict `))
        expect(copy).toBeDefined()
        const other = fs.readFileSync(path.join(vault, 'Acme big', copy!), 'utf8')
        // One side in the note, the other in the copy: nothing lost.
        const both = note + other
        expect(both).toContain(`Big ${i} line 7, edited away on devbox.`)
        expect(both).toContain(`Big ${i} line 7, edited on the Mac.`)
        expect(note).toContain(`Big ${i} line ${BIG_LINES - 1} of the drill.`)
      }
      // The Mac drained 5 MB of notes with its event loop answering throughout.
      const stalls = macLines(c, 'event-loop stall flight record').filter((l) => String(l.time) >= wokeAt)
      expect(stalls, JSON.stringify(stalls.slice(0, 2))).toHaveLength(0)
    }, 600_000)
  })
})

