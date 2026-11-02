/**
 * A script's server port comes from below the OS's ephemeral range (scripts/lib/free-port.mjs).
 *
 * 2026-11-02, the binary matrix's macos-26 rehearsal: the port came from listen(0), so from
 * the range the OS hands to every outbound connection and listen(0) on the machine, and
 * the server restarted on it died with EADDRINUSE. The ratchet below fails on a new script
 * that picks a port that way again.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ephemeralRange, freePort, pickRange } from '../../scripts/lib/free-port.mjs'

const repo = path.resolve(__dirname, '../..')

describe('freePort', () => {
  it('reads a range from the OS and picks below it', () => {
    const [lo, hi] = ephemeralRange()
    expect(lo).toBeGreaterThan(1024)
    expect(hi).toBeGreaterThanOrEqual(lo)
    const [from, to] = pickRange([lo, hi])
    expect(to).toBe(lo - 1)
    expect(from).toBeGreaterThanOrEqual(10_000)
  })

  it('keeps 10000 to 20000 when the range starts too low to pick below it', () => {
    expect(pickRange([1025, 65535])).toEqual([10_000, 20_000])
    expect(pickRange([49152, 65535])).toEqual([34_151, 49_151])
    expect(pickRange([32768, 60999])).toEqual([17_767, 32_767])
  })

  it('answers a port nothing listens on, outside the ephemeral range', async () => {
    const [lo] = ephemeralRange()
    for (let i = 0; i < 5; i++) {
      const port = await freePort()
      expect(port).toBeLessThan(lo)
      const s = net.createServer()
      await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', () => resolve()) })
      await new Promise((r) => s.close(r))
    }
  })

  it('skips a port someone holds', async () => {
    const s = net.createServer()
    const held = await new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port)))
    try {
      expect(await freePort({ range: [held, held], tries: 3 }).catch((e: Error) => e.message)).toMatch(/no free port/)
    } finally {
      await new Promise((r) => s.close(r))
    }
  })
})

describe('no script picks a port with listen(0) and hands it on', () => {
  // A server that keeps its listen(0) port is fine; closing it to pass the number on is not.
  const pickAndClose = /listen\(\s*0\b[^\n]*\.close\(/
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(mjs|cjs|js|ts)$/.test(e.name)) files.push(full)
    }
  }
  walk(path.join(repo, 'scripts'))

  it('finds the scripts', () => expect(files.length).toBeGreaterThan(20))

  it('every port picker in scripts/ is scripts/lib/free-port.mjs', () => {
    const offenders = files.filter((f) => pickAndClose.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(repo, f))
    expect(offenders, 'pick the port with freePort() from scripts/lib/free-port.mjs').toEqual([])
  })
})
