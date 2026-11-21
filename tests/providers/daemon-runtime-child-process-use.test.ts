/**
 * The modules the daemon runtime imports start their children with the functions and env their
 * caller hands them (ChildProcessUse, daemon-child-spawn.ts), never node's own and process.env
 * then. A fake execFile records each call and answers at once; nothing real runs.
 * The wiring in daemon-standalone.ts is held by daemon-runtime-child-process-ratchet.test.ts.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { execFile } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { processStart } from '../../src/providers/detached-registry.js'
import { readCronBootId, probeCronProcess } from '../../src/providers/daemon-cron-host.js'
import { defaultPortScanIo } from '../../src/providers/port-scan-core.js'
import { gitRunnerWith, readOpenPaths } from '../../src/providers/task-dir-core.js'
import { macPromptProbe } from '../../src/providers/host-exec-watch.js'
import { cpuOfPid } from '../../src/providers/host-exec-matcher.js'
import { gitChildEnv } from '../../src/lib/git-env.js'
import { createCodeServer } from '../../src/providers/vscode-server-core.js'
import { grepReferencesHostLocal } from '../../src/providers/search-grep-core.js'

interface Call { file: string; args: string[]; opts: { env?: NodeJS.ProcessEnv } }

function fakeExecFile(stdout = '') {
  const calls: Call[] = []
  const fn = ((file: string, args: string[], opts: Call['opts'], cb?: (e: Error | null, out: string, err: string) => void) => {
    calls.push({ file, args, opts: opts ?? {} })
    const child = Object.assign(new EventEmitter(), { stdin: null })
    process.nextTick(() => cb?.(null, stdout, ''))
    return child
  }) as unknown as typeof execFile
  return { fn, calls }
}

const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'child-use-')); roots.push(d); return d }
const ENV = { PATH: '/usr/bin:/bin', RUNTIME_MARK: 'rt', GIT_DIR: '/elsewhere/.git' }

describe('a module of the daemon runtime starts its children the way its caller says', () => {
  it('detached-registry processStart: ps through the given execFile', async () => {
    const { fn, calls } = fakeExecFile('Mon Oct 26 10:15:01 2026')
    expect(await processStart(4242, { execFile: fn })).toBe('Mon Oct 26 10:15:01 2026')
    expect(calls.map((c) => c.file)).toEqual(['ps'])
  })

  it('daemon-cron-host: sysctl and ps with the given env under LANG=C', async () => {
    const { fn, calls } = fakeExecFile('boot-1')
    expect(await readCronBootId('darwin', AbortSignal.timeout(5000), { execFile: fn, env: ENV })).toBe('boot-1')
    await probeCronProcess({ bootId: 'boot-1', pid: 4242, startTime: 'x' }, 'boot-1', 'darwin', AbortSignal.timeout(5000), { execFile: fn, env: ENV })
    expect(calls.map((c) => c.file)).toEqual(['/usr/sbin/sysctl', '/bin/ps'])
    for (const c of calls) expect(c.opts.env).toMatchObject({ RUNTIME_MARK: 'rt', LANG: 'C', LC_ALL: 'C' })
  })

  it('port-scan-core defaultPortScanIo: lsof through the given execFile', async () => {
    const { fn, calls } = fakeExecFile('out')
    expect(await defaultPortScanIo({ execFile: fn }).run('lsof', ['-n'], 1000)).toBe('out')
    expect(calls.map((c) => c.file)).toEqual(['lsof'])
  })

  it('task-dir-core: git with the given env less every GIT_ var, lsof through the given execFile', async () => {
    const { fn, calls } = fakeExecFile('')
    await gitRunnerWith({ execFile: fn, env: ENV })(tempDir(), ['status'])
    expect(calls[0]!.file).toBe('git')
    expect(calls[0]!.opts.env).toEqual({ PATH: '/usr/bin:/bin', RUNTIME_MARK: 'rt' })
    await readOpenPaths(tempDir(), { execFile: fn })
    expect(calls[1]!.file).toBe('lsof')
  })

  it('host-exec: the dialog probe and the matcher\'s cpu read through the given execFile', async () => {
    const { fn, calls } = fakeExecFile('')
    await macPromptProbe(Date.now, fn).snapshot([4242])
    await cpuOfPid(4242, 'darwin', fn)
    expect(calls.map((c) => c.file)).toEqual(['/bin/ps', 'ps'])
  })

  it('git-env gitChildEnv: built from the given env, redirects dropped', () => {
    expect(gitChildEnv(undefined, ENV)).toEqual({ PATH: '/usr/bin:/bin', RUNTIME_MARK: 'rt' })
    expect(gitChildEnv({ GIT_DIR: '/mine' }, ENV)).toEqual({ ...ENV, GIT_DIR: '/mine' })
  })

  it('vscode-server-core createCodeServer: its git runs through the given execFile, from the given env', async () => {
    const { fn, calls } = fakeExecFile('')
    const home = tempDir()
    const server = createCodeServer({ execFile: fn, env: { ...ENV, HOME: home } })
    expect(await server.resolveOpenTarget('~')).toEqual({ kind: 'folder', path: home })
    expect(calls.map((c) => c.file)).toEqual(['git'])
    expect(calls[0]!.opts.env).toEqual({ PATH: '/usr/bin:/bin', RUNTIME_MARK: 'rt', HOME: home })
    expect(await server.codeServerStatus()).toEqual({ running: false })
  })

  it('search-grep-core: git through the given execFile', async () => {
    const { fn, calls } = fakeExecFile('')
    const dir = tempDir()
    await grepReferencesHostLocal({ file: path.join(dir, 'a.ts'), symbol: 'someSymbol', childProcess: { execFile: fn } })
    expect(calls[0]!.file).toBe('git')
  })
})
