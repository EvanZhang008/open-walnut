/**
 * Every kind of leader data has a stated answer to "this changed after the batch's moment, or
 * while the batch read it" (src/core/standby/change-rules.ts). A new manifest entry, or a new
 * kind of entry, fails here until its answer is written down.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { homeEntries, isAppendOnlyHomePath } from '../../../src/core/home-manifest/index.js'
import type { DataKind } from '../../../src/core/home-manifest/index.js'
import { CHANGE_RULES, LEADER_DIRS, changeRuleOf, isObjectStoreDir, manifestEntryRules } from '../../../src/core/standby/change-rules.js'
import { scanHome } from '../../../src/core/standby/scan.js'
import { stageFile } from '../../../src/core/standby/stage.js'
import fs from 'node:fs'
import path from 'node:path'
import { sandbox, write, type Sandbox } from './helpers.js'

let sb: Sandbox | null = null
afterEach(async () => { await sb?.cleanup(); sb = null })

const leaderEntries = () => homeEntries().filter((e) => e.class === 'leader-data')
const SHA1 = 'a'.repeat(38)

describe('change rules', () => {
  it('every leader-data entry of the manifest has a rule for changes during a batch', () => {
    const missing = leaderEntries().filter((e) => !manifestEntryRules(e)?.length).map((e) => `${e.id} (${e.kind}, ${e.path ?? String(e.match)})`)
    expect(missing, 'add the entry to LEADER_DIRS in src/core/standby/change-rules.ts, with what writes its files').toEqual([])
    for (const e of leaderEntries()) for (const rule of manifestEntryRules(e)!) expect(CHANGE_RULES[rule], `${e.id}: ${rule}`).toBeTruthy()
  })

  it('names no dir the manifest does not have, and only leader-data dirs', () => {
    const dirs = new Set(leaderEntries().filter((e) => e.kind === 'dir').map((e) => e.id))
    expect(Object.keys(LEADER_DIRS).filter((id) => !dirs.has(id))).toEqual([])
  })

  it('knows every kind of entry the manifest has', () => {
    const kinds: Record<DataKind, true> = { file: true, dir: true, sqlite: true }
    for (const e of homeEntries()) expect(kinds[e.kind], `${e.id}: kind ${e.kind}`).toBe(true)
  })

  it('places each kind of file by its rule', () => {
    const appendOnly = leaderEntries().find((e) => e.appendOnly && e.path)!.path!
    expect(isAppendOnlyHomePath(appendOnly)).toBe(true)
    const cases: Array<[string, { db: boolean; appendOnly: boolean }, string]> = [
      ['tasks/tasks.sqlite', { db: true, appendOnly: false }, 'snapshot'],
      [appendOnly, { db: false, appendOnly: true }, 'prefix'],
      [`.git/objects/ab/${SHA1}`, { db: false, appendOnly: false }, 'content-addressed'],
      [`.git/objects/ab/${'b'.repeat(62)}`, { db: false, appendOnly: false }, 'content-addressed'],
      [`.git/objects/pack/pack-${'c'.repeat(40)}.pack`, { db: false, appendOnly: false }, 'content-addressed'],
      [`.git/objects/pack/pack-${'c'.repeat(40)}.idx`, { db: false, appendOnly: false }, 'content-addressed'],
      ['.git/index.lock', { db: false, appendOnly: false }, 'not-copied'],
      ['.git/refs/heads/main.lock', { db: false, appendOnly: false }, 'not-copied'],
      ['.git/objects/ab/tmp_obj_Xy12', { db: false, appendOnly: false }, 'not-copied'],
      ['.git/objects/pack/tmp_pack_Xy12', { db: false, appendOnly: false }, 'not-copied'],
      ['.git/gc.pid', { db: false, appendOnly: false }, 'not-copied'],
      ['.git/index', { db: false, appendOnly: false }, 'quiet-through-moment'],
      ['.git/refs/heads/main', { db: false, appendOnly: false }, 'quiet-through-moment'],
      ['.git/objects/pack/multi-pack-index', { db: false, appendOnly: false }, 'quiet-through-moment'],
      [`.git/objects/pack/pack-${'c'.repeat(40)}.keep`, { db: false, appendOnly: false }, 'quiet-through-moment'],
      ['notes/a.md', { db: false, appendOnly: false }, 'quiet-through-moment'],
      // Outside the data repo nothing is a git object, whatever its name.
      [`notes/objects/ab/${SHA1}`, { db: false, appendOnly: false }, 'quiet-through-moment'],
      ['notes/x.lock', { db: false, appendOnly: false }, 'quiet-through-moment'],
    ]
    for (const [rel, o, rule] of cases) expect(changeRuleOf(rel, o), rel).toBe(rule)
    expect(['.git/objects', '.git/objects/ab', '.git/objects/pack'].every(isObjectStoreDir)).toBe(true)
    expect(['.git', '.git/refs/heads', '.git/objects/info', 'notes/objects/ab'].some(isObjectStoreDir)).toBe(false)
  })

  it('a batch\'s walk never takes a git command\'s scratch', async () => {
    sb = await sandbox('rules-scan')
    for (const rel of ['.git/HEAD', '.git/index', `.git/objects/ab/${SHA1}`, '.git/refs/heads/main', 'notes/x.lock']) write(sb.home, rel, 'kept\n')
    for (const rel of ['.git/index.lock', '.git/refs/heads/main.lock', '.git/objects/ab/tmp_obj_1', '.git/objects/pack/tmp_pack_1', '.git/objects/incoming-x1/ab/c', '.git/objects/tmp_objdir-incoming-x2/d', '.git/gc.pid']) write(sb.home, rel, 'scratch\n')
    const got = [...(await scanHome(sb.home)).files.keys()].sort()
    expect(got).toEqual(['.git/HEAD', '.git/index', `.git/objects/ab/${SHA1}`, '.git/refs/heads/main', 'notes/x.lock'])
  })

  it('a git object touched while it is read is taken (its name fixes its content); any other file touched so is not', async () => {
    sb = await sandbox('rules-freshen')
    const obj = `.git/objects/ab/${SHA1}`
    for (const rel of [obj, 'notes/a.md']) write(sb.home, rel, 'same bytes\n')
    await new Promise((r) => setTimeout(r, 30))
    const touch = (rel: string) => { const now = new Date(); fs.utimesSync(path.join(sb!.home, rel), now, now) }
    const ctx = (moment: number) => ({ home: sb!.home, momentMs: moment, afterCopy: touch })
    const sink = () => {}
    const now = Date.now() + 1000
    expect((await stageFile(obj, ctx(now), sink)).ok).toBe(true)
    expect(await stageFile('notes/a.md', ctx(now), sink)).toMatchObject({ ok: false, why: 'changed' })
    // A git object whose ctime is past the clock is still taken; a plain file is late.
    touch(obj)
    touch('notes/a.md')
    const past = Date.now() - 10_000
    expect((await stageFile(obj, { home: sb.home, momentMs: past }, sink)).ok).toBe(true)
    expect(await stageFile('notes/a.md', { home: sb.home, momentMs: past }, sink)).toMatchObject({ ok: false, why: 'late' })
  })
})
