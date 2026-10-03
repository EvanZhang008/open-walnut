/**
 * The rewind guard's decision (src/providers/turn-guard-core.ts): for files a
 * rewind would restore, did someone else change them after this session last
 * wrote them, and who. Pure facts are faked; the last block runs the real
 * snapshot core against a temp repo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createTurnGuard, turnGuardVerdict, turnGuardOpVerdict,
  type TurnGuardCompare, type TurnGuardCompareFile, type TurnGuardOp,
} from '../../src/providers/turn-guard-core.js'
import { createTurnSnapshots, type TurnSnapshotExecFile, type TurnSnapshotFs } from '../../src/providers/turn-snapshot-core.js'
import { GIT_REPO_REDIRECT_VARS } from '../../src/lib/git-env.js'

const REPO = '/work/repo'

function file(rel: string, snapshot: TurnGuardCompareFile['snapshot'], text: string | null, exists = true): TurnGuardCompareFile {
  return { path: `${REPO}/${rel}`, rel, exists, regular: exists, text, snapshot }
}

function compareOf(files: TurnGuardCompareFile[], stale = false, repoRoot: string | null = REPO): TurnGuardCompare {
  return { repoRoot, snapshotN: repoRoot ? 3 : null, snapshotAt: 1, snapshotStale: stale, files }
}

type Ops = Record<string, TurnGuardOp[]>
function opsMap(ops: Ops): Map<string, { ops: TurnGuardOp[] }> {
  return new Map(Object.entries(ops).map(([p, o]) => [p, { ops: o }]))
}

function guardWith(opts: {
  compare: TurnGuardCompare
  ops: Record<string, Ops>
  roots?: Record<string, string | null>
  realpath?: (p: string) => Promise<string>
  budgetMs?: number
}) {
  const asked: string[] = []
  const g = createTurnGuard({
    compare: async () => opts.compare,
    repoRootOf: async (cwd) => (opts.roots && cwd in opts.roots ? opts.roots[cwd] : REPO),
    sessionOps: async (sid) => { asked.push(sid); return opts.ops[sid] ? opsMap(opts.ops[sid]) : null },
    ...(opts.realpath ? { realpath: opts.realpath } : {}),
    ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}),
  })
  return { g, asked }
}

describe('turn guard: the verdict table', () => {
  it.each([
    // snapshot, stale, transcript → verdict
    ['differs', false, 'same', 'conflict'],
    ['differs', false, 'unknown', 'conflict'],
    ['differs', true, 'differs', 'conflict'],
    ['differs', true, 'same', 'clear'],
    ['differs', true, 'unknown', 'suspect'],
    ['same', false, 'differs', 'suspect'],
    ['same', false, 'same', 'clear'],
    ['same', true, 'unknown', 'clear'],
    ['unknown', false, 'differs', 'conflict'],
    ['unknown', false, 'same', 'clear'],
    ['unknown', false, 'unknown', 'clear'],
  ] as const)('snapshot %s (stale %s), transcript %s: %s', (snap, stale, tx, want) => {
    expect(turnGuardVerdict(snap, stale, tx)).toBe(want)
  })

  it('an op against the current file', () => {
    const f = (text: string | null, exists = true) => ({ path: '/r/a.ts', exists, text })
    expect(turnGuardOpVerdict({ kind: 'write', content: 'a\nb\n' }, f('a\r\nb\r\n'))).toBe('same')
    expect(turnGuardOpVerdict({ kind: 'write', content: 'a\n' }, f('b\n'))).toBe('differs')
    expect(turnGuardOpVerdict({ kind: 'write', content: 'a\n' }, f(null))).toBe('unknown')
    expect(turnGuardOpVerdict({ kind: 'write', content: 'a\n' }, f(null, false))).toBe('differs')
    expect(turnGuardOpVerdict({ kind: 'edit', newString: 'x = 2' }, f('let x = 2\n'))).toBe('same')
    expect(turnGuardOpVerdict({ kind: 'edit', newString: 'x = 2' }, f('let x = 3\n'))).toBe('differs')
    expect(turnGuardOpVerdict({ kind: 'edit', newString: '' }, f('anything'))).toBe('unknown')
    expect(turnGuardOpVerdict({ kind: 'delete' }, f(null, false))).toBe('same')
    expect(turnGuardOpVerdict({ kind: 'delete' }, f('back'))).toBe('differs')
    expect(turnGuardOpVerdict({ kind: 'create' }, f('x'))).toBe('unknown')
    expect(turnGuardOpVerdict({ kind: 'write', content: '{}' }, { path: '/r/n.ipynb', exists: true, text: '{}' })).toBe('unknown')
    expect(turnGuardOpVerdict(null, f('x'))).toBe('unknown')
  })
})

describe('turn guard: who wrote it', () => {
  it('a fresh snapshot that differs is a conflict, named after the sibling whose last op matches', async () => {
    const { g, asked } = guardWith({
      compare: compareOf([file('a.ts', 'differs', 'from B\n'), file('b.ts', 'same', 'mine\n')]),
      ops: {
        A: { [`${REPO}/a.ts`]: [{ kind: 'write', content: 'mine a\n' }], [`${REPO}/b.ts`]: [{ kind: 'write', content: 'mine\n' }] },
        B: { [`${REPO}/a.ts`]: [{ kind: 'write', content: 'old B\n' }, { kind: 'write', content: 'from B\n' }] },
        C: { [`${REPO}/a.ts`]: [{ kind: 'write', content: 'stale C\n' }] },
        OTHER: { [`${REPO}/a.ts`]: [{ kind: 'write', content: 'from B\n' }] },
      },
      roots: { '/elsewhere': '/other/repo' },
    })
    const out = await g.guard({
      sid: 'A', cwd: REPO, files: [`${REPO}/a.ts`, `${REPO}/b.ts`],
      siblings: [
        { sid: 'A', cwd: REPO }, // itself: never a writer
        { sid: 'C', cwd: `${REPO}/sub`, title: 'Session C' },
        { sid: 'B', cwd: REPO, title: 'Session B' },
        { sid: 'OTHER', cwd: '/elsewhere', title: 'Other repo' },
      ],
    })
    expect(out.checked).toBe(true)
    expect(out.conflicts.map((c) => c.rel)).toEqual(['a.ts'])
    expect(out.conflicts[0]).toMatchObject({ verdict: 'conflict', snapshot: 'differs', transcript: 'differs' })
    expect(out.conflicts[0].writers).toEqual([
      { sid: 'B', title: 'Session B', consistent: true },
      { sid: 'C', title: 'Session C', consistent: false },
    ])
    expect(out.files.find((f) => f.rel === 'b.ts')).toMatchObject({ verdict: 'clear', conflict: false, writers: [] })
    // The other repo's session was never parsed.
    expect(asked).toEqual(['A', 'C', 'B'])
  })

  it('a change inside the turn (snapshot same, transcript differs) is a suspect: a conflict only when a sibling wrote exactly that', async () => {
    const formatter = guardWith({
      compare: compareOf([file('a.ts', 'same', 'formatted\n')]),
      ops: { A: { [`${REPO}/a.ts`]: [{ kind: 'write', content: 'unformatted\n' }] } },
    })
    const alone = await formatter.g.guard({ sid: 'A', cwd: REPO, files: [`${REPO}/a.ts`], siblings: [{ sid: 'B', cwd: REPO }] })
    expect(alone.files[0]).toMatchObject({ verdict: 'suspect', conflict: false })
    expect(alone.conflicts).toEqual([])

    const sibling = guardWith({
      compare: compareOf([file('a.ts', 'same', 'from B\n')]),
      ops: {
        A: { [`${REPO}/a.ts`]: [{ kind: 'edit', newString: 'from A' }] },
        B: { [`${REPO}/a.ts`]: [{ kind: 'edit', newString: 'from B' }] },
      },
    })
    const named = await sibling.g.guard({ sid: 'A', cwd: REPO, files: [`${REPO}/a.ts`], siblings: [{ sid: 'B', cwd: REPO, title: 'B' }] })
    expect(named.conflicts).toHaveLength(1)
    expect(named.conflicts[0].writers).toEqual([{ sid: 'B', title: 'B', consistent: true }])
  })

  it('no snapshot: the transcript decides, and nobody to name means "outside this session"', async () => {
    const { g } = guardWith({
      compare: compareOf([file('a.ts', 'unknown', 'hand edit\n'), file('b.ts', 'unknown', 'mine\n')], false, null),
      ops: { A: { [`${REPO}/a.ts`]: [{ kind: 'write', content: 'mine\n' }], [`${REPO}/b.ts`]: [{ kind: 'write', content: 'mine\n' }] } },
    })
    const out = await g.guard({ sid: 'A', cwd: REPO, files: [`${REPO}/a.ts`, `${REPO}/b.ts`], siblings: [{ sid: 'B', cwd: '/not/same' }] })
    expect(out.conflicts.map((c) => [c.rel, c.writers])).toEqual([['a.ts', []]])
  })

  it('a stale snapshot defers to the transcript', async () => {
    const { g } = guardWith({
      compare: compareOf([file('a.ts', 'differs', 'my later turn\n')], true),
      ops: { A: { [`${REPO}/a.ts`]: [{ kind: 'write', content: 'my later turn\n' }] } },
    })
    expect((await g.guard({ sid: 'A', cwd: REPO, files: [`${REPO}/a.ts`] })).conflicts).toEqual([])
  })

  it("a failed tool call never counts as the session's last write", async () => {
    const { g } = guardWith({
      compare: compareOf([file('a.ts', 'unknown', 'mine\n')], false, null),
      ops: { A: { [`${REPO}/a.ts`]: [{ kind: 'write', content: 'mine\n' }, { kind: 'write', content: 'never landed\n', failed: true }] } },
    })
    expect((await g.guard({ sid: 'A', cwd: REPO, files: [`${REPO}/a.ts`] })).files[0]).toMatchObject({ transcript: 'same', verdict: 'clear' })
  })

  it('matches a sibling op recorded under another spelling of the path (/var vs /private/var)', async () => {
    const real = (p: string) => Promise.resolve(p.replace(/^\/var\//, '/private/var/'))
    const g = createTurnGuard({
      compare: async () => ({ repoRoot: '/private/var/r', snapshotN: 1, snapshotAt: 1, snapshotStale: false, files: [
        { path: '/var/r/a.ts', rel: 'a.ts', exists: true, regular: true, text: 'B\n', snapshot: 'differs' },
      ] }),
      repoRootOf: async () => '/private/var/r',
      sessionOps: async (sid) => sid === 'B' ? opsMap({ '/private/var/r/a.ts': [{ kind: 'write', content: 'B\n' }] }) : null,
      realpath: real,
    })
    const out = await g.guard({ sid: 'A', cwd: '/var/r', files: ['/var/r/a.ts'], siblings: [{ sid: 'B', cwd: '/var/r', title: 'B' }] })
    expect(out.conflicts[0].writers).toEqual([{ sid: 'B', title: 'B', consistent: true }])
  })

  it('answers within its budget when a fact never arrives', async () => {
    const g = createTurnGuard({ compare: () => new Promise(() => {}), budgetMs: 200 })
    const t0 = Date.now()
    const out = await g.guard({ sid: 'A', cwd: REPO, files: [`${REPO}/a.ts`] })
    expect(out.checked).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2000)
    const slowSibling = createTurnGuard({
      compare: async () => compareOf([file('a.ts', 'differs', 'x')]),
      repoRootOf: async () => REPO,
      sessionOps: (sid) => sid === 'A' ? Promise.resolve(null) : new Promise(() => {}),
      budgetMs: 300,
    })
    const partial = await slowSibling.guard({ sid: 'A', cwd: REPO, files: [`${REPO}/a.ts`], siblings: [{ sid: 'B', cwd: REPO }, { sid: 'C', cwd: REPO }] })
    expect(partial.checked).toBe(true)
    expect(partial.conflicts.map((c) => c.rel)).toEqual(['a.ts'])
    expect(partial.partial).toBe(true)
  })

  it('ignores relative paths and an empty list', async () => {
    const { g } = guardWith({ compare: compareOf([]), ops: {} })
    expect(await g.guard({ sid: 'A', cwd: REPO, files: ['rel/a.ts', 42] })).toMatchObject({ checked: true, conflicts: [] })
  })
})

describe('turn guard: with real snapshots', () => {
  let ROOT = ''
  const env = () => {
    const e: NodeJS.ProcessEnv = { ...process.env }
    for (const v of GIT_REPO_REDIRECT_VARS) delete e[v]
    e.GIT_CONFIG_NOSYSTEM = '1'
    e.GIT_CONFIG_GLOBAL = path.join(ROOT, 'gitconfig')
    e.GIT_CEILING_DIRECTORIES = path.dirname(ROOT)
    return e
  }
  beforeAll(() => {
    ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-guard-core-')))
    fs.writeFileSync(path.join(ROOT, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.invalid\n')
  })
  afterAll(() => { if (ROOT.startsWith(fs.realpathSync(os.tmpdir()))) fs.rmSync(ROOT, { recursive: true, force: true }) })

  it("names the session that edited the file after this session's last turn", async () => {
    const repo = path.join(ROOT, 'repo')
    fs.mkdirSync(repo)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: env() })
    const target = path.join(repo, 'shared.md')
    const snaps = createTurnSnapshots({
      execFile: execFile as unknown as TurnSnapshotExecFile, fs: fs.promises as unknown as TurnSnapshotFs, path, env: env(),
      tmpDir: ROOT, allowRepo: (r) => r.startsWith(ROOT),
    })
    // Session A writes the file in its turn; the turn-end snapshot records it.
    fs.writeFileSync(target, 'written by A\n')
    expect((await snaps.snapshot('sess-a', repo, 'turn')).status).toBe('created')
    // Session B writes it afterwards.
    fs.writeFileSync(target, 'written by B\n')
    const ops: Record<string, Map<string, { ops: TurnGuardOp[] }>> = {
      'sess-a': opsMap({ [target]: [{ kind: 'write', content: 'written by A\n' }] }),
      'sess-b': opsMap({ [target]: [{ kind: 'write', content: 'written by B\n' }] }),
    }
    const g = createTurnGuard({
      compare: (sid, cwd, files, budget) => snaps.compareToLatest(sid, cwd, files, budget),
      repoRootOf: (cwd) => snaps.repoRootOf(cwd),
      sessionOps: async (sid) => ops[sid] ?? null,
      realpath: (p) => fs.promises.realpath(p),
    })
    const out = await g.guard({ sid: 'sess-a', cwd: repo, files: [target], siblings: [{ sid: 'sess-b', cwd: repo, title: 'Edit the shared notes' }] })
    expect(out).toMatchObject({ checked: true, repoRoot: repo, snapshotN: 1, snapshotStale: false })
    expect(out.conflicts).toHaveLength(1)
    expect(out.conflicts[0]).toMatchObject({ rel: 'shared.md', snapshot: 'differs', transcript: 'differs', verdict: 'conflict' })
    expect(out.conflicts[0].writers).toEqual([{ sid: 'sess-b', title: 'Edit the shared notes', consistent: true }])
    // Back as A left it: nothing to warn about.
    fs.writeFileSync(target, 'written by A\n')
    expect((await g.guard({ sid: 'sess-a', cwd: repo, files: [target] })).conflicts).toEqual([])
  })
})
