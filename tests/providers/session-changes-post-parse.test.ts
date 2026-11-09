/**
 * The post-parse phase of computeHostLocalChanges (current contents, HEAD
 * content, reconstruction, grouping) never holds the daemon's event loop, and a
 * recompute after a small append redoes only the files that changed.
 *
 * Why (2026-11-08): one live session with 711 changed files took 18 to 21 s on
 * EVERY recompute, even when the resumed parse read 200 KB, and the daemon's
 * loop starved meanwhile: a session start waited 17 s behind it and the
 * server's websocket to the daemon dropped. Every file a shell command rewrote
 * in place cost two git spawns (rev-parse + show), and every file was read and
 * reconstructed again on every compute.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  computeHostLocalChanges,
  encodeProjectPathCore,
  type HostLocalChangesMemo,
  type MainParseState,
} from '../../src/providers/session-changes-core.js'

const SID = 'post-parse-sid'
let root = ''
let repo = ''
let claudeHome = ''
let transcript = ''

const line = (o: unknown) => JSON.stringify(o) + '\n'
const tool = (name: string, input: Record<string, unknown>) =>
  line({ type: 'assistant', cwd: repo, message: { content: [{ type: 'tool_use', name, input }] } })
const fileOf = (i: number) => path.join(repo, 'src', `f${i}.ts`)
const body = (i: number) => Array.from({ length: 60 }, (_, k) => `line ${k} of file ${i}`).join('\n') + '\n'
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo })

/**
 * `n` committed files, each edited twice by Edit and once in place by a shell
 * command (so its `before` comes from HEAD), with the disk matching the ops.
 */
function buildSession(n: number): void {
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  for (let i = 0; i < n; i++) fs.writeFileSync(fileOf(i), body(i))
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init')
  let t = line({ type: 'user', cwd: repo, message: { role: 'user', content: 'go' } })
  for (let i = 0; i < n; i++) {
    t += tool('Edit', { file_path: fileOf(i), old_string: 'line 3 of', new_string: 'LINE 3 of' })
    t += tool('Edit', { file_path: fileOf(i), old_string: 'line 7 of', new_string: 'LINE 7 of' })
    t += tool('Bash', { command: `sed -i.bak 's/line 9 of/LINE 9 of/' ${fileOf(i)}` })
    fs.writeFileSync(fileOf(i), body(i).replace('line 3 of', 'LINE 3 of').replace('line 7 of', 'LINE 7 of').replace('line 9 of', 'LINE 9 of'))
  }
  fs.writeFileSync(transcript, t)
}

