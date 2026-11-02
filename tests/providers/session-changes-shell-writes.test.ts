/**
 * A file a session rewrote with a shell command (`sed -i`, `>>`, a formatter) is one of
 * the files it changed, with the file at HEAD as its start (2026-11-01: a `sed -i` in a
 * shared checkout was not counted, so a task move left the change behind). A command
 * that changed nothing, or that named a folder, adds no file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { computeHostLocalChanges, encodeProjectPathCore, reconstructFile, type FileOp } from '../../src/providers/session-changes-core.js'

const SID = 'shell-writes-sid'
let root = ''
let claudeHome = ''

const bash = (cwd: string, command: string) => JSON.stringify({
  type: 'assistant', cwd,
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
}) + '\n'
const edit = (cwd: string, file: string, oldString: string, newString: string) => JSON.stringify({
  type: 'assistant', cwd,
  message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: file, old_string: oldString, new_string: newString } }] },
}) + '\n'

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-shell-')))
  claudeHome = path.join(root, 'claude')
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('shell rewrites in place are the session\'s changes', () => {
  it('lists what a shell command changed, from HEAD, and nothing a command left as it was', async () => {
    const repo = path.join(root, 'shared')
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
    execFileSync('git', ['-C', repo, 'init', '-q'])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n')
    fs.writeFileSync(path.join(repo, 'same.txt'), 'unchanged\n')
    fs.writeFileSync(path.join(repo, 'mixed.txt'), 'one\ntwo\n')
    fs.writeFileSync(path.join(repo, 'src', 'x.ts'), 'export const x = 1\n')
    execFileSync('git', ['-C', repo, 'add', '.'])
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    // What the commands did on disk.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'ALPHA\n')
    fs.writeFileSync(path.join(repo, 'mixed.txt'), 'ONE\n2\n')
    fs.writeFileSync(path.join(repo, 'log.txt'), 'appended\n')
    const dir = path.join(claudeHome, 'projects', encodeProjectPathCore(repo))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), [
      bash(repo, "sed -i 's/alpha/ALPHA/' a.txt"),
      bash(repo, "sed -i 's/nothing/here/' same.txt"),
      edit(repo, path.join(repo, 'mixed.txt'), 'two', '2'),
      bash(repo, "perl -pi -e 's/one/ONE/' mixed.txt"),
      bash(repo, 'echo appended >> log.txt'),
      bash(repo, 'npx prettier --write src'),
    ].join(''))

    const out = await computeHostLocalChanges({ sessionId: SID, cwd: repo, claudeHome })
    const files = Object.fromEntries(out!.result.groups.flatMap((g) => g.files).map((f) => [f.relPath, f]))
    expect(Object.keys(files).sort()).toEqual(['a.txt', 'log.txt', 'mixed.txt'])
    expect(files['a.txt']).toMatchObject({ status: 'modified', before: 'alpha\n', after: 'ALPHA\n', partial: true })
    // The Edit before the rewrite cannot be reversed through it: the start is HEAD.
    expect(files['mixed.txt']).toMatchObject({ status: 'modified', before: 'one\ntwo\n', after: 'ONE\n2\n', partial: true })
    expect(files['log.txt']).toMatchObject({ status: 'added', before: '', after: 'appended\n' })
  })
})

describe('reconstructFile across an in-place rewrite', () => {
  const at = (ops: FileOp[]) => ({ filePath: '/r/f.txt', ops })
  it('an older Write or create pins the start exactly; an Edit before the rewrite cannot be reversed', () => {
    expect(reconstructFile('a\nb\n', at([{ kind: 'create' }, { kind: 'modify' }]), 'HEAD\n')).toMatchObject({ before: '', after: 'a\nb\n', status: 'added', partial: false })
    expect(reconstructFile('x2\n', at([{ kind: 'write', content: 'x\n', original: 'orig\n' }, { kind: 'modify' }]), 'HEAD\n')).toMatchObject({ before: 'orig\n', partial: false })
    expect(reconstructFile('x2\n', at([{ kind: 'edit', oldString: 'a', newString: 'x', replaceAll: false }, { kind: 'modify' }]), 'HEAD\n')).toMatchObject({ before: 'HEAD\n', partial: true })
    // An Edit after the rewrite still reverses, then the start is HEAD.
    expect(reconstructFile('one TWO\n', at([{ kind: 'modify' }, { kind: 'edit', oldString: 'two', newString: 'TWO', replaceAll: false }]), 'HEAD\n')).toMatchObject({ before: 'HEAD\n', after: 'one TWO\n', partial: true })
  })
  it('only rewrites: unchanged from HEAD is no change, a phantom is none, a file now gone is listed', () => {
    expect(reconstructFile('same\n', at([{ kind: 'modify' }]), 'same\n')).toMatchObject({ before: 'same\n', after: 'same\n', partial: false })
    expect(reconstructFile(null, at([{ kind: 'modify' }]), null)).toMatchObject({ before: '', after: '', partial: false })
    expect(reconstructFile(null, at([{ kind: 'modify' }]), 'was\n')).toMatchObject({ before: 'was\n', after: '', status: 'deleted', partial: true })
  })
})

describe('a renamed file rewritten in place starts from HEAD at its first name', () => {
  it('git mv then sed -i', async () => {
    const repo = path.join(root, 'r2')
    fs.mkdirSync(repo, { recursive: true })
    execFileSync('git', ['-C', repo, 'init', '-q'])
    fs.writeFileSync(path.join(repo, 'old.txt'), 'first\n')
    execFileSync('git', ['-C', repo, 'add', '.'])
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    execFileSync('git', ['-C', repo, 'mv', 'old.txt', 'new.txt'])
    fs.writeFileSync(path.join(repo, 'new.txt'), 'FIRST\n')
    const dir = path.join(claudeHome, 'projects', encodeProjectPathCore(repo))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), bash(repo, "git mv old.txt new.txt && sed -i 's/first/FIRST/' new.txt"))
    const out = await computeHostLocalChanges({ sessionId: SID, cwd: repo, claudeHome })
    const f = out!.result.groups.flatMap((g) => g.files).find((x) => x.relPath === 'new.txt')
    expect(f).toMatchObject({ status: 'renamed', oldRelPath: 'old.txt', before: 'first\n', after: 'FIRST\n', partial: true })
  })
})
