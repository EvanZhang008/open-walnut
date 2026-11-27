/**
 * The engine records of the sessions in the data home, carried beside the standby copy (src/core/leader/switch/
 * session-carry.ts) by real standby batches: what a batch takes from a fake Claude Code dir (the selected folders'
 * transcripts, sidecars, memory and the sessions' task lists; never a neighbour folder, settings or credentials),
 * what the promotion asks of the mark (target-job.ts carryRefusal), the final batch that fails the stop when the
 * records do not go (final-stop.ts), and the placement into the new folder name after the commit.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { snapshotTo, HOME_PLACE } from '../../../../src/core/standby/index.js'
import { removeTree, carryTargetDir } from '../../../../src/core/standby/target-files.js'
import { carryBehindLine, carryPlace, carrySelection, carrySize, carrySource, engineFolderUnder, homeEngineFolder, placeCarriedRecords, type PlaceDeps } from '../../../../src/core/leader/switch/session-carry.js'
import { carryRefusal } from '../../../../src/core/leader/switch/target-job.js'
import { finishSwitchStop, forgetHandedOver } from '../../../../src/core/leader/switch/final-stop.js'
import { finalMarkName } from '../../../../src/core/leader/switch/ticket.js'
import { PROMOTE_TRIAL_MS } from '../../../../src/core/leader/switch/catch-up.js'
import type { SwitchPeer } from '../../../../src/core/leader/switch/peer.js'
import type { BatchOutcome } from '../../../../src/core/standby/index.js'
import type { SessionRecord } from '../../../../src/core/types.js'

const tmp: string[] = []
afterEach(async () => { forgetHandedOver(); for (const d of tmp.splice(0)) await removeTree(d) })
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-')); tmp.push(d); return fs.realpathSync(d) }
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const rec = (n: number, cwd: string, extra: Partial<SessionRecord> = {}) => ({ claudeSessionId: sid(n), cwd, process_status: 'stopped', ...extra }) as SessionRecord

/** A fake Claude Code dir with the home's folder, a folder under it, a neighbour and everything that must stay. */
function engineDir(root: string, home: string) {
  const eng = path.join(root, 'claude')
  const f = homeEngineFolder(home)!
  const sub = engineFolderUnder(f, 'notes')
  write(path.join(eng, 'projects', f, `${sid(1)}.jsonl`), '{"t":1}\n{"t":2}\n')
  write(path.join(eng, 'projects', f, sid(1), 'subagents', 'agent-x.jsonl'), '{"s":1}\n')
  write(path.join(eng, 'projects', f, sid(1), 'tool-results', 'r1.txt'), 'big result')
  write(path.join(eng, 'projects', f, 'memory', 'MEMORY.md'), '# folder memory\n')
  write(path.join(eng, 'projects', f, `${sid(9)}.jsonl`), '{"archived":1}\n')
  write(path.join(eng, 'projects', sub, `${sid(2)}.jsonl`), '{"n":1}\n')
  // A neighbour whose name only starts the same (/x/home-c), and what is no session's record.
  write(path.join(eng, 'projects', `${f}-c`, `${sid(3)}.jsonl`), 'neighbour\n')
  write(path.join(eng, 'projects', f, 'not-a-session.txt'), 'x')
  write(path.join(eng, '.credentials.json'), '{"token":"fake"}')
  write(path.join(eng, 'settings.json'), '{}')
  write(path.join(eng, 'file-history', sid(1), 'h1'), 'checkpoint')
  write(path.join(eng, 'session-env', sid(1), 'env'), 'x')
  write(path.join(eng, 'tasks', sid(1), '1.json'), '{"subject":"a task"}')
  write(path.join(eng, 'tasks', sid(3), '1.json'), '{"subject":"neighbour task"}')
  return { eng, f, sub }
}

function listCopy(target: string): string[] {
  const copy = path.join(target, 'copy')
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else out.push(r)
    }
  }
  if (fs.existsSync(copy)) walk(copy, '')
  return out.sort()
}

