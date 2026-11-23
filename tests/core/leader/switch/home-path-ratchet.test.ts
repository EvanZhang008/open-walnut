/**
 * Ratchet: every absolute path of the old machine a promoted home holds is decided
 * (src/core/leader/switch/home-path-rules.ts): rewritten by the promotion, or kept with a reason.
 *
 * A synthetic home is filled by the real writers where there is one (the task store, the session
 * store, the config writer, the applied-ops ledger, the folder lists) and in the writers' shapes
 * elsewhere, with paths under the home and under a fake account home. It goes through a real
 * standby batch and a real promotion to another home under another account home, then:
 *   - no hit is left that the promotion should have rewritten, and none that no rule decides;
 *   - every rule is met (a rule no store needs any more fails), every store of a rewrite rule too;
 *   - every leader-data store of the home manifest is in a rule or in NO_PATH_STORES, so a new
 *     store is red here until someone decides what its paths do.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('../../../../src/constants.js', async () => {
  const { createMockConstants } = await import('../../../helpers/mock-constants.js')
  return createMockConstants('walnut-home-path-ratchet')
})

import { WALNUT_HOME } from '../../../../src/constants.js'
import Database from '../../../../src/lib/sqlite.js'
import { classifyHomePath, homeEntries } from '../../../../src/core/home-manifest/index.js'
import { addTask, setProjectMetadata } from '../../../../src/core/task-manager.js'
import { closeDb as closeTaskDb } from '../../../../src/core/task-db.js'
import { createSessionRecord } from '../../../../src/core/session-tracker.js'
import { closeDb as closeSessionDb } from '../../../../src/core/session-db.js'
import { modifyConfigDoc } from '../../../../src/core/config-store.js'
import { recordApplied, _setLedgerFileForTesting } from '../../../../src/core/offline-merge/ledger.js'
import { recordDirectory } from '../../../../src/core/frequent-dirs.js'
import { recordMentionDir } from '../../../../src/core/mention-dirs.js'
import { snapshotTo, verifyStandby } from '../../../../src/core/standby/index.js'
import { promoteCopy } from '../../../../src/core/leader/switch/promote.js'
import { leftoverPaths } from '../../../../src/core/leader/switch/self-check.js'
import { judgePathHits, pathRoots, ruleFor, scanHomePaths, type PathHit, type ScanResult } from '../../../../src/core/leader/switch/home-paths.js'
import { homePathRules, LEDGER_RULE, NO_PATH_STORES } from '../../../../src/core/leader/switch/home-path-rules.js'

// Fake account homes: only strings in the data, nothing is made there.
const OLD_ACCOUNT = '/home/ratchet-old'
const NEW_ACCOUNT = '/Users/ratchet-new'
const rules = homePathRules()

let other = ''
let newHome = ''
let before: ScanResult
let after: ScanResult
let taskIds: string[] = []

function put(rel: string, content: string): void {
  const abs = path.join(WALNUT_HOME, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

async function seed(): Promise<void> {
  const H = WALNUT_HOME
  const A = OLD_ACCOUNT
  // config.yaml through its writer.
  await modifyConfigDoc((doc) => {
    Object.assign(doc, {
      experimental: { switchable_leader: true },
      standby: { dir: path.join(other, 'b', 'standby'), walnut: `${A}/bin/walnut` },
      leader_switch: { machines: [{ id: 'a', home: H, standby_dir: `${A}/standby`, account_home: A }, { id: 'b', home: newHome, standby_dir: path.join(other, 'b', 'standby'), account_home: NEW_ACCOUNT }] },
      stt: { whisper_cpp_model: `${A}/models/ggml-base.bin` },
      self_repair: { source_dir: `${A}/code/open-walnut` },
      push: { apns: { key_path: `${H}/secrets/apns.p8` } },
      usage: { proxy_log_dirs: { 'host-x': `${A}/proxy-logs` } },
    })
    return { write: true, result: null }
  })
  put('config.yaml.history/2026-11-01.yaml', `stt:\n  whisper_cpp_model: ${A}/models/old.bin\n`)
  put('config/share/settings.json', JSON.stringify({ vault_dir: `${A}/Documents/vault` }))
  // Tasks and a project, through the task store.
  const t1 = (await addTask({ title: 'Work in a repo', project: 'Ratchet', cwd: `${A}/code/proj`, description: `notes in ${A}/notes/plan.md` } as never)).task
  const t2 = (await addTask({ title: 'Work in the home', project: 'Ratchet', cwd: H } as never)).task
  taskIds = [t1.id, t2.id]
  await setProjectMetadata('Ratchet', { default_cwd: `${H}/workdir` }).catch(() => undefined)
  // A session, through the session store.
  await createSessionRecord('11111111-2222-4333-8444-555555555555', t1.id, 'Ratchet', `${A}/code/proj`, {
    outputFile: `${A}/.cache/open-walnut/streams/s.jsonl`, planFile: `${A}/.claude/plans/plan.md`,
  })
  // Folder lists, through their writers.
  await recordDirectory(`${A}/code/proj`, null)
  await recordMentionDir(`${A}/code/other`, null)
  // The applied-ops ledger: this home's op, and another home's.
  recordApplied({ hostKey: 'local', home: H, opId: 'op-1' }, { outcome: 'applied', status: 200, body: '{}' })
  recordApplied({ hostKey: 'host-x', home: `${A}/.open-walnut-former`, opId: 'op-2' }, { outcome: 'applied', status: 200, body: '{}' })
  // Triggers, scripts, plugins (in the writers' shapes: src/core/cron/store.ts persist(), agents' scripts).
  put('cron-jobs.json', JSON.stringify({ version: 1, jobs: [{ id: 'j1', name: 'watch', check: { run: `bash ${H}/triggers/t1/check.sh`, cwd: `${A}/code/proj` } }] }, null, 2))
  put('triggers/t1/check.sh', `#!/bin/sh\ncat ${H}/notes/watch.md\ncd ${A}/code/proj\n`)
  put('hooks/pre.sh', `#!/bin/sh\nexec ${H}/hooks/lib.sh\n`)
  put('actions/deploy.json', JSON.stringify({ run: `${H}/actions/deploy.sh` }))
  put('commands/review.md', `Read ${H}/memory/MEMORY.md first.\n`)
  put('skills/s1/SKILL.md', `Run ${H}/skills/s1/run.sh\n`)
  put('CLAUDE.md', `The task notes are in ${H}/notes/\n`)
  put('ask-walnut-launch.json', JSON.stringify({ cwd: H }))
  put('plugins/p1/manifest.json', JSON.stringify({ data: `${H}/plugin-data/p1` }))
  put('plugin-data/p1/state.json', JSON.stringify({ cache: `${H}/plugin-data/p1/cache` }))
  put('plugin-files/p1/index.json', JSON.stringify({ file: `${H}/plugin-files/p1/a.txt` }))
  put('plugin-registry.json', JSON.stringify({ catalogs: [{ url: `file://${H}/plugin-files/catalog.json` }] }))
  // Host places and records.
  put('hosts/devbox.json', JSON.stringify({ probed: { home: `${A}` }, observed: { repoPaths: { x: { path: `${A}/code/x` } } } }))
  put('subagent-runs.json', JSON.stringify([{ dirs: [{ host: null, dir: `${A}/.local/state/open-walnut/sub/1` }], sessionCwd: `${A}/code/proj` }]))
  put('notes/watch.md', `The repo lives at ${A}/code/proj.\n`)
  put('memory/daily/2026-11-22.md', `Edited ${H}/config.yaml\n`)
  put('chat-history.json', JSON.stringify({ messages: [{ content: [{ type: 'image', path: `${A}/.cache/open-walnut/images/i.png` }] }] }))
  // Machine data: never in a batch.
  put('local/home.json', JSON.stringify({ home: H, formerHomes: [`${A}/.open-walnut-former`] }))
  closeTaskDb()
  closeSessionDb()
  _setLedgerFileForTesting(null)
}

beforeAll(async () => {
  other = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-home-path-ratchet-b-'))
  newHome = path.join(other, 'b', 'home')
  await seed()
  const roots = pathRoots({ fromHome: WALNUT_HOME, toHome: newHome, fromAccount: OLD_ACCOUNT, toAccount: NEW_ACCOUNT })
  before = scanHomePaths(WALNUT_HOME, roots, { hitsPerPlace: 1000 })
  const standby = path.join(other, 'b', 'standby')
  const batch = await snapshotTo(WALNUT_HOME, standby)
  if (!batch.ok) throw new Error(`the standby batch failed: ${batch.reason}`)
  await verifyStandby(standby)
  await promoteCopy({
    switchId: 'ratchet', standbyDir: standby, home: newHome, previousHome: WALNUT_HOME, reverseStandbyDir: `${OLD_ACCOUNT}/standby`,
    previousAccountHome: OLD_ACCOUNT, accountHome: NEW_ACCOUNT,
  })
  after = scanHomePaths(newHome, roots, { hitsPerPlace: 1000 })
}, 120_000)

afterAll(() => {
  if (other) fs.rmSync(other, { recursive: true, force: true })
})

const show = (hits: PathHit[]) => hits.map((h) => `${h.file} ${h.at} ${h.path}`)

describe('old-machine paths in a promoted home', () => {
  it('the synthetic home holds paths under both roots', () => {
    expect(before.hits.filter((h) => h.root === 'home').length).toBeGreaterThan(5)
    expect(before.hits.filter((h) => h.root === 'account').length).toBeGreaterThan(5)
  })

  it('every hit of the old home is decided: none unknown (a store nobody decided about)', () => {
    expect(show(judgePathHits(before.hits, rules).unknown)).toEqual([])
  })

  it('after the promotion, nothing is left that the promotion rewrites, and nothing undecided', () => {
    const j = judgePathHits(after.hits, rules)
    expect(show(j.notRewritten.map((x) => x.hit))).toEqual([])
    expect(show(j.unknown)).toEqual([])
    // The trial's own check (which skips what is kept) agrees.
    expect(leftoverPaths(newHome, pathRoots({ fromHome: WALNUT_HOME, toHome: newHome, fromAccount: OLD_ACCOUNT, toAccount: NEW_ACCOUNT }), rules).problems).toEqual([])
  })

  it('machine data does not travel: its hits are only in the old home', () => {
    expect(before.hits.some((h) => h.file === 'local/home.json')).toBe(true)
    expect(after.hits.some((h) => h.file === 'local/home.json')).toBe(false)
    // What the promotion itself writes there (promoted.json names the old home) is this machine's.
    expect(judgePathHits(after.hits.filter((h) => h.file.startsWith('local/')), rules).kept.every((k) => k.rule === 'manifest-machine')).toBe(true)
  })

  it('every rule is met, and every store of a rewrite rule (a rule nothing needs fails)', () => {
    const met = new Map<string, Set<string>>()
    for (const h of [...before.hits, ...after.hits]) {
      const r = ruleFor(rules, h)
      if (!r) continue
      const store = classifyHomePath(h.file)?.id ?? ''
      met.set(r.id, (met.get(r.id) ?? new Set()).add(store))
    }
    expect(rules.filter((r) => !met.has(r.id)).map((r) => r.id)).toEqual([])
    const missing = rules.filter((r) => r.rule === 'rewrite').flatMap((r) => r.stores.filter((s) => !met.get(r.id)!.has(s)).map((s) => `${r.id}: ${s}`))
    expect(missing).toEqual([])
  })

  it('the rewrites land where they should', () => {
    const cfg = fs.readFileSync(path.join(newHome, 'config.yaml'), 'utf8')
    expect(cfg).toContain(`${NEW_ACCOUNT}/models/ggml-base.bin`)
    expect(cfg).toContain(`${newHome}/secrets/apns.p8`)
    expect(cfg).toContain(`dir: ${OLD_ACCOUNT}/standby`)
    // Host-keyed and leader_switch places are kept.
    expect(cfg).toContain(`${OLD_ACCOUNT}/proxy-logs`)
    expect(cfg).toContain(`home: ${WALNUT_HOME}`)
    const tdb = new Database(path.join(newHome, 'tasks', 'tasks.sqlite'), { readonly: true })
    const cwd = (id: string) => (JSON.parse((tdb.prepare('SELECT payload FROM tasks WHERE id = ?').get(id) as { payload: string }).payload) as { cwd?: string }).cwd
    try {
      expect(cwd(taskIds[1]!)).toBe(newHome)
      expect(cwd(taskIds[0]!)).toBe(`${OLD_ACCOUNT}/code/proj`)
    } finally { tdb.close() }
    const cron = JSON.parse(fs.readFileSync(path.join(newHome, 'cron-jobs.json'), 'utf8'))
    expect(cron.jobs[0].check).toEqual({ run: `bash ${newHome}/triggers/t1/check.sh`, cwd: `${OLD_ACCOUNT}/code/proj` })
    expect(fs.readFileSync(path.join(newHome, 'triggers/t1/check.sh'), 'utf8')).toBe(`#!/bin/sh\ncat ${newHome}/notes/watch.md\ncd ${OLD_ACCOUNT}/code/proj\n`)
    const ledger = new Database(path.join(newHome, 'cache', 'applied-ops.sqlite'), { readonly: true })
    try {
      expect((ledger.prepare('SELECT home FROM applied_ops ORDER BY op_id').all() as { home: string }[]).map((r) => r.home)).toEqual([newHome, `${OLD_ACCOUNT}/.open-walnut-former`])
    } finally { ledger.close() }
    // Records are as they were.
    expect(fs.readFileSync(path.join(newHome, 'notes/watch.md'), 'utf8')).toBe(`The repo lives at ${OLD_ACCOUNT}/code/proj.\n`)
  })

  it('every leader-data store of the manifest is decided: in a rule, or known to hold no path', () => {
    const lead = homeEntries().filter((e) => e.class === 'leader-data').map((e) => e.id)
    const inRules = new Set(rules.flatMap((r) => r.stores))
    expect(lead.filter((id) => !inRules.has(id) && !(id in NO_PATH_STORES))).toEqual([])
    const known = new Set(lead)
    expect([...inRules, ...Object.keys(NO_PATH_STORES)].filter((id) => !known.has(id))).toEqual([])
    expect(Object.keys(NO_PATH_STORES).filter((id) => inRules.has(id))).toEqual([])
  })

  it('the ledger rule is the one the tests-only skip turns into a keep', () => {
    expect(homePathRules({ skipLedgerRewrite: true }).find((r) => r.id === LEDGER_RULE)?.rule).toBe('keep')
  })
})
