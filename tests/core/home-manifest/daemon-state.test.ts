/**
 * The daemon's places in the data home (HomeEntry.daemonState, docs/reference/data-locations.md
 * "Daemon state"):
 *
 *   - a ratchet over the daemon (daemon-standalone.ts and its area modules): every path it
 *     names in the data home (`<HOME>/.open-walnut/...`, by a literal join or through the constants
 *     an installed daemon's tmp/ state hangs off) is named by the manifest and is either marked
 *     daemon state or rebuildable. The manifest's own source ratchet only sees joins under
 *     WALNUT_HOME, which the daemon never uses; this covers that side. A new place turns it red.
 *   - the mark changes nothing in backups or the standby copy (they never read it).
 *   - the check of a handed-over home (home-kept.ts) holds leader data and machine data to the
 *     byte and skips, and lists, the rebuildable and daemon state changes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyHomePath, homeEntries, homePathClass, isUnnamedHomePath } from '../../../src/core/home-manifest/index.js'
import { compareKept, describeKept, snapshotHome } from '../../../src/core/home-manifest/home-kept.js'
import { backupTakes } from '../../../src/core/backup/scan.js'
import { makeFileClass } from '../../../src/core/standby/scan.js'
import { daemonRuntimeText } from '../../helpers/daemon-runtime-text.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

/** Data home paths a daemon names that are neither daemon state nor rebuildable, each with why. */
const NAMED_ELSEWHERE: Record<string, string> = {
  // daemon-skills.ts "2b. v2.0 migration": it removes a SKILL.md an older daemon put in the
  // user's skill store, only when that file carries the daemon's own marker; it writes nothing there.
  'skills/walnut': 'a one-time removal of the file an older daemon wrote there',
}

/** Where a definition starts (`const X =` / `var X =`) to the next top-level statement. */
function definition(src: string, name: string): string {
  const m = new RegExp(`(?:^|\\n)(?:const|var|let) ${name}\\s*=`).exec(src)
  if (!m) return ''
  const rest = src.slice(m.index + m[0].length)
  const end = rest.search(/\n(?:const|var|let|function|async function|export) /)
  return end < 0 ? rest : rest.slice(0, end)
}