describe('a carry batch', () => {
  it('takes the selected folders\' records and the sessions\' task lists, nothing else of the engine\'s dir', async () => {
    const root = dir()
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true })
    const { eng, f, sub } = engineDir(root, home)
    const sel = carrySelection([rec(1, home), rec(2, path.join(home, 'notes')), rec(9, home, { archived: true }), rec(3, `${home}-c`), rec(4, home, { engine: 'codex' } as never)], home)
    expect([...sel.folders].sort()).toEqual([f, sub].sort())
    expect([...sel.sids].sort()).toEqual([sid(1), sid(2), sid(9)])
    const target = path.join(root, 'standby', 'carry')
    const out = await snapshotTo(eng, target, { place: carryPlace(sel), stagingDir: path.join(root, 'staging') })
    expect(out.ok).toBe(true)
    expect(listCopy(target)).toEqual([
      `projects/${f}/${sid(1)}.jsonl`,
      `projects/${f}/${sid(1)}/subagents/agent-x.jsonl`,
      `projects/${f}/${sid(1)}/tool-results/r1.txt`,
      `projects/${f}/${sid(9)}.jsonl`,
      `projects/${f}/memory/MEMORY.md`,
      `projects/${sub}/${sid(2)}.jsonl`,
      `tasks/${sid(1)}/1.json`,
    ].sort())
    // Transcripts and subagent transcripts are append-only (taken up to their last whole line); nothing else is.
    const place = carryPlace(sel)
    expect(place.appendOnly(`projects/${f}/${sid(1)}.jsonl`)).toBe(true)
    expect(place.appendOnly(`projects/${f}/${sid(1)}/subagents/agent-x.jsonl`)).toBe(true)
    expect(place.appendOnly(`projects/${f}/memory/MEMORY.md`)).toBe(false)
    expect(place.appendOnly(`tasks/${sid(1)}/1.json`)).toBe(false)
  })

  it('the size a refusal names counts what a batch takes, asynchronously, and stops at its file cap', async () => {
    const root = dir()
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true })
    const { eng, f } = engineDir(root, home)
    // Many small subagent files under one session, as a real home keeps.
    for (let i = 0; i < 300; i++) write(path.join(eng, 'projects', f, sid(1), 'subagents', `agent-${i}.jsonl`), '{"s":1}\n')
    const sel = carrySelection([rec(1, home), rec(2, path.join(home, 'notes')), rec(9, home, { archived: true })], home)
    const target = path.join(root, 'standby', 'carry')
    expect((await snapshotTo(eng, target, { place: carryPlace(sel), stagingDir: path.join(root, 'staging') })).ok).toBe(true)
    const taken = listCopy(target)
    const bytes = taken.reduce((n, r) => n + fs.statSync(path.join(eng, r)).size, 0)
    const pending = carrySize(eng, sel)
    expect(pending).toBeInstanceOf(Promise)
    expect(await pending).toEqual({ bytes, files: taken.length })
    const capped = await carrySize(eng, sel, { maxFiles: 100 })
    expect(capped).toMatchObject({ files: 100, capped: true })
    expect(carryBehindLine({ size: capped, state: {}, rate: 0 })).toMatch(/at least \d+ MB in more than 100 files/)
  })

  it('a session the history archive compressed is carried as it is: its .jsonl.gz, its manifest and its sidecar', async () => {
    const root = dir()
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const { eng, f } = engineDir(root, home)
    write(path.join(eng, 'projects', f, `${sid(5)}.jsonl.gz`), 'gz')
    write(path.join(eng, 'projects', f, `${sid(5)}.walnut-archive.json`), '{"version":1}')
    write(path.join(eng, 'projects', f, sid(5), 'subagents', 'agent-y.jsonl.gz'), 'gz')
    // Archive temps and another session's names are not taken.
    write(path.join(eng, 'projects', f, `${sid(5)}.jsonl.walnut-orig`), 'aside')
    write(path.join(eng, 'projects', f, 'x.jsonl.gz'), 'not a session')
    const sel = carrySelection([rec(5, home)], home)
    const target = path.join(root, 'standby', 'carry')
    expect((await snapshotTo(eng, target, { place: carryPlace(sel), stagingDir: path.join(root, 'staging') })).ok).toBe(true)
    const taken = listCopy(target).filter((r) => r.includes(sid(5)))
    expect(taken).toEqual([
      `projects/${f}/${sid(5)}.jsonl.gz`,
      `projects/${f}/${sid(5)}.walnut-archive.json`,
      `projects/${f}/${sid(5)}/subagents/agent-y.jsonl.gz`,
    ])
    expect(listCopy(target)).not.toContain(`projects/${f}/x.jsonl.gz`)
    expect(carryPlace(sel).appendOnly(`projects/${f}/${sid(5)}.jsonl.gz`)).toBe(false)
  })

  it('a folder under the home that links out of it is not selected: another project\'s records are never carried', async () => {
    const root = dir()
    const home = path.join(root, 'home')
    const outside = path.join(root, 'work', 'x')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.symlinkSync(outside, path.join(home, 'x'))
    const sel = carrySelection([rec(1, home), rec(2, path.join(home, 'x'))], home)
    expect([...sel.folders]).toEqual([homeEngineFolder(home)])
    expect([...sel.sids]).toEqual([sid(1)])
  })

  it('with no place given a batch walks the home exactly as before (HOME_PLACE is the default)', async () => {
    const root = dir()
    const home = path.join(root, 'home')
    write(path.join(home, 'config.yaml'), 'theme: dark\n')
    write(path.join(home, 'memory', 'MEMORY.md'), '# m\n')
    write(path.join(home, 'conversations', 'main', 'history.jsonl'), '{"a":1}\n')
    write(path.join(home, 'tmp', 'streams', 's.jsonl'), 'machine\n')
    write(path.join(home, 'search.sqlite'), 'no')
    const a = await snapshotTo(home, path.join(root, 'a'))
    const b = await snapshotTo(home, path.join(root, 'b'), { place: HOME_PLACE })
    expect(a.ok && b.ok).toBe(true)
    expect(listCopy(path.join(root, 'a'))).toEqual(listCopy(path.join(root, 'b')))
    expect(listCopy(path.join(root, 'a'))).toEqual(['config.yaml', 'conversations/main/history.jsonl', 'memory/MEMORY.md'])
  })

  it('an engine that keeps no dir here carries an empty folder, so the mark still names a batch', async () => {
    const root = dir()
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const src = await carrySource(home, { records: [rec(1, home)], engineDir: path.join(root, 'no-claude') })
    expect(src.root).toBe(path.join(home, 'tmp', 'standby-carry-empty'))
    const out = await snapshotTo(src.root, path.join(root, 'standby', 'carry'), { place: src.place, stagingDir: src.stagingDir })
    expect(out.ok).toBe(true)
  })
})

