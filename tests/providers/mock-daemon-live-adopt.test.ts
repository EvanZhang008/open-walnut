/**
 * The mock daemon adopts a live CLI on a resume start, as the real daemons' cmdStart does: a
 * resume with a message, or a deferred one, against a CLI still running keeps that process.
 *
 * 2026-11-23: session-hold-turn-subagents.spec.ts's live-adopt probe had asked the isolated real
 * local daemon, which never saw the fixture's sessions, and failed since the day it was added; the
 * MockDaemon it should have asked respawned instead, leaving two CLIs on one session id.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

let daemon: MockDaemon
let ws: WebSocket
let frames: Array<Record<string, unknown>>
let nextId = 1

async function request(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++
  ws.send(JSON.stringify({ id, ...cmd }))
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const reply = frames.find((f) => f.id === id)
    if (reply) return reply
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`no reply to ${String(cmd.cmd)}`)
}

describe('mock daemon: a resume start against a live CLI adopts it', () => {
  beforeEach(async () => {
    daemon = await createMockDaemon()
    frames = []
    ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`)
    ws.on('message', (data) => { frames.push(JSON.parse(String(data))) })
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
  })

  afterEach(async () => {
    ws.close()
    await daemon.stop()
  })

  it('keeps the process for a deferred message and for a message, and respawns on a bare restart', async () => {
    const sid = 'live-adopt-mock'
    const args = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    const first = await request({ cmd: 'start', sid, args, cwd: process.cwd(), message: '' })
    expect(first.ok).toBe(true)
    const pid = first.pid as number
    expect(pid).toBeGreaterThan(0)

    const deferred = await request({ cmd: 'start', sid, args, cwd: process.cwd(), resume: true, message: '', deferMessage: true })
    expect(deferred).toMatchObject({ ok: true, adopted: true, pid })

    const withMessage = await request({ cmd: 'start', sid, args, cwd: process.cwd(), resume: true, message: 'hello again' })
    expect(withMessage).toMatchObject({ ok: true, adopted: true, pid })
    expect(daemon.getFifoWrites().some((w) => w.sid === sid && w.message === 'hello again')).toBe(true)

    // An explicit restart sends no message and still takes the respawn path, as the real daemon.
    const restart = await request({ cmd: 'start', sid, args, cwd: process.cwd(), resume: true, message: '' })
    expect(restart.ok).toBe(true)
    expect(restart.adopted).toBeUndefined()
    expect(restart.pid).not.toBe(pid)
  })
})

describe('a browser spec asks the daemon its fixture sessions run on', () => {
  const dir = path.resolve(import.meta.dirname, '../e2e/browser')
  it('the fixture names the MockDaemon port, and every spec that reads a daemon port reads it first', () => {
    expect(fs.readFileSync(path.join(dir, 'test-server.ts'), 'utf-8')).toMatch(/writeFileSync\(path\.join\(tmpBase, 'mock-daemon\.port'\)/)
    const offenders = fs.readdirSync(dir).filter((f) => f.endsWith('.spec.ts')).filter((f) => {
      const src = fs.readFileSync(path.join(dir, f), 'utf-8')
      return src.includes('daemon/daemon.port') && !src.includes('mock-daemon.port')
    })
    expect(offenders, 'read mock-daemon.port first: daemon/daemon.port is the isolated real daemon, which never saw the fixture sessions').toEqual([])
  })
})
