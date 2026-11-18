/**
 * A test that times a link through the silent-link proxy never sends a daemon command whose answer is
 * sized by this machine: a listing of the machine's temp folder. The proxy's slow mode delays each
 * chunk in turn, so a reply of N chunks lands N delays late, and the temp folder's size changes from
 * machine to machine and hour to hour (2026-11-18: host-exec-dial-real's reply "in flight when the
 * path died" was a 173 KB listing of 3,398 entries, landed seconds late, and its two signal cases
 * failed on every run; with 10,000 entries in TMPDIR they failed every time). List a folder the test
 * made itself instead.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const SKIP = new Set(['node_modules', 'dist', '.git', 'web'])

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourcesUnder(p, out)
    else if (/\.(ts|mts|js|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

/** A daemon command (conn.send / sendCommand) whose `path` is the machine's temp folder itself. */
const MACHINE_SIZED = /\bsend\w*\(\s*['"`][\w.]+['"`]\s*,\s*\{[^}]*\bpath:\s*(?:os\.tmpdir\(\)|process\.env\.TMPDIR\b|tmpdir\(\))\s*[,}]/

function machineSizedPayloads(source: string): string[] {
  if (!/silent-link-proxy/.test(source)) return []
  return source.split('\n').filter((line) => MACHINE_SIZED.test(line)).map((l) => l.trim())
}

describe('silent-link proxy timing tests send no machine-sized payload', () => {
  it('the check finds the shape it guards against', () => {
    const sample = [
      "import { startSilentLinkProxy } from '../../helpers/silent-link-proxy.js'",
      "const reply = conn.send('fs.ls', { path: os.tmpdir() }, 20_000)",
      "await conn.send('fs.ls', { path: lsDir }, 2_000)",
      "const f = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))",
    ].join('\n')
    expect(machineSizedPayloads(sample)).toEqual(["const reply = conn.send('fs.ls', { path: os.tmpdir() }, 20_000)"])
  })

  it('no test or helper that drives the proxy lists the temp folder over it', () => {
    const files = sourcesUnder(path.join(ROOT, 'tests'))
    const drivers = files.filter((f) => f !== __filename && /silent-link-proxy/.test(fs.readFileSync(f, 'utf-8')))
    expect(drivers.length).toBeGreaterThan(3) // the scan reaches them
    const hits = drivers.flatMap((f) => machineSizedPayloads(fs.readFileSync(f, 'utf-8')).map((l) => `${path.relative(ROOT, f)}: ${l}`))
    expect(hits).toEqual([])
  })
})
