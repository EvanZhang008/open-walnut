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
  for (const file of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
    it(file, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      const at = (pattern: string) => [...text.matchAll(new RegExp(pattern, 'g'))].map((m) => m.index!)
      const pid = at('writeFileSync\\(PID_FILE,')
      const port = at('renameSync\\(\\w+, PORT_FILE\\)')
      expect(pid.length, 'one daemon.pid write').toBe(1)
      expect(port.length, 'one daemon.port rename').toBe(1)
      expect(at('writeFileSync\\(PORT_FILE,'), 'daemon.port is never written in place').toEqual([])
      expect(pid[0]).toBeLessThan(port[0])
    })
  }
})
