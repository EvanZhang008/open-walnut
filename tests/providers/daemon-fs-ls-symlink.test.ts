/**
 * Daemon `fs.ls` — symlink classification, both twins.
 *
 * Shipped report (2026-09-14): on dev boxes `/home/<user>` is a symlink to
 * `/local/home/<user>`. `readdir({withFileTypes})` has lstat semantics, so the
 * daemon reported the link as `type: 'other'`, the picker's BFS dropped it, and
 * the user's own home was invisible under `/home/` ("host tab visible, no
 * folders"). The fix follows the link once and marks it `symlink: true` so
 * walkers list it without descending.
 *
 * Two layers:
 *   1. real binary: spawn dist/daemon-binaries/daemon-darwin-arm64 against an
 *      isolated dir and call fs.ls over a direct WS (skips when not built);
 *   2. source parity: both twins carry the same isSymbolicLink() branch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'

const ROOT = path.resolve(__dirname, '../..')
const BINARY = path.join(ROOT, 'dist', 'daemon-binaries', 'daemon-darwin-arm64')
const hasBinary = process.platform === 'darwin' && process.arch === 'arm64' && fs.existsSync(BINARY)
const d = hasBinary ? describe : describe.skip

const DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fsls-real-'))
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fsls-data-'))
const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

let daemonPid: number | null = null
let daemonPort = 0

async function waitFor(cond: () => boolean, ms: number, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!cond()) throw new Error(`timed out waiting for ${label}`)
}

d('fs.ls against the real daemon binary — symlinks', () => {
  beforeAll(async () => {
    // DATA_DIR/
    //   home/ec2-user/            real dir
    //   home/marina -> ../local/marina   symlink to a dir (the dev-box shape)
    //   home/notes.md -> ../local/marina/notes.md   symlink to a file
    //   home/broken -> ../nowhere   dangling
    //   local/marina/bin/           real dir behind the link
    fs.mkdirSync(path.join(DATA_DIR, 'home/ec2-user'), { recursive: true })
    fs.mkdirSync(path.join(DATA_DIR, 'local/marina/bin'), { recursive: true })
    fs.writeFileSync(path.join(DATA_DIR, 'local/marina/notes.md'), 'hi')
    fs.symlinkSync('../local/marina', path.join(DATA_DIR, 'home/marina'))
    fs.symlinkSync('../local/marina/notes.md', path.join(DATA_DIR, 'home/notes.md'))
    fs.symlinkSync('../nowhere', path.join(DATA_DIR, 'home/broken'))

    const env: NodeJS.ProcessEnv = { ...process.env, WALNUT_DAEMON_DIR: DAEMON_DIR }
    delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID
    delete env.VITEST_POOL_ID; delete env.OPEN_WALNUT_HOME
    const proc = spawn(BINARY, ['--start'], { detached: true, stdio: 'ignore', env })
    proc.unref()
    await waitFor(() => fs.existsSync(PORT_FILE), 10_000, 'daemon port file')
    daemonPort = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10)
    daemonPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
  }, 30_000)

  afterAll(() => {
    // Only ever signal the pid the isolated daemon wrote for itself.
    if (daemonPid && daemonPid > 1) { try { process.kill(daemonPid, 'SIGTERM') } catch {} }
    for (const dir of [DAEMON_DIR, `${DAEMON_DIR}-streams`, DATA_DIR]) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('a symlink to a dir is type:dir + symlink:true; to a file is type:file; dangling is other', async () => {
    const conn = new DaemonConnection('fsls-real', TARGET)
    try {
      await conn.connectDirect(`ws://127.0.0.1:${daemonPort}`)
      const res = await conn.send('fs.ls', { path: path.join(DATA_DIR, 'home') })
      expect(res.ok).toBe(true)
      const byName = new Map((res.entries as Array<{ name: string; type: string; symlink?: boolean }>).map(e => [e.name, e]))
      expect(byName.get('ec2-user')).toMatchObject({ type: 'dir' })
      expect(byName.get('ec2-user')?.symlink).toBeUndefined()
      expect(byName.get('marina')).toMatchObject({ type: 'dir', symlink: true })
      expect(byName.get('notes.md')).toMatchObject({ type: 'file', symlink: true })
      expect(byName.get('broken')).toMatchObject({ type: 'other', symlink: true })
    } finally {
      conn.disconnect()
    }
  })

  it('detail:true still adds size/mtime for a symlinked file', async () => {
    const conn = new DaemonConnection('fsls-real-detail', TARGET)
    try {
      await conn.connectDirect(`ws://127.0.0.1:${daemonPort}`)
      const res = await conn.send('fs.ls', { path: path.join(DATA_DIR, 'home'), detail: true })
      const notes = (res.entries as Array<{ name: string; size?: number; mtimeMs?: number }>).find(e => e.name === 'notes.md')
      expect(notes?.size).toBe(2)
      expect(typeof notes?.mtimeMs).toBe('number')
    } finally {
      conn.disconnect()
    }
  })
})

describe('fs.ls symlink handling — twin parity (daemon-standalone vs daemon-source)', () => {
  const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
  const source = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8')

  const fsLsBody = (src: string) => {
    const start = src.indexOf('function cmdFsLs(')
    const end = src.indexOf('function cmdFsFind(', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    return src.slice(start, end)
  }

  it('both twins follow symlinks with stat() and tag them symlink:true', () => {
    for (const body of [fsLsBody(standalone), fsLsBody(source)]) {
      expect(body).toContain('e.isSymbolicLink()')
      expect(body).toContain('symlink: true')
      expect(body).toMatch(/fs\.promises\.stat\(dirPath \+ '\/' \+ e\.name\)/)
    }
  })
})
