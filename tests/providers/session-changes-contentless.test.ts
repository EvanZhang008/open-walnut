/**
 * The Changed view reads a file's content only when it can show it.
 *
 * On 2026-09-30 every compute of one live session read a 676 MB SQLite file the
 * session had copied into /tmp, as a UTF-8 string, then dropped it for being
 * outside every repo: 1.3 GB of daemon heap and 2-3 s on every warm. An
 * out-of-repo or excluded file is now never read, and a file too large or binary
 * to diff as text is listed without content.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  computeHostLocalChanges,
  encodeProjectPathCore,
  MAX_CONTENT_BYTES,
} from '../../src/providers/session-changes-core.js'

const SID = 'contentless-sid'
let root = ''
let claudeHome = ''
let repo = ''
let scratch = ''

const toolLine = (cwd: string, name: string, input: Record<string, unknown>) => JSON.stringify({
  type: 'assistant', cwd,
  message: { content: [{ type: 'tool_use', name, input }] },
}) + '\n'

function transcript(body: string): void {
  const dir = path.join(claudeHome, 'projects', encodeProjectPathCore(repo))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), body)
}

function readPaths(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c) => String(c[0]))
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-contentless-')))
  claudeHome = path.join(root, 'claude')
  repo = path.join(root, 'repo')
  scratch = path.join(root, 'scratch')
  fs.mkdirSync(repo)
  fs.mkdirSync(scratch)
  execFileSync('git', ['-C', repo, 'init', '-q'])
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('changes read only what they can show', () => {
  it('never reads a file outside every repo and outside the session cwd', async () => {
    fs.writeFileSync(path.join(scratch, 'copy.sqlite'), Buffer.alloc(64 * 1024, 7))
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n')
    transcript(
      toolLine(repo, 'Bash', { command: `cp ${repo}/db.sqlite ${scratch}/copy.sqlite` })
      + toolLine(repo, 'Edit', { file_path: path.join(repo, 'a.ts'), old_string: 'a = 1', new_string: 'a = 2' }),
    )
    const spy = vi.spyOn(fsp, 'readFile')

    const out = await computeHostLocalChanges({ sessionId: SID, cwd: repo, claudeHome })

    expect(out!.result.groups.flatMap((g) => g.files).map((f) => [f.relPath, f.before, f.after])).toEqual([
      ['a.ts', 'export const a = 1;\n', 'export const a = 2;\n'],
    ])
    expect(readPaths(spy).filter((p) => p.startsWith(scratch))).toEqual([])
  })

  it('never reads an excluded path', async () => {
    const plan = path.join(repo, '.claude', 'plans', 'p.md')
    fs.mkdirSync(path.dirname(plan), { recursive: true })
    fs.writeFileSync(plan, '# plan\n')
    transcript(toolLine(repo, 'Write', { file_path: plan, content: '# plan\n' }))
    const spy = vi.spyOn(fsp, 'readFile')

    const out = await computeHostLocalChanges({ sessionId: SID, cwd: repo, claudeHome })

    expect(out!.result.fileCount).toBe(0)
    expect(readPaths(spy).filter((p) => p === plan)).toEqual([])
  })

  it('lists a binary file in the repo without its content', async () => {
    const bin = path.join(repo, 'icon.png')
    fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a, 0x0a]))
    transcript(toolLine(repo, 'Bash', { command: `cd ${repo} && cp /somewhere/icon.png icon.png` }))

    const out = await computeHostLocalChanges({ sessionId: SID, cwd: repo, claudeHome })

    expect(out!.result.groups.flatMap((g) => g.files)).toEqual([
      { filePath: bin, relPath: 'icon.png', before: '', after: '', status: 'added', ops: 1, partial: true },
    ])
  })

  it('lists a file past the size cap without reading it, and keeps its status', async () => {
    const big = path.join(repo, 'dump.json')
    const fd = fs.openSync(big, 'w')
    fs.ftruncateSync(fd, MAX_CONTENT_BYTES + 1)
    fs.closeSync(fd)
    transcript(toolLine(repo, 'Edit', { file_path: big, old_string: '"x": 1', new_string: '"x": 2' }))
    const spy = vi.spyOn(fsp, 'readFile')

    const out = await computeHostLocalChanges({ sessionId: SID, cwd: repo, claudeHome })

    expect(out!.result.groups.flatMap((g) => g.files)).toEqual([
      { filePath: big, relPath: 'dump.json', before: '', after: '', status: 'modified', ops: 1, partial: true },
    ])
    expect(readPaths(spy).filter((p) => p === big)).toEqual([])
  })

  it('still reconstructs a scratch file under the session cwd outside any repo', async () => {
    fs.writeFileSync(path.join(scratch, 'notes.txt'), 'two\n')
    const dir = path.join(claudeHome, 'projects', encodeProjectPathCore(scratch))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`),
      toolLine(scratch, 'Edit', { file_path: path.join(scratch, 'notes.txt'), old_string: 'one', new_string: 'two' }))

    const out = await computeHostLocalChanges({ sessionId: SID, cwd: scratch, claudeHome })

    expect(out!.result.groups.flatMap((g) => g.files).map((f) => [f.relPath, f.before, f.after, f.partial])).toEqual([
      ['notes.txt', 'one\n', 'two\n', false],
    ])
  })
})
