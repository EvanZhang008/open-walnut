/**
 * The orphaned-link repair the integrity check points at
 * (scripts/repair-orphan-session-links.mjs, named by src/core/session-integrity.ts):
 * the check used to tell the user `node scripts/...`, which fails at the
 * script's first database open now that SQLite is bun's, and the script read
 * only WALNUT_DATA_DIR, never the OPEN_WALNUT_HOME Walnut itself runs on.
 *
 * Real stores: the schemas come from src/core/task-db.ts and session-db.ts in a
 * temp home, and the script runs as the command the check prints.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-repair-orphans'))

import { WALNUT_HOME } from '../../src/constants.js'
import { getDb as taskDb, closeDb as closeTaskDb } from '../../src/core/task-db.js'
import { getDb as sessionDb, closeDb as closeSessionDb } from '../../src/core/session-db.js'
import { repairCommand } from '../../src/core/session-integrity.js'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** Runs the command repairCommand() prints, from the checkout, with extra args. */
function runRepair(...args: string[]) {
  const command = repairCommand(WALNUT_HOME).replace(/^from a Walnut checkout: /, '').replace(/ \(.*\)$/, '')
  const [assign, runtime, script] = command.split(' ')
  const env: NodeJS.ProcessEnv = { ...process.env, [assign.split('=')[0]]: assign.slice(assign.indexOf('=') + 1) }
  delete env.WALNUT_DATA_DIR
  expect(runtime).toBe('bun')
  return spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', env })
}

beforeAll(() => {
  const t = taskDb()!
  const s = sessionDb()!
  t.prepare("INSERT INTO tasks (id, title, source) VALUES ('t-live', 'Live task', 'local')").run()
  const add = s.prepare('INSERT INTO sessions (claude_session_id, task_id, title, message_count, started_at) VALUES (?, ?, ?, ?, ?)')
  add.run('s-linked', 't-live', 'Linked', 3, '2026-10-01T00:00:00.000Z')
  add.run('s-orphan', 't-gone', 'Orphaned', 7, '2026-10-02T00:00:00.000Z')
  closeTaskDb()
  closeSessionDb()
})

afterAll(() => fs.rmSync(WALNUT_HOME, { recursive: true, force: true }))

describe('the orphaned-link repair the integrity check names', () => {
  it('is a bun command run from a checkout, for the data home this Walnut runs on', () => {
    expect(repairCommand('/home/alice/.open-walnut')).toBe(
      'from a Walnut checkout: OPEN_WALNUT_HOME=/home/alice/.open-walnut bun scripts/repair-orphan-session-links.mjs (a dry run; add --apply to write, --verify to recount)',
    )
    expect(repairCommand("/Users/a b/it's")).toContain(`OPEN_WALNUT_HOME='/Users/a b/it'\\''s' bun `)
    expect(fs.existsSync(path.join(ROOT, 'scripts/repair-orphan-session-links.mjs'))).toBe(true)
  })

  it('--verify counts the orphan in OPEN_WALNUT_HOME and exits 1', () => {
    const r = runRepair('--verify')
    expect(r.status, r.stderr).toBe(1)
    expect(r.stdout).toContain(`sessions:  ${path.join(WALNUT_HOME, 'sessions.sqlite')}`)
    expect(r.stdout).toContain('orphans: 1 sessions across 1 dead task ids')
    expect(r.stdout).toContain('duplicate remote ids: 0 groups')
  })

  it('the dry run classifies it, writes only its manifest, and changes no row', () => {
    const r = runRepair()
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Dry-run only.')
    const manifests = fs.readdirSync(WALNUT_HOME).filter((f) => f.startsWith('orphan-repair-manifest-'))
    expect(manifests).toHaveLength(1)
    const lines = fs.readFileSync(path.join(WALNUT_HOME, manifests[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0]).toMatchObject({ _summary: true, mode: 'dry-run', orphansFound: 1 })
    expect(lines.slice(1).map((l) => [l.sid, l.old_task_id, l.action, l.applied])).toEqual([['s-orphan', 't-gone', 'clear task_id', false]])
    const row = sessionDb()!.prepare("SELECT task_id FROM sessions WHERE claude_session_id = 's-orphan'").get() as { task_id: string }
    closeSessionDb()
    expect(row.task_id).toBe('t-gone')
  })
})
