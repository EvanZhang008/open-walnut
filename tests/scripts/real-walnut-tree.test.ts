import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashUntrackedFiles } from '../helpers/real-walnut.js'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'real-walnut-tree-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }) })
const hash = (entries: string[]) => {
  const key = crypto.createHash('sha256')
  const files = hashUntrackedFiles(key, root, entries)
  return { files, digest: key.digest('hex') }
}
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const untracked = () => git('ls-files', '-o', '--exclude-standard', '-z').split('\0').filter(Boolean)

/** Independent enumeration: every newly added directory member becomes an expectation. */
function members(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = path.join(prefix, entry.name)
    return entry.isDirectory() ? members(path.join(dir, entry.name), name) : [name]
  }).sort()
}

describe('real compiled file tree hashing', () => {
  it('expands a directory entry through git and hashes every new non-ignored member', () => {
    const nested = path.join(root, 'nested')
    fs.mkdirSync(nested)
    fs.writeFileSync(path.join(nested, 'package.json'), '{"name":"fixture"}\n')
    fs.mkdirSync(path.join(nested, 'src'))
    fs.writeFileSync(path.join(nested, 'src', 'main.ts'), 'export const value = 1\n')
    fs.mkdirSync(path.join(nested, 'empty'))
    fs.symlinkSync('src', path.join(nested, 'source-link'))
    const before = hash(['nested/'])
    expect(before.files).toEqual(members(nested, 'nested'))
    fs.mkdirSync(path.join(nested, 'new', 'deeper'), { recursive: true })
    fs.writeFileSync(path.join(nested, 'new', 'deeper', 'added.ts'), 'export const added = true\n')
    const after = hash(['nested/'])
    expect(after.files).toEqual(members(nested, 'nested'))
    expect(after.files).toContain('nested/new/deeper/added.ts')
    expect(after.digest).not.toBe(before.digest)
    // Expanded file entries and overlapping directory entries describe the same tree.
    expect(hash([...after.files, 'nested/'])).toEqual(after)
  })

  it('does not read ignored secrets, dependencies or build output when expanding directories', () => {
    fs.mkdirSync(path.join(root, 'app'))
    fs.writeFileSync(path.join(root, 'app', '.gitignore'), '.env\nnode_modules/\nbuild/\n')
    fs.writeFileSync(path.join(root, 'app', 'entry.ts'), 'export const entry = true\n')
    fs.writeFileSync(path.join(root, 'app', '.env'), 'fixture-secret')
    for (const dir of ['node_modules', 'build']) {
      fs.mkdirSync(path.join(root, 'app', dir))
      fs.writeFileSync(path.join(root, 'app', dir, 'ignored.txt'), 'ignored')
    }
    const read = vi.spyOn(fs, 'readFileSync')
    const enumerate = vi.spyOn(fs, 'readdirSync')
    const result = hash(['app/'])
    expect(result.files).toEqual(['app/.gitignore', 'app/entry.ts'])
    expect(read.mock.calls.map(([file]) => file)).toEqual(result.files.map((file) => path.join(root, file)))
    expect(enumerate).not.toHaveBeenCalled()
    read.mockRestore()
    fs.writeFileSync(path.join(root, 'app', '.env'), 'changed-secret')
    expect(hash(['app/'])).toEqual(result)
  })

  it('refuses a real git nested-repository entry without reading its metadata or ignored files', () => {
    const nested = path.join(root, 'nested')
    fs.mkdirSync(nested)
    execFileSync('git', ['init', '-q'], { cwd: nested })
    fs.writeFileSync(path.join(nested, '.gitignore'), '.env\nnode_modules/\nbuild/\n')
    fs.writeFileSync(path.join(nested, '.env'), 'fixture-secret')
    fs.writeFileSync(path.join(nested, 'entry.ts'), 'export const entry = true\n')
    fs.mkdirSync(path.join(nested, 'node_modules'))
    fs.mkdirSync(path.join(nested, 'build'))
    expect(untracked()).toEqual(['nested/'])
    const read = vi.spyOn(fs, 'readFileSync')
    const enumerate = vi.spyOn(fs, 'readdirSync')
    expect(() => hash(untracked())).toThrow('cannot hash untracked repository directory: nested/')
    expect(read).not.toHaveBeenCalled()
    expect(enumerate).not.toHaveBeenCalled()
  })

  it('hashes file bytes and symlink targets, without following directory or broken links', () => {
    fs.writeFileSync(path.join(root, 'entry.ts'), 'first')
    fs.mkdirSync(path.join(root, 'folder'))
    fs.symlinkSync('folder', path.join(root, 'link'))
    fs.symlinkSync('missing', path.join(root, 'broken'))
    const key = crypto.createHash('sha256')
      .update('broken').update('missing').update('entry.ts').update('first').update('link').update('folder')
    expect(hash(['link', 'entry.ts', 'broken'])).toEqual({ files: ['broken', 'entry.ts', 'link'], digest: key.digest('hex') })
    const before = hash(['entry.ts']).digest
    fs.writeFileSync(path.join(root, 'entry.ts'), 'second')
    expect(hash(['entry.ts']).digest).not.toBe(before)
    const linkBefore = hash(['link']).digest
    fs.unlinkSync(path.join(root, 'link'))
    fs.symlinkSync('another-missing', path.join(root, 'link'))
    expect(hash(['link']).digest).not.toBe(linkBefore)
  })

  it('keeps tests and docs out of the build hash but includes them in the clone file list', () => {
    for (const dir of ['tests', 'docs']) {
      fs.mkdirSync(path.join(root, dir))
      fs.writeFileSync(path.join(root, dir, 'fixture.txt'), 'first')
    }
    const before = hash(['tests/', 'docs/'])
    expect(before.files).toEqual(members(root).filter((file) => !file.startsWith('.git/')))
    fs.writeFileSync(path.join(root, 'tests', 'new.txt'), 'second')
    fs.writeFileSync(path.join(root, 'docs', 'fixture.txt'), 'changed')
    const after = hash(['tests/', 'docs/'])
    expect(after.files).toEqual(members(root).filter((file) => !file.startsWith('.git/')))
    expect(after.digest).toBe(before.digest)
  })

  it('does not hide a missing file or directory', () => {
    expect(() => hash(['gone.ts'])).toThrow(/ENOENT/)
    expect(() => hash(['gone/'])).toThrow(/ENOENT/)
  })

  it('refuses a partial git enumeration even when a permission warning exits zero', () => {
    fs.mkdirSync(path.join(root, 'private'))
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    const standIn = path.join(bin, 'git')
    fs.writeFileSync(standIn, '#!/bin/sh\nprintf "%s\\n" "warning: permission denied" >&2\nexit 0\n', { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`)
    expect(() => hash(['private/'])).toThrow(/cannot enumerate untracked directory private\/.*permission denied/)
    fs.writeFileSync(standIn, '#!/bin/sh\nprintf "%s\\n" "git enumeration failed" >&2\nexit 1\n', { mode: 0o755 })
    expect(() => hash(['private/'])).toThrow(/git enumeration failed/)
  })

  it('propagates permission errors from directory access and file reads', () => {
    fs.mkdirSync(path.join(root, 'private'))
    fs.writeFileSync(path.join(root, 'locked.ts'), 'private')
    // Inject EACCES so the contract is also enforced under privileged CI users.
    // All other filesystem calls are real; no root-owned file or chmod is needed.
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const access = vi.spyOn(fs, 'accessSync').mockImplementation(() => { throw denied })
    expect(() => hash(['private/'])).toThrow(denied)
    access.mockRestore()
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw denied })
    expect(() => hash(['locked.ts'])).toThrow(denied)
  })
})
