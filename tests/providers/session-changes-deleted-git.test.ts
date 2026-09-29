/**
 * A deleted file's old content comes from `git show HEAD:<rel>`, which costs two
 * git spawns per file. Only a file with a `.git` above it can be in git, so a
 * delete outside every repo must answer without spawning anything.
 *
 * Why: a long session deletes hundreds of scratch files in /tmp; on 2026-09-29
 * each compute of one 907 MB transcript spawned git ~800 times (about 2.5 s),
 * nearly all of it for files no repo could hold.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const spawned = vi.hoisted(() => ({ argv: [] as string[][] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const execFile = ((file: string, args: string[], ...rest: unknown[]) => {
    spawned.argv.push([file, ...args])
    return (real.execFile as (...a: unknown[]) => unknown)(file, args, ...rest)
  }) as typeof real.execFile
  return { ...real, default: { ...real, execFile }, execFile }
})

const { computeHostLocalChanges, encodeProjectPathCore } = await import('../../src/providers/session-changes-core.js')

const SID = 'deleted-git-sid'
let root = ''
let claudeHome = ''

const rmLine = (cwd: string, file: string) => JSON.stringify({
  type: 'assistant', cwd,
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `cd ${cwd} && rm ${file}` } }] },
}) + '\n'

function transcriptFor(cwd: string, body: string): void {
  const dir = path.join(claudeHome, 'projects', encodeProjectPathCore(cwd))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), body)
}

function hasGitAbove(dir: string): boolean {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, '.git'))) return true
  return false
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-del-')))
  claudeHome = path.join(root, 'claude')
  spawned.argv = []
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('a deleted file asks git only when a repo can hold it', () => {
  it('recovers a committed file from HEAD', async () => {
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo)
    execFileSync('git', ['-C', repo, 'init', '-q'])
    fs.writeFileSync(path.join(repo, 'gone.ts'), 'export const dead = 1;\n')
    execFileSync('git', ['-C', repo, 'add', '.'])
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    fs.rmSync(path.join(repo, 'gone.ts'))
    transcriptFor(repo, rmLine(repo, 'gone.ts'))

    const out = await computeHostLocalChanges({ sessionId: SID, cwd: repo, claudeHome })
    const change = out!.result.groups.flatMap((g) => g.files).find((f) => f.relPath === 'gone.ts')
    expect(change).toMatchObject({ status: 'deleted', before: 'export const dead = 1;\n', after: '', partial: false })
    expect(spawned.argv.some((a) => a[0] === 'git' && a[1] === 'show')).toBe(true)
  })

  it('spawns nothing for a delete outside every repo, and still reports it', async () => {
    const scratch = path.join(root, 'scratch')
    fs.mkdirSync(scratch)
    expect(hasGitAbove(scratch)).toBe(false) // precondition: the temp dir is not inside a repo
    transcriptFor(scratch, rmLine(scratch, 'a.txt') + rmLine(scratch, 'b.txt'))

    const out = await computeHostLocalChanges({ sessionId: SID, cwd: scratch, claudeHome })
    const files = out!.result.groups.flatMap((g) => g.files)
    expect(files.map((f) => [f.relPath, f.status, f.before, f.partial]).sort()).toEqual([
      ['a.txt', 'deleted', '', true],
      ['b.txt', 'deleted', '', true],
    ])
    expect(spawned.argv).toEqual([])
  })
})