/** Largest gap between ticks of a 10 ms interval while `work` runs. */
async function largestLoopGap<T>(work: () => Promise<T>): Promise<{ value: T; gapMs: number }> {
  let last = performance.now()
  let gapMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    gapMs = Math.max(gapMs, now - last)
    last = now
  }, 10)
  try {
    const value = await work()
    gapMs = Math.max(gapMs, performance.now() - last)
    return { value, gapMs }
  } finally {
    clearInterval(timer)
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-post-')))
  repo = path.join(root, 'repo')
  claudeHome = path.join(root, 'claude')
  fs.mkdirSync(repo, { recursive: true })
  const projectDir = path.join(claudeHome, 'projects', encodeProjectPathCore(repo))
  fs.mkdirSync(projectDir, { recursive: true })
  transcript = path.join(projectDir, `${SID}.jsonl`)
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('changes compute keeps the event loop free', () => {
  it('700 files rewritten in place: few git spawns, no long hold of the loop', async () => {
    buildSession(700)
    const { value: out, gapMs } = await largestLoopGap(() =>
      computeHostLocalChanges({ sessionId: SID, cwd: repo, claudeHome }))
    expect(out!.result.fileCount).toBe(700)
    const f5 = out!.result.groups.flatMap((g) => g.files).find((f) => f.relPath === 'src/f5.ts')!
    expect(f5).toMatchObject({ before: body(5), status: 'modified', partial: true })
    // Per repo: a toplevel lookup, a HEAD lookup, then two cat-file runs per
    // 500 files. It was two spawns per file (1,400 here).
    expect(out!.computeStats.gitSpawns).toBeLessThanOrEqual(8)
    // Measured 47 ms under vitest on a Mac at load ~100 (the old code: 2,001 ms).
    // 500 leaves room for GC pauses and timer drift on a heavily loaded machine.
    expect(gapMs).toBeLessThan(500)
  }, 120_000)
})

describe('a recompute redoes only what changed', () => {
  const N = 40
  let holder: { state?: MainParseState }
  let memo: HostLocalChangesMemo | undefined
  const compute = async () => {
    const out = await computeHostLocalChanges({ sessionId: SID, cwd: repo, claudeHome, mainParse: holder, changesMemo: memo })
    memo = out!.changesMemo
    return out!
  }
  /** A compute with no state at all: the answer every memoized compute must equal. */
  const fresh = async () => (await computeHostLocalChanges({ sessionId: SID, cwd: repo, claudeHome }))!.result

  beforeEach(() => { holder = {}; memo = undefined })

  it('reuses unchanged files after an append, a disk edit and a commit, with the same answer', async () => {
    buildSession(N)
    const first = await compute()
    expect(first.computeStats).toMatchObject({ files: N, reconstructed: N, reused: 0 })
    expect(first.result).toEqual(await fresh())

    // Nothing changed: nothing is read again, and git is asked only for HEAD.
    const idle = await compute()
    expect(idle.computeStats).toMatchObject({ reconstructed: 0, reused: N })
    expect(idle.computeStats.gitSpawns).toBeLessThanOrEqual(1)
    expect(idle.result).toEqual(first.result)

    // The session edits one file: only that file is rebuilt.
    fs.appendFileSync(transcript, tool('Edit', { file_path: fileOf(3), old_string: 'line 11 of', new_string: 'LINE 11 of' }))
    fs.writeFileSync(fileOf(3), fs.readFileSync(fileOf(3), 'utf8').replace('line 11 of', 'LINE 11 of'))
    const appended = await compute()
    expect(appended.parseStats.resumed).toBe(true)
    expect(appended.computeStats).toMatchObject({ reconstructed: 1, reused: N - 1 })
    expect(appended.result).toEqual(await fresh())

    // Someone else edits a file on disk (no new op): its stat changed, so it is read again.
    fs.writeFileSync(fileOf(7), fs.readFileSync(fileOf(7), 'utf8') + 'tail\n')
    const touched = await compute()
    expect(touched.computeStats).toMatchObject({ reconstructed: 1, reused: N - 1 })
    expect(touched.result).toEqual(await fresh())

    // A commit moves HEAD: files whose `before` comes from HEAD read it again.
    git('add', 'src/f1.ts', 'src/f2.ts'); git('commit', '-qm', 'two')
    const committed = await compute()
    expect(committed.computeStats.reconstructed).toBe(2)
    expect(committed.result).toEqual(await fresh())
    const f1 = committed.result.groups.flatMap((g) => g.files).find((f) => f.relPath === 'src/f1.ts')!
    expect(f1.before).toBe(f1.after) // HEAD now holds what the session wrote
  }, 120_000)

  it('a memo handed back is never changed by the compute that reads it', async () => {
    buildSession(5)
    const first = await compute()
    const kept = first.changesMemo
    const snapshot = [...kept.files.entries()].map(([k, v]) => [k, v.sig, v.change && { ...v.change }])
    fs.appendFileSync(transcript, tool('Write', { file_path: fileOf(0), content: 'new\n' }))
    fs.writeFileSync(fileOf(0), 'new\n')
    const second = await compute()
    expect(second.changesMemo).not.toBe(kept)
    expect([...kept.files.entries()].map(([k, v]) => [k, v.sig, v.change && { ...v.change }])).toEqual(snapshot)
    // Grouping rewrites relPath on the change it lists, never on the memo's.
    for (const v of second.changesMemo.files.values()) expect(v.change!.relPath).toBe(v.change!.filePath)
  }, 60_000)
})
