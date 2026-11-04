/**
 * Guard: both daemon twins write daemon.pid before daemon.port. A starter waits for the port
 * file and then reads the pid (about twenty twin tests do), so a pid written after the port left
 * a gap: CI run 41804238903 read daemon.pid there and failed with ENOENT (the standalone twin
 * started its host network between the two writes).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

describe('daemon.pid is written before daemon.port', () => {
  for (const file of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
    it(file, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      const writes = (name: string) => [...text.matchAll(new RegExp(`writeFileSync\\(${name},`, 'g'))].map((m) => m.index!)
      const pid = writes('PID_FILE')
      const port = writes('PORT_FILE')
      expect(pid.length, 'one daemon.pid write').toBe(1)
      expect(port.length, 'one daemon.port write').toBe(1)
      expect(pid[0]).toBeLessThan(port[0])
    })
  }
})
