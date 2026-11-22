/**
 * Guard: both daemon twins write daemon.pid before daemon.port. A starter waits for the port
 * file and then reads the pid (about twenty twin tests do), so a pid written after the port left
 * a gap: CI run 41804238903 read daemon.pid there and failed with ENOENT (the standalone twin
 * started its host network between the two writes).
 *
 * daemon.port goes in by rename, so a reader that sees it reads the whole port: CI run
 * 43535674084 read it between its creation and its write, empty, and dialed ws://127.0.0.1:NaN.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

describe('daemon.pid is written before daemon.port, and daemon.port whole', () => {
  it('src/providers/daemon-source.ts', () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf8')
    const at = (pattern: string) => [...text.matchAll(new RegExp(pattern, 'g'))].map((m) => m.index!)
    const pid = at('writeFileSync\\(PID_FILE,')
    const port = at('renameSync\\(\\w+, PORT_FILE\\)')
    expect(pid.length, 'one daemon.pid write').toBe(1)
    expect(port.length, 'one daemon.port rename').toBe(1)
    expect(at('writeFileSync\\(PORT_FILE,'), 'daemon.port is never written in place').toEqual([])
    expect(pid[0]).toBeLessThan(port[0])
  })

  // The standalone twin writes both through the door module (daemon-door.ts publishDoorFiles), once.
  it('src/providers/daemon-standalone.ts (through daemon-door.ts)', () => {
    const twin = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')
    expect(twin.match(/writeFileSync\(PID_FILE,/g) ?? [], 'no daemon.pid write of its own').toEqual([])
    expect(twin.match(/writeFileSync\(PORT_FILE,|renameSync\(\w+, PORT_FILE\)/g) ?? [], 'no daemon.port write of its own').toEqual([])
    expect(twin.match(/publishDoorFiles\(fs, \{ pidFile: PID_FILE, portFile: PORT_FILE \}/g) ?? []).toHaveLength(1)
    const door = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-door.ts'), 'utf8')
    const body = door.slice(door.indexOf('export function publishDoorFiles'))
    const pid = body.indexOf('fs.writeFileSync(files.pidFile,')
    const port = body.indexOf('fs.renameSync(tmp, files.portFile)')
    expect(pid).toBeGreaterThan(-1)
    expect(port).toBeGreaterThan(pid)
    expect(body).not.toMatch(/writeFileSync\(files\.portFile/)
  })
})