describe('the promotion asks the mark', () => {
  it('refuses a mark that names no records, a carry that is not there, and one at another batch', async () => {
    const root = dir()
    const standby = path.join(root, 'standby')
    expect(await carryRefusal(standby, undefined)).toMatch(/names no batch of the sessions' records/)
    expect(await carryRefusal(standby, { batch: 1, homeFolder: '-x' })).toMatch(/holds no records batch/)
    const eng = path.join(root, 'claude')
    write(path.join(eng, 'projects', '-x', `${sid(1)}.jsonl`), '{}\n')
    const place = carryPlace({ folders: new Set(['-x']), sids: new Set([sid(1)]) })
    const out = await snapshotTo(eng, carryTargetDir(standby), { place, stagingDir: path.join(root, 'staging') })
    if (!out.ok) throw new Error(out.reason)
    expect(await carryRefusal(standby, { batch: out.commit.batch, homeFolder: '-x' })).toBeNull()
    expect(await carryRefusal(standby, { batch: out.commit.batch + 1, homeFolder: '-x' })).toMatch(/names batch \d+ .* last one is batch \d+/)
  })
})

function peer(o: { carry: 'ok' | 'fails' | 'changes' }, files: Map<string, unknown>): SwitchPeer {
  const ok = (batch: number, unchanged: boolean): BatchOutcome => ({ ok: true, manifest: {} as never, commit: { batch, unchanged, written: unchanged ? 0 : 1, deleted: 0 } as never, stats: {} as never })
  let carries = 0
  return {
    kind: 'local', machine: { id: 'machine-b', home: '/x/b', standbyDir: '/x/b/standby', port: 1 } as never, standbyDir: '/x/b/standby',
    batch: async () => ok(5, true),
    verify: async () => ({ drift: 0 }),
    carryBatch: async () => {
      carries++
      if (o.carry === 'fails') return { ok: false, reason: 'the engine dir could not be read', stats: {} as never }
      if (o.carry === 'changes') return ok(100 + carries, false)
      return ok(7, carries > 1)
    },
    carryVerify: async () => ({ drift: 0 }),
    ready: async () => null,
    writeFile: async (n, v) => { files.set(n, v) },
    readFile: async () => null,
    startTargetJob: async () => ({ ok: true }),
    hold: async () => {},
    unhold: () => {},
    close: () => {},
  } as SwitchPeer
}

describe('the switch stop\'s final batch of the records', () => {
  const carry = { source: async () => ({ root: '/x', place: HOME_PLACE, stagingDir: '/x' }), homeFolder: '-old-home' }
  const run = async (kind: 'ok' | 'fails' | 'changes', windowMs = 60_000) => {
    const home = dir()
    const files = new Map<string, unknown>()
    const r = await finishSwitchStop({ home, sw: { switchId: 'S1', to: 'machine-b', peer: peer({ carry: kind }, files), commitDeadline: Date.now() + PROMOTE_TRIAL_MS + windowMs, phase: 'stopping' }, stoppedAt: new Date().toISOString(), signal: new AbortController().signal, carry, log: () => {} })
    return { r, mark: files.get(finalMarkName('S1')) as Record<string, unknown> | undefined }
  }

  it('names the records\' batch in the mark', async () => {
    const { r, mark } = await run('ok')
    expect(r.ok).toBe(true)
    expect(mark).toMatchObject({ batch: 5, carry: { batch: 7, homeFolder: '-old-home' } })
  })

  it('writes no mark when the records do not go (the switch rolls back)', async () => {
    const { r, mark } = await run('fails', 300)
    expect(r.ok).toBe(false)
    expect(r.why).toMatch(/sessions' records .* did not finish/)
    expect(mark).toBeUndefined()
  })

  it('writes no mark when the records keep changing past the deadline', async () => {
    const { r, mark } = await run('changes', 300)
    expect(r.ok).toBe(false)
    expect(mark).toBeUndefined()
  })
})

describe('after the commit: the records into the new folder', () => {
  function setup() {
    const root = dir()
    const oldHome = path.join(root, 'old', 'home')
    const newHome = path.join(root, 'new', 'home')
    fs.mkdirSync(path.join(newHome, 'notes'), { recursive: true })
    const fromF = homeEngineFolder(oldHome)!
    const standby = path.join(root, 'standby')
    const copy = path.join(carryTargetDir(standby), 'copy')
    write(path.join(copy, 'projects', fromF, `${sid(1)}.jsonl`), '{"t":1}\n{"t":2}\n')
    write(path.join(copy, 'projects', fromF, sid(1), 'subagents', 'a.jsonl'), '{"s":1}\n')
    write(path.join(copy, 'projects', fromF, 'memory', 'MEMORY.md'), '# carried\n')
    write(path.join(copy, 'projects', engineFolderUnder(fromF, 'notes'), `${sid(2)}.jsonl`), '{"n":1}\n')
    write(path.join(copy, 'tasks', sid(1), '1.json'), '{}')
    // The copy is read-only on disk.
    const ro = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { ro(p); fs.chmodSync(p, 0o500) } else fs.chmodSync(p, 0o400) } }
    ro(copy)
    const eng = path.join(root, 'claude-b')
    const moved = (n: number, cwd: string, rel: string, extra: object = {}) => rec(n, cwd, { leaderSwitch: { switchId: 'S1', plan: 'move', from: { machine: 'a', home: oldHome, cwd: path.join(oldHome, rel) }, rel, stopped: 'idle', at: '', moved: { machine: 'b', home: newHome, cwd, at: '', records: 'pending' }, ...extra } } as never)
    const rows = new Map<string, SessionRecord>([
      [sid(1), moved(1, newHome, '', { supervised: true })],
      [sid(2), moved(2, path.join(newHome, 'notes'), 'notes')],
    ])
    const calls: string[] = []
    const deps: PlaceDeps = {
      list: async () => [...rows.values()],
      save: async (id, patch) => { rows.set(id, { ...rows.get(id)!, ...patch }) },
      end: async (id, why) => { calls.push(`end ${id} ${why}`) },
      release: async (id) => { calls.push(`release ${id}`) },
      startIdle: async (id) => { calls.push(`start ${id}`) },
      log: () => {},
    }
    return { root, oldHome, newHome, fromF, standby, eng, rows, calls, deps }
  }

  it('places each record under the new folder name, starts a supervised idle session, and removes the carry', async () => {
    const t = setup()
    const r = await placeCarriedRecords({ switchId: 'S1', home: t.newHome, standbyDir: t.standby, homeFolderFrom: t.fromF, engineDir: t.eng, deps: t.deps })
    const toF = homeEngineFolder(t.newHome)!
    expect(r.conflicts).toEqual([])
    expect(r.sessions).toBe(2)
    expect(fs.readFileSync(path.join(t.eng, 'projects', toF, `${sid(1)}.jsonl`), 'utf8')).toBe('{"t":1}\n{"t":2}\n')
    expect(fs.existsSync(path.join(t.eng, 'projects', toF, sid(1), 'subagents', 'a.jsonl'))).toBe(true)
    expect(fs.readFileSync(path.join(t.eng, 'projects', toF, 'memory', 'MEMORY.md'), 'utf8')).toBe('# carried\n')
    expect(fs.existsSync(path.join(t.eng, 'projects', engineFolderUnder(toF, 'notes'), `${sid(2)}.jsonl`))).toBe(true)
    expect(fs.existsSync(path.join(t.eng, 'tasks', sid(1), '1.json'))).toBe(true)
    // The owner may write them (the copy's files were read-only).
    expect(fs.statSync(path.join(t.eng, 'projects', toF, `${sid(1)}.jsonl`)).mode & 0o777).toBe(0o600)
    expect(t.rows.get(sid(1))!.leaderSwitch!.moved!.records).toBe('placed')
    expect(t.calls).toEqual([`release ${sid(1)}`, `start ${sid(1)}`, `release ${sid(2)}`])
    expect(fs.existsSync(carryTargetDir(t.standby))).toBe(false)
    // Done once: a second pass finds nothing pending.
    expect((await placeCarriedRecords({ switchId: 'S1', home: t.newHome, standbyDir: t.standby, homeFolderFrom: t.fromF, engineDir: t.eng, deps: t.deps })).sessions).toBe(0)
  })

  it('takes each session\'s records from the folder the old leader named, and only the moving sessions\' files', async () => {
    const t = setup()
    const toF = homeEngineFolder(t.newHome)!
    // The old leader ran row 2 under another spelling of its folder (its real path): the stamp names that folder.
    const named = '-real-old-home-notes'
    t.rows.set(sid(2), { ...t.rows.get(sid(2))!, leaderSwitch: { ...t.rows.get(sid(2))!.leaderSwitch!, engineFolder: named } })
    const copy = path.join(carryTargetDir(t.standby), 'copy')
    fs.chmodSync(copy, 0o700); fs.chmodSync(path.join(copy, 'projects'), 0o700)
    write(path.join(copy, 'projects', named, `${sid(2)}.jsonl`), '{"named":1}\n')
    // A transcript of a session that does not move, in the home's folder: it stays in the carry.
    fs.chmodSync(path.join(copy, 'projects', t.fromF), 0o700)
    write(path.join(copy, 'projects', t.fromF, `${sid(7)}.jsonl`), '{"other":1}\n')
    const r = await placeCarriedRecords({ switchId: 'S1', home: t.newHome, standbyDir: t.standby, homeFolderFrom: t.fromF, engineDir: t.eng, deps: t.deps })
    expect(r.conflicts).toEqual([])
    expect(fs.readFileSync(path.join(t.eng, 'projects', engineFolderUnder(toF, 'notes'), `${sid(2)}.jsonl`), 'utf8')).toBe('{"named":1}\n')
    expect(fs.existsSync(path.join(t.eng, 'projects', toF, `${sid(7)}.jsonl`))).toBe(false)
  })

  it('an archived session (compressed, or offloaded with only its manifest) is placed as it is and is not missing', async () => {
    const t = setup()
    const toF = homeEngineFolder(t.newHome)!
    const copy = path.join(carryTargetDir(t.standby), 'copy')
    fs.chmodSync(copy, 0o700); fs.chmodSync(path.join(copy, 'projects'), 0o700)
    const notesF = path.join(copy, 'projects', engineFolderUnder(t.fromF, 'notes'))
    fs.chmodSync(notesF, 0o700)
    // Row 2 compressed on the old machine; row 1's folder also holds an offloaded session 3 (manifest only).
    fs.rmSync(path.join(notesF, `${sid(2)}.jsonl`))
    write(path.join(notesF, `${sid(2)}.jsonl.gz`), 'gz')
    write(path.join(notesF, `${sid(2)}.walnut-archive.json`), '{"version":1}')
    fs.chmodSync(path.join(copy, 'projects', t.fromF), 0o700)
    write(path.join(copy, 'projects', t.fromF, `${sid(3)}.walnut-archive.json`), '{"version":1,"remote":{}}')
    t.rows.set(sid(3), { ...t.rows.get(sid(1))!, claudeSessionId: sid(3), leaderSwitch: { ...t.rows.get(sid(1))!.leaderSwitch!, supervised: false } } as SessionRecord)
    const r = await placeCarriedRecords({ switchId: 'S1', home: t.newHome, standbyDir: t.standby, homeFolderFrom: t.fromF, engineDir: t.eng, deps: t.deps })
    expect(r.missing).toEqual([])
    expect(r.conflicts).toEqual([])
    const notesTo = path.join(t.eng, 'projects', engineFolderUnder(toF, 'notes'))
    expect(fs.readFileSync(path.join(notesTo, `${sid(2)}.jsonl.gz`), 'utf8')).toBe('gz')
    expect(fs.existsSync(path.join(notesTo, `${sid(2)}.walnut-archive.json`))).toBe(true)
    expect(fs.existsSync(path.join(t.eng, 'projects', toF, `${sid(3)}.walnut-archive.json`))).toBe(true)
    expect(t.rows.get(sid(2))!.leaderSwitch!.moved!.records).toBe('placed')
    expect(t.rows.get(sid(3))!.leaderSwitch!.moved!.records).toBe('placed')
    expect(fs.existsSync(carryTargetDir(t.standby))).toBe(false)
  })

  it('a transcript the old machine kept but that is not at its new place: the session ends with why, the carry stays', async () => {
    const t = setup()
    const copy = path.join(carryTargetDir(t.standby), 'copy')
    fs.chmodSync(copy, 0o700); fs.chmodSync(path.join(copy, 'projects'), 0o700)
    const notesF = path.join(copy, 'projects', engineFolderUnder(t.fromF, 'notes'))
    fs.chmodSync(notesF, 0o700)
    fs.rmSync(path.join(notesF, `${sid(2)}.jsonl`))
    const r = await placeCarriedRecords({ switchId: 'S1', home: t.newHome, standbyDir: t.standby, homeFolderFrom: t.fromF, engineDir: t.eng, deps: t.deps })
    expect(r.missing).toEqual([sid(2)])
    expect(t.rows.get(sid(2))!.leaderSwitch).toMatchObject({ plan: 'end', moved: { records: 'missing' }, why: expect.stringMatching(/transcript was not among the records carried/) })
    expect(t.calls.some((c) => c.startsWith(`end ${sid(2)}`))).toBe(true)
    expect(t.rows.get(sid(1))!.leaderSwitch!.moved!.records).toBe('placed')
    expect(fs.existsSync(carryTargetDir(t.standby))).toBe(true)
  })

  it('a session the old machine kept no transcript of is placed with none (nothing to look for)', async () => {
    const t = setup()
    t.rows.set(sid(2), { ...t.rows.get(sid(2))!, leaderSwitch: { ...t.rows.get(sid(2))!.leaderSwitch!, transcript: false } })
    const copy = path.join(carryTargetDir(t.standby), 'copy')
    fs.chmodSync(copy, 0o700); fs.chmodSync(path.join(copy, 'projects'), 0o700)
    const notesF = path.join(copy, 'projects', engineFolderUnder(t.fromF, 'notes'))
    fs.chmodSync(notesF, 0o700)
    fs.rmSync(path.join(notesF, `${sid(2)}.jsonl`))
    const r = await placeCarriedRecords({ switchId: 'S1', home: t.newHome, standbyDir: t.standby, homeFolderFrom: t.fromF, engineDir: t.eng, deps: t.deps })
    expect(r.missing).toEqual([])
    expect(t.rows.get(sid(2))!.leaderSwitch!.moved!.records).toBe('placed')
  })

  it('after a round trip the carried memory and task list are the newer: the copy there is set aside, not kept', async () => {
    const t = setup()
    const toF = homeEngineFolder(t.newHome)!
    write(path.join(t.eng, 'projects', toF, 'memory', 'MEMORY.md'), '# older, from before the first switch\n')
    write(path.join(t.eng, 'tasks', sid(1), '1.json'), '{"old":1}')
    const r = await placeCarriedRecords({ switchId: 'S1', home: t.newHome, standbyDir: t.standby, homeFolderFrom: t.fromF, engineDir: t.eng, deps: t.deps })
    expect(fs.readFileSync(path.join(t.eng, 'projects', toF, 'memory', 'MEMORY.md'), 'utf8')).toBe('# carried\n')
    expect(fs.readFileSync(path.join(t.eng, 'projects', toF, 'memory', 'MEMORY.md.before-S1'), 'utf8')).toBe('# older, from before the first switch\n')
    expect(fs.readFileSync(path.join(t.eng, 'tasks', sid(1), '1.json'), 'utf8')).toBe('{}')
    expect(fs.readFileSync(path.join(t.eng, 'tasks', sid(1), '1.json.before-S1'), 'utf8')).toBe('{"old":1}')
    expect(r.setAside).toHaveLength(2)
  })

  it('never overwrites: a prefix left by an earlier switch is set aside, any other transcript there ends the session', async () => {
    const t = setup()
    const toF = homeEngineFolder(t.newHome)!
    write(path.join(t.eng, 'projects', toF, `${sid(1)}.jsonl`), '{"t":1}\n')
    write(path.join(t.eng, 'projects', engineFolderUnder(toF, 'notes'), `${sid(2)}.jsonl`), '{"other":1}\n')
    const r = await placeCarriedRecords({ switchId: 'S1', home: t.newHome, standbyDir: t.standby, homeFolderFrom: t.fromF, engineDir: t.eng, deps: t.deps })
    expect(fs.readFileSync(path.join(t.eng, 'projects', toF, `${sid(1)}.jsonl`), 'utf8')).toBe('{"t":1}\n{"t":2}\n')
    expect(fs.readFileSync(path.join(t.eng, 'projects', toF, `${sid(1)}.jsonl.before-S1`), 'utf8')).toBe('{"t":1}\n')
    expect(r.conflicts.map((c) => c.sid)).toEqual([sid(2)])
    expect(fs.readFileSync(path.join(t.eng, 'projects', engineFolderUnder(toF, 'notes'), `${sid(2)}.jsonl`), 'utf8')).toBe('{"other":1}\n')
    expect(t.rows.get(sid(2))!.leaderSwitch).toMatchObject({ plan: 'end', moved: { records: 'missing' } })
    expect(t.calls.some((c) => c.startsWith(`end ${sid(2)}`))).toBe(true)
    // With a conflict the carry stays (the other record is still readable there).
    expect(fs.existsSync(carryTargetDir(t.standby))).toBe(true)
  })
})
