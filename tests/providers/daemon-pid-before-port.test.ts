/**
 * Guard: both daemon twins write daemon.pid before daemon.port. A starter waits for the port
 * file and then reads the pid (about twenty twin tests do), so a pid written after the port left
 * a gap: CI run 41804238903 read daemon.pid there and failed with ENOENT (the standalone twin
 * started its host network between the two writes).
 *
 * daemon.port goes in by rename, so a reader that sees it reads the whole port: CI run
 * 43535674084 read it between its creation and its write, empty, and dialed ws://127.0.0.1:NaN. *
 * daemon.stamp (the pid's start time, daemon-door.ts stampDoor) goes right after daemon.pid, and
 * an earlier daemon's stamp goes before it: a stamp older than daemon.pid is an earlier writer's
 * and reads as no stamp (daemon-live-sh.ts w_stamp; review A3b S34-M1: a daemon from before the
 * stamp that got the same pid read as dead by the stamp a newer daemon left).
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
    const stamp = at('stampDoor\\(fs, \\{ pidFile: PID_FILE, stampFile: STAMP_FILE \\}, process\\.pid,')
    expect(stamp.length, 'one daemon.stamp write').toBe(1)
    const unstamp = at('unlinkSync\\(STAMP_FILE\\)')
    expect(unstamp.filter((i) => i < pid[0] && i > pid[0] - 400), 'the earlier stamp goes just before daemon.pid').toHaveLength(1)
    expect(stamp[0]).toBeGreaterThan(pid[0])
    expect(stamp[0]).toBeLessThan(port[0])
    expect(text).toMatch(/const STAMP_FILE = path\.join\(DAEMON_DIR, 'daemon\.stamp'\);/)
  })

  // The standalone twin writes both through the door module (daemon-door.ts publishDoorFiles), once.
  it('src/providers/daemon-standalone.ts (through daemon-door.ts)', () => {
    const twin = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')
    expect(twin.match(/writeFileSync\(PID_FILE,/g) ?? [], 'no daemon.pid write of its own').toEqual([])
    expect(twin.match(/writeFileSync\(PORT_FILE,|renameSync\(\w+, PORT_FILE\)/g) ?? [], 'no daemon.port write of its own').toEqual([])
    expect(twin.match(/publishDoorFiles\(fs, \{ pidFile: PID_FILE, portFile: PORT_FILE, stampFile: STAMP_FILE \}/g) ?? []).toHaveLength(1)
    expect(twin).toMatch(/const STAMP_FILE = path\.join\(DAEMON_DIR, DAEMON_STAMP_NAME\)/)
    const door = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-door.ts'), 'utf8')
    const body = door.slice(door.indexOf('export function publishDoorFiles'))
    const pid = body.indexOf('fs.writeFileSync(files.pidFile,')
    const port = body.indexOf('fs.renameSync(tmp, files.portFile)')
    expect(pid).toBeGreaterThan(-1)
    expect(port).toBeGreaterThan(pid)
    const stamp = body.indexOf('stampDoor(fs, { pidFile: files.pidFile, stampFile: files.stampFile }, at.pid, read)')
    const unstamp = body.indexOf('fs.unlinkSync(files.stampFile)')
    expect(stamp).toBeGreaterThan(pid)
    expect(port).toBeGreaterThan(stamp)
    expect(unstamp).toBeGreaterThan(-1)
    expect(pid).toBeGreaterThan(unstamp)
    expect(door).toMatch(/export const DAEMON_STAMP_NAME = 'daemon\.stamp'/)
    expect(body).not.toMatch(/writeFileSync\(files\.portFile/)
  })
})
