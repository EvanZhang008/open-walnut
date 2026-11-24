/**
 * Workspace transfer ('fs-write-part-v1', 'transfer-v1') and host facts
 * ('host-facts-v1') are wired into the daemon: it imports transfer-core.ts,
 * transfer-pack-core.ts and host-facts-core.ts. This pins the wiring (commands,
 * capabilities, bridge and follower exclusion, version/build lists) and runs the
 * factories against real files and a real repo.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { gitChildEnv } from '../../src/lib/git-env.js'
import { createTransferCore, type TransferCoreDeps } from '../../src/providers/transfer-core.js'
import { createTransferPack, type TransferPackDeps } from '../../src/providers/transfer-pack-core.js'
import { createHostFacts } from '../../src/providers/host-facts-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { daemonCommandNames } from '../helpers/daemon-runtime-text.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const standalone = read('src/providers/daemon-standalone.ts')
const COMMANDS = ['fs.writePart', 'transfer.pack', 'transfer.reach', 'transfer.fetch', 'transfer.realpath', 'host.facts', 'host.load', 'host.endpoint', 'transfer.scan', 'transfer.apply', 'transfer.clear', 'transfer.recent']
const CAPS = ['fs-write-part-v1', 'transfer-v1', 'host-facts-v1', 'host-load-v1', 'model-endpoint-v1', 'task-move-v1', 'task-move-clear-v1', 'task-move-into-v1', 'task-move-base-v1']
const CORES = ['src/providers/transfer-core.ts', 'src/providers/transfer-pack-core.ts', 'src/providers/host-facts-core.ts']

function setLiteral(src: string, name: string): string {
  const start = src.indexOf(name + ' = new Set([')
  expect(start, name).toBeGreaterThan(0)
  const end = src.indexOf('])', start)
  expect(end).toBeGreaterThan(start)
  // Comments name other commands; only the quoted entries count.
  return src.slice(start, end).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
}

describe('transfer + host facts daemon wiring', () => {
  it('the daemon dispatches every command', () => {
    // A dispatch case or a command-table entry (daemonCommandNames).
    for (const cmd of COMMANDS) expect(daemonCommandNames()).toContain(cmd)
  })

  it('the capabilities are advertised, not required', () => {
    for (const cap of CAPS) {
      expect(ADVERTISED_DAEMON_CAPABILITIES).toContain(cap)
      expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain(cap)
    }
  })

  it('no command is reachable over the bridge or from a follower', () => {
    const bridge = setLiteral(standalone, 'BRIDGE_ALLOWED_COMMANDS')
    const follower = setLiteral(standalone, 'FOLLOWER_ALLOWED_COMMANDS')
    for (const cmd of COMMANDS) {
      expect(bridge).not.toContain(`'${cmd}'`)
      expect(follower).not.toContain(`'${cmd}'`)
    }
  })

  it('the cores are in the version hash list and the binary build list, in the same order', () => {
    const versionList = read('src/providers/daemon-version-check.ts')
    const build = read('scripts/build-daemon.sh')
    for (const f of CORES) {
      expect(versionList).toContain(`'${f}'`)
      expect(build).toContain(f)
    }
    for (let i = 1; i < CORES.length; i++) {
      expect(versionList.indexOf(CORES[i - 1])).toBeLessThan(versionList.indexOf(CORES[i]))
      expect(build.indexOf(CORES[i - 1])).toBeLessThan(build.indexOf(CORES[i]))
    }
  })

  it('fs.writePart rides the bulk channel (its request is a chunk)', () => {
    expect(read('src/providers/daemon-connection.ts')).toMatch(/BULK_COMMANDS = new Set\(\[[^\]]*'fs\.writePart'/)
  })
})

describe('the factories on real files and a real repo', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-transfer-twin-')))
  afterAll(() => { if (tmp.includes('walnut-transfer-twin-')) fs.rmSync(tmp, { recursive: true, force: true }) })
  const gitconfig = path.join(tmp, 'gitconfig')
  fs.writeFileSync(gitconfig, '[user]\n\tname = Twin\n\temail = twin@example.com\n[init]\n\tdefaultBranch = main\n')
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, TMPDIR: tmp, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' }
  const guardedSpawn = ((cmd: string, args: string[], o: Record<string, unknown>) => {
    if (o.cwd && !String(o.cwd).startsWith(tmp)) throw new Error('spawn outside the temp dir')
    return spawn(cmd, args, o)
  })

  async function run(name: string) {
    const dir = path.join(tmp, name)
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, env: gitChildEnv(env), stdio: 'pipe' })
    git(['init', '-q'])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'init'])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n')
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n')
    const packer = createTransferPack({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferPackDeps['spawn'], env, home: tmp, now: () => 0 })
    const packed = await packer.pack({ cwd: repo, outDir: path.join(dir, 'out') })
    const core = createTransferCore({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferCoreDeps['spawn'], env, home: tmp })
    const body = Buffer.from('hello transfer')
    await core.writePart({ path: '~/' + name + '/landed.txt', offset: 0, data: body.subarray(0, 5).toString('base64') })
    const done = await core.writePart({ path: '~/' + name + '/landed.txt', offset: 5, data: body.subarray(5).toString('base64'), final: true, size: body.length })
    return {
      kind: packed.meta.kind, dirty: packed.meta.dirty, headOnRemote: packed.meta.headOnRemote,
      names: packed.files.map((f) => f.name),
      patch: fs.readFileSync(path.join(dir, 'out', 'changes.patch'), 'utf8').replace(/index [0-9a-f]+\.\.[0-9a-f]+/g, 'index X'),
      landed: fs.readFileSync(path.join(dir, 'landed.txt'), 'utf8'),
      done: done.done,
    }
  }

  it('pack and writePart answer', async () => {
    const result = await run('repo-1')
    expect(result).toMatchObject({ kind: 'git', dirty: true, headOnRemote: false, landed: 'hello transfer', done: true })
    expect(result.names).toEqual(['meta.json', 'changes.patch', 'untracked.tgz', 'repo.bundle'])
    expect(result.patch).toContain('+two')
  }, 60_000)

  it('host facts builds and answers', async () => {
    const facts = createHostFacts({
      fs, os, execFile: () => { throw new Error('no children in this test') },
      http: { request: () => { throw new Error('no network') } } as never,
      https: { request: () => { throw new Error('no network') } } as never,
      env: {}, home: tmp, platform: 'freebsd', arch: 'x64', timeouts: { probeMs: 200, totalMs: 1000 },
    })
    const r = await facts.facts({ network: false })
    expect(r.os.platform).toBe('freebsd')
    expect(r.tools.git).toBeNull()
    expect(r.cloud).toBeNull()
  })
})
