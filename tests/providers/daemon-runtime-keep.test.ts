/**
 * keepRuntimeFiles (daemon-core.ts), on a real temp dir: the temp cleanup (macOS after 3 days,
 * systemd-tmpfiles after 10) removes a running daemon's own files from /tmp/open-walnut, and
 * the next server or join sees no daemon there (2026-11-02: a Mac whose Walnut had run 26 days
 * had lost daemon.pid, daemon.port and sessions.json). Both twins run it every hour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { keepRuntimeFiles, RUNTIME_KEEP_MS } from '../../src/providers/daemon-core.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-keep-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const OLD = new Date('2026-10-01T00:00:00Z')
const NOW = new Date('2026-11-02T08:00:00Z')

function keep(pid = 4242) {
  let persisted = 0
  const f = (n: string) => path.join(dir, n)
  const restored = keepRuntimeFiles({
    fs, pid, pidFile: f('daemon.pid'),
    files: [{ file: f('daemon.port'), text: '41234' }, { file: f('daemon.pid'), text: String(pid) }, { file: f('daemon.version'), text: 'v1' }],
    touch: [f('daemon.owner'), f('bridge.json')],
    touchDirs: [{ dir: f('bin'), match: /^walnut/ }, { dir, match: /\.(cjs|mjs|js)$|^daemon-(darwin|linux)-[a-z0-9-]+$|^dtach-/ }],
    registryFile: f('sessions.json'),
    persistRegistry: () => { persisted++; fs.writeFileSync(f('sessions.json'), '{"version":1,"sessions":{}}') },
    now: NOW,
  })
  return { restored: restored.map((p) => path.basename(p)), persisted }
}

describe('keepRuntimeFiles', () => {
  it('writes back what the cleanup removed, the registry by its own writer', () => {
    const r = keep()
    expect(r.restored).toEqual(['daemon.port', 'daemon.pid', 'daemon.version', 'sessions.json'])
    expect(r.persisted).toBe(1)
    expect(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8')).toBe('41234')
    expect(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8')).toBe('4242')
  })

  it('freshens the times of files that are there, so a cleanup by age never finds them old', () => {
    for (const n of ['daemon.port', 'daemon.pid', 'daemon.version', 'sessions.json']) {
      fs.writeFileSync(path.join(dir, n), n === 'daemon.pid' ? '4242' : 'x')
      fs.utimesSync(path.join(dir, n), OLD, OLD)
    }
    expect(keep()).toEqual({ restored: [], persisted: 0 })
    for (const n of ['daemon.port', 'daemon.pid', 'daemon.version', 'sessions.json']) {
      const st = fs.statSync(path.join(dir, n))
      expect(st.mtimeMs).toBe(NOW.getTime())
      expect(st.atimeMs).toBe(NOW.getTime())
    }
    expect(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8')).toBe('x')
  })

  it('freshens the files that are only read (shim, daemon copy, sidecars, bridge.json), never the logs', () => {
    fs.mkdirSync(path.join(dir, 'bin'))
    fs.mkdirSync(path.join(dir, 'images'))
    const read = ['bin/walnut', 'bin/walnut-core', 'net-core.cjs', 'daemon-fallback.cjs', 'daemon-darwin-arm64', 'dtach-darwin-arm64', 'bridge.json', 'daemon.owner']
    // The server prunes its logs by age (src/logging/logger.ts), and old daemons' logs age out.
    const aging = ['open-walnut-2026-10-01.log', 'daemon-d-123-ab12.log', 'images/a.png', 'acp-busy.json']
    for (const n of [...read, ...aging]) { fs.writeFileSync(path.join(dir, n), 'x'); fs.utimesSync(path.join(dir, n), OLD, OLD) }
    keep()
    for (const n of read) expect(fs.statSync(path.join(dir, n)).mtimeMs, n).toBe(NOW.getTime())
    for (const n of aging) expect(fs.statSync(path.join(dir, n)).mtimeMs, n).toBe(OLD.getTime())
  })

  it('never writes over another daemon that took the dir', () => {
    fs.writeFileSync(path.join(dir, 'daemon.pid'), '777')
    fs.writeFileSync(path.join(dir, 'bridge.json'), 'x')
    fs.utimesSync(path.join(dir, 'bridge.json'), OLD, OLD)
    expect(keep()).toEqual({ restored: [], persisted: 0 })
    expect(fs.existsSync(path.join(dir, 'daemon.port'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8')).toBe('777')
    // Nor touches its files: they are that daemon's to keep.
    expect(fs.statSync(path.join(dir, 'bridge.json')).mtimeMs).toBe(OLD.getTime())
  })

  it('a dir that is gone is left alone, and nothing throws', () => {
    fs.rmSync(dir, { recursive: true, force: true })
    expect(() => keep()).not.toThrow()
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('both twins run it, every RUNTIME_KEEP_MS, well inside the shortest cleanup age', () => {
    expect(RUNTIME_KEEP_MS).toBeLessThanOrEqual(6 * 3600_000)
    const source = getDaemonSource()
    expect(source).toContain(`: ${RUNTIME_KEEP_MS} /* RUNTIME_KEEP_MS */);\n    runtimeKeepTimer.unref();`)
    expect(source).toContain('if (runtimeKeepTimer) { try { clearInterval(runtimeKeepTimer); } catch {} runtimeKeepTimer = null; }')
    expect(source).toContain('var restored = keepRuntimeFiles({')
    const standalone = fs.readFileSync(path.join(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')
    expect(standalone).toContain(': RUNTIME_KEEP_MS)\n  runtimeKeepTimer.unref?.()')
    expect(standalone).toContain('if (runtimeKeepTimer) { try { clearInterval(runtimeKeepTimer) } catch {} runtimeKeepTimer = null }')
    expect(standalone).toContain('const restored = keepRuntimeFiles({')
  })
})
