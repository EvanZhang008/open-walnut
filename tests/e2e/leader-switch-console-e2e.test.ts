/**
 * The old leader's console after a leader switch, with real servers
 * (scripts/leader-switch/console-rehearsal.ts; docs/reference/leader-switch.md, "The old
 * leader's console"): A leads, switches to B, becomes B's host; B's replica on A serves A's
 * console at A's address while the Mac app's handling is replayed the whole time; B is cut off
 * and comes back; `walnut web` started by hand on the handed-over home (witnesses online and out
 * of reach) only says where the console is; A's home keeps every path of the leader's data and
 * this machine's data byte for byte; the switch back closes the console and A leads again.
 * Twice: A's host daemon with its state in its own dir, and as installed (its state inside the
 * data home). Runs the built app (`bun run build`). No :3456, no ~/.open-walnut.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rehearseConsole } from '../../scripts/leader-switch/console-rehearsal.js'
import type { Check } from '../../scripts/leader-switch/rehearsal.js'
import { builtAppMissing } from '../helpers/replica-cluster.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-console-e2e-'))
afterAll(() => {
  const open = (p: string) => {
    try { fs.chmodSync(p, 0o700); if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) open(path.join(p, e)) } catch { /* gone */ }
  }
  open(root)
  fs.rmSync(root, { recursive: true, force: true })
})

let port = 5050 + (process.pid % 20) * 4
const ports = () => { port += 2; return { portA: port, portB: port + 1 } }
const failed = (checks: Check[]) => checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)
const missing = builtAppMissing()

describe.skipIf(!!missing)('the old leader\'s console after a switch, real servers', () => {
  it('serves the console at the old address as a replica of the new leader, keeps the Mac app attached, survives the leader going away, leaves the old home as handed over, and gives the port back at the switch back', async () => {
    const c = await rehearseConsole(path.join(root, 'console'), () => {}, { ...ports(), awaySeconds: 30 })
    expect(failed(c.all)).toEqual([])
    expect(c.all.length).toBeGreaterThan(15)
  }, 900_000)

  it('the same with the host daemon keeping its state inside the data home, as installed', async () => {
    const c = await rehearseConsole(path.join(root, 'as-installed'), () => {}, { ...ports(), awaySeconds: 30, asInstalled: true })
    expect(failed(c.all)).toEqual([])
  }, 900_000)
})
