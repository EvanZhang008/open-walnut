/**
 * One repo reached through a symlink by two spellings is one repo on the Changed page
 * (2026-11-11: a session working in a symlinked home wrote files as /home/u/repo/... and
 * as /local/home/u/repo/..., and the web and iOS Changed pages showed the repo twice).
 * Grouping keys on the root's real path, and one file written through both spellings is
 * one file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { computeHostLocalChanges, encodeProjectPathCore } from '../../src/providers/session-changes-core.js'

const SID = 'symlink-spellings-sid'
let root = ''
let claudeHome = ''

const write = (cwd: string, file: string, content: string, id: string) => JSON.stringify({
  type: 'assistant', cwd,
  message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content } }] },
}) + '\n'
const edit = (cwd: string, file: string, oldString: string, newString: string, id: string) => JSON.stringify({
  type: 'assistant', cwd,
  message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: oldString, new_string: newString } }] },
}) + '\n'

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-symlink-')))
  claudeHome = path.join(root, 'claude')
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('a repo reached by two spellings', () => {
  it('is one group, and a file written through both spellings is one file', async () => {
    // real/home/repo is the repo; link -> real, so link/home/repo is the same folder.
    const realRepo = path.join(root, 'real', 'home', 'repo')
    fs.mkdirSync(path.join(realRepo, 'src'), { recursive: true })
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
    const linkRepo = path.join(root, 'link', 'home', 'repo')
    execFileSync('git', ['-C', realRepo, 'init', '-q'])
    fs.writeFileSync(path.join(realRepo, 'src', 'shared.ts'), 'export const a = 1\n')
    execFileSync('git', ['-C', realRepo, 'add', '.'])
    execFileSync('git', ['-C', realRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    // What the session's tools did on disk.
    fs.writeFileSync(path.join(realRepo, 'one.ts'), 'one\n')
    fs.writeFileSync(path.join(realRepo, 'two.ts'), 'two\n')
    fs.writeFileSync(path.join(realRepo, 'src', 'shared.ts'), 'export const a = 2\nexport const b = 3\n')

    const dir = path.join(claudeHome, 'projects', encodeProjectPathCore(linkRepo))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), [
      write(linkRepo, path.join(linkRepo, 'one.ts'), 'one\n', 'w1'),
      write(linkRepo, path.join(realRepo, 'two.ts'), 'two\n', 'w2'),
      edit(linkRepo, path.join(linkRepo, 'src', 'shared.ts'), 'a = 1', 'a = 2', 'e1'),
      edit(linkRepo, path.join(realRepo, 'src', 'shared.ts'), 'a = 2\n', 'a = 2\nexport const b = 3\n', 'e2'),
    ].join(''))

    const out = await computeHostLocalChanges({ sessionId: SID, cwd: linkRepo, claudeHome })
    const groups = out!.result.groups
    expect(groups).toHaveLength(1)
    // The session's own spelling of its repo, so it is still the session's repo.
    expect(groups[0]).toMatchObject({ repoRoot: linkRepo, label: 'repo', kind: 'cwd' })
    expect(groups[0].files.map((f) => f.relPath)).toEqual(['one.ts', 'src/shared.ts', 'two.ts'])
    const shared = groups[0].files.find((f) => f.relPath === 'src/shared.ts')!
    // Both edits, in order, on one file: before is the file at the start, not halfway.
    expect(shared).toMatchObject({ status: 'modified', before: 'export const a = 1\n', partial: false })
    expect(out!.result.fileCount).toBe(3)
  })
})