const HOME_JOIN = /path\.join\(\s*(?:HOME_DIR|daemonEnv\.HOME \|\| HOME_DIR|process\.env\.HOME \|\| HOME_DIR)\s*,\s*'\.open-walnut'((?:\s*,\s*'[^']*')*)/g
const segments = (args: string) => [...args.matchAll(/'([^']*)'/g)].map((m) => m[1]!)

/** Every data home path a daemon source names, relative to the home ('' = the home itself). */
function daemonHomePaths(src: string): Set<string> {
  const out = new Set<string>()
  for (const m of src.matchAll(HOME_JOIN)) out.add(segments(m[1] ?? '').join('/'))
  // Constants that are the tmp/ root itself, and constants built on them (JOURNAL_ROOT): their joins.
  const roots = new Set<string>()
  for (const m of src.matchAll(/(?:const|var) (\w+) = path\.join\(HOME_DIR, '\.open-walnut', 'tmp'\)/g)) roots.add(m[1]!)
  for (const r of [...roots]) for (const m of src.matchAll(new RegExp(`(?:const|var) (\\w+) = [^\\n]*\\b${r}\\b`, 'g'))) roots.add(m[1]!)
  for (const r of roots) for (const m of src.matchAll(new RegExp(`path\\.join\\(${r},\\s*'([^']+)'`, 'g'))) out.add(`tmp/${m[1]}`)
  // A sibling of a constant whose installed value is a data home place (BUDGET_DIR beside
  // RESUME_RECORD_DIR in tmp/, the CLI-owner records beside SPAWN_JOURNAL in local/).
  for (const m of src.matchAll(/path\.join\(path\.dirname\((\w+)\),\s*'([^']+)'\)/g)) {
    const at = /'\.open-walnut'((?:\s*,\s*'[^']*')+)/.exec(definition(src, m[1]!))
    if (at) out.add([...segments(at[1]!).slice(0, -1), m[2]!].join('/'))
  }
  return out
}

/** The paths that break the rule, with why. */
function unclassified(paths: Iterable<string>): string[] {
  const bad: string[] = []
  for (const rel of paths) {
    // The whole home (a deny list of roots, a cleanup's protected roots) and the tmp/ root: not a place.
    if (rel === '' || rel === 'tmp') continue
    if (NAMED_ELSEWHERE[rel]) continue
    const entry = classifyHomePath(rel)
    if (!entry || isUnnamedHomePath(rel)) { bad.push(`${rel}: no manifest entry names it`); continue }
    if (entry.class !== 'rebuildable' && !entry.daemonState) bad.push(`${rel}: ${entry.id} is ${entry.class}, not marked daemon state`)
  }
  return bad
}

describe('the daemon\'s places in the data home', () => {
  // The whole runtime: daemon-standalone.ts and its area modules (skills.sync is daemon-skills.ts).
  const found = daemonHomePaths(daemonRuntimeText())

  it('finds the places an installed daemon keeps (the extractor sees literal joins and the tmp/ constants)', () => {
    for (const p of ['tmp/streams', 'tmp/offline-host', 'tmp/leader', 'tmp/usage-budgets', 'tmp/host-vitals', 'local/spawn-journal.jsonl', 'local/cli-owners', 'distributed-skills', 'tmp/host-server']) expect(found, p).toContain(p)
  })

  it('every one of them is named, and is daemon state or rebuildable', () => {
    expect(unclassified(found)).toEqual([])
  })

  it('turns red on a new place a daemon names that is neither (the control)', () => {
    const src = [
      "const X = path.join(HOME_DIR, '.open-walnut', 'tmp', 'brand-new-state')",
      "const JOURNAL_PROD_STATE_DIR = path.join(HOME_DIR, '.open-walnut', 'tmp')",
      'const JOURNAL_ROOT = JOURNAL_TEST_DIR || JOURNAL_PROD_STATE_DIR',
      "const NEW_BOOK = path.join(JOURNAL_ROOT, 'brand-new-book')",
      "const Y = path.join(daemonEnv.HOME || HOME_DIR, '.open-walnut', 'notes')",
    ].join('\n')
    const bad = unclassified(daemonHomePaths(src))
    expect(bad.some((b) => b.startsWith('tmp/brand-new-state'))).toBe(true)
    expect(bad.some((b) => b.startsWith('tmp/brand-new-book'))).toBe(true)
    expect(bad.some((b) => b.startsWith('notes:'))).toBe(true)
  })

  it('marks only machine and rebuildable places, never leader data', () => {
    const marked = homeEntries().filter((e) => e.daemonState)
    expect(marked.length).toBeGreaterThan(0)
    for (const e of marked) expect(['machine', 'rebuildable'], e.id).toContain(e.class)
  })

  it('marks every tmp/ place the daemon names (a promotion leaves each where it is, so none may be missed)', () => {
    const missing = [...found].filter((rel) => rel.startsWith('tmp/')).map((rel) => classifyHomePath(rel)).filter((e) => e && !e.daemonState).map((e) => e!.id)
    expect(missing).toEqual([])
  })
})

describe('the mark changes nothing in backups or the standby copy', () => {
  const marked = homeEntries().filter((e) => e.daemonState)

  it('backups take each place as they did (tmp/ never, the spawn journal as a file)', () => {
    for (const e of marked) {
      const inside = e.kind === 'dir' ? `${e.path}/x.json` : e.path
      expect(backupTakes(inside), e.id).toBe(e.path.startsWith('tmp/') ? null : 'raw')
    }
  })

  it('the standby copy leaves each out, by its class (machine or rebuildable)', () => {
    const fileClass = makeFileClass()
    for (const e of marked) {
      const rel = e.kind === 'dir' ? `${e.path}/x.json` : e.path
      expect(homePathClass(rel), e.id).toBe(e.class)
      expect(fileClass(path.posix.dirname(rel), path.posix.basename(rel)), e.id).toBe(e.class)
    }
  })

  it('neither reads the mark', () => {
    for (const dir of ['src/core/backup', 'src/core/standby']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]) {
        if (!f.endsWith('.ts')) continue
        expect(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'), `${dir}/${f}`).not.toContain('daemonState')
      }
    }
  })
})

describe('a handed-over home kept as it was (home-kept.ts)', () => {
  let home = ''
  afterEach(() => { if (home) fs.rmSync(home, { recursive: true, force: true }) })

  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
    fs.writeFileSync(path.join(home, rel), text)
  }

  it('holds leader data and machine data to the byte, skips rebuildable and daemon state, and lists what it skipped', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-kept-'))
    write('tasks/x.json', '{}')
    write('local/leader-switch/handed-over.json', '{"state":"handed-over"}')
    write('tmp/host-vitals/2026-01-01.jsonl', 'a\n')
    write('tmp/host-server/server-1.pid', '1')
    const before = await snapshotHome(home)
    expect((await compareKept(before, await snapshotHome(home))).ok).toBe(true)

    write('tmp/host-vitals/2026-01-01.jsonl', 'a\nb\n')
    write('tmp/offline-host/spawn-template-hf-1.json', '{}')
    write('tmp/host-server/server-1.pid', '2')
    const skipped = compareKept(before, await snapshotHome(home))
    expect(skipped.ok).toBe(true)
    expect(skipped.skipped.daemonState.map((c) => `${c.how} ${c.path}`)).toEqual(['changed tmp/host-vitals/2026-01-01.jsonl', 'added tmp/offline-host/', 'added tmp/offline-host/spawn-template-hf-1.json'])
    expect(skipped.skipped.rebuildable.map((c) => c.path)).toEqual(['tmp/host-server/server-1.pid'])
    expect(describeKept(skipped)).toMatch(/^0 kept path\(s\) changed; skipped as daemon state: changed tmp\/host-vitals/)

    // Leader data (a change, an addition), machine data (a removal): each breaks it.
    write('tasks/x.json', '{"a":1}')
    write('notes/new.md', '# new')
    fs.rmSync(path.join(home, 'local/leader-switch/handed-over.json'))
    const broken = compareKept(before, await snapshotHome(home))
    expect(broken.ok).toBe(false)
    expect(broken.changed).toEqual(expect.arrayContaining([
      { path: 'tasks/x.json', cls: 'leader-data', how: 'changed' },
      { path: 'notes/new.md', cls: 'leader-data', how: 'added' },
      { path: 'local/leader-switch/handed-over.json', cls: 'machine', how: 'removed' },
    ]))
    expect(describeKept(broken)).toMatch(/kept path\(s\) changed: .*changed tasks\/x\.json \(leader-data\)/)
  })
})
