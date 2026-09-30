/**
 * A phone follow-up sent while an earlier turn of its conversation is stalled,
 * end to end on the real session stack: the api-v1 REST turn, runLaneTurn, the
 * per-agent turn queue, claude-code-session (FIFO delivery, mid-turn injection,
 * turn generations), a daemon and a CLI process.
 *
 * Two gate findings from 2026-09-30, reproduced here as the gate reproduced them:
 *
 *   N1  turn A goes quiet (the stall notice), the follow-up B waits for it, and A
 *       stays quiet for a second window, so the late watch gives up. The gate used
 *       to OPEN at that give-up while A's CLI was still in its turn: B was sent into
 *       it, a mid-turn delivery keeps A's turn generation, and A's answer arrived
 *       as B's (rows Q-A, Q-B, Ans-A; B's own answer never came). Now the give-up
 *       interrupts A and B is sent only once A's turn has ended.
 *   N2  while B waited at that gate it held the agent's turn queue, so another
 *       conversation C of the same agent, sent a moment later, started only after
 *       B's wait. Now B gives the slot up while it waits and C runs at once.
 *
 * Substituted, and only this: the daemon is the in-process mock daemon, and the
 * CLI is tests/providers/mock-claude.mjs, spawned by that daemon from its absolute
 * path (`slow:<ms>` delays a turn's answer; an interrupt aborts it the way the
 * real CLI does). A turn whose message carries `slow:` stalls after 6 s instead of
 * 15 min, so the whole story fits in one test. Nothing here can run the real
 * `claude`: the mock daemon never resolves it from PATH, and in case anything else
 * does, this file runs with a HOME that has no rc files, SHELL=/bin/sh, and a
 * shim directory first on PATH whose `claude` refuses to run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-lane-giveup-e2e'))
vi.mock('../../src/core/sessions/lane-turn.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/core/sessions/lane-turn.js')>()
  return {
    ...orig,
    runLaneTurn: (a: string, c: string, m: string, opts: Parameters<typeof orig.runLaneTurn>[3]) =>
      orig.runLaneTurn(a, c, m, m.includes('slow:') ? { ...opts, stallMs: 6_000, tickMs: 500 } : opts),
  }
})

import { WALNUT_HOME, CONFIG_FILE, conversationFile } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import type { ChatHistoryStore } from '../../src/core/types.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port = 0
let daemon: MockDaemon
let base = ''
const savedEnv = { HOME: process.env.HOME, SHELL: process.env.SHELL, PATH: process.env.PATH }

interface SseEvt { event: string; data: Record<string, unknown>; at: number }

async function connectSse(convId: string): Promise<{ events: SseEvt[]; close: () => void }> {
  const ctl = new AbortController()
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/stream`, { signal: ctl.signal })
  if (res.status !== 200 || !res.body) throw new Error(`SSE -> ${res.status}`)
  const events: SseEvt[] = []
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          let event = ''
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data += line.slice(6)
          }
          if (event) events.push({ event, data: data ? JSON.parse(data) as Record<string, unknown> : {}, at: Date.now() })
        }
      }
    } catch { /* aborted */ }
  })()
  return { events, close: () => ctl.abort() }
}

async function createConv(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  expect(res.status).toBe(201)
  return (await res.json() as { id: string }).id
}

async function send(convId: string, text: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/conversations/${convId}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  })
  expect(res.status).toBe(202)
  return (await res.json() as { turnId: string }).turnId
}

async function waitFor<T>(fn: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

function rows(convId: string): Array<{ role: string; text: string; source?: string }> {
  try {
    const store = JSON.parse(fs.readFileSync(conversationFile('general', convId), 'utf-8')) as ChatHistoryStore
    return (store.entries ?? []).map((e) => {
      const c = e.content as unknown
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? '').join('') : ''
      return { role: e.role, text, ...(e.source ? { source: e.source } : {}) }
    })
  } catch { return [] }
}

/** Kill a daemon through the pid file in its own runtime dir (never by name). */
function stopDaemonIn(dir: string | undefined): void {
  if (!dir) return
  try {
    const pid = Number(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf-8').trim())
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM')
  } catch { /* not running */ }
}

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-lane-giveup-e2e-'))
  const home = path.join(base, 'home')
  const shim = path.join(base, 'bin')
  await fsp.mkdir(home, { recursive: true })
  await fsp.mkdir(shim, { recursive: true })
  await fsp.writeFile(path.join(shim, 'claude'), '#!/bin/sh\necho "claude is disabled in this test" >&2\nexit 1\n', { mode: 0o755 })
  process.env.HOME = home
  process.env.SHELL = '/bin/sh'
  process.env.PATH = `${shim}${path.delimiter}${savedEnv.PATH ?? ''}`

  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fsp.writeFile(CONFIG_FILE, yaml.dump({
    version: 1, user: { name: 'Ada' }, defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' }, agent: { provider: 'claude-code' },
  }), 'utf-8')
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  try { await stopServer() } catch { /* already down */ }
  await daemon?.stop()
  stopDaemonIn(process.env.WALNUT_DAEMON_DIR)
  process.env.HOME = savedEnv.HOME
  process.env.SHELL = savedEnv.SHELL
  process.env.PATH = savedEnv.PATH
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  if (base) await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('a follow-up sent while the earlier turn of its conversation is stalled', () => {
  it('gets its own answer after a give-up, and another conversation of the agent runs meanwhile', async () => {
    const convA = await createConv()
    const convC = await createConv()
    const phoneA = await connectSse(convA)
    const phoneC = await connectSse(convC)
    try {
      // A: its answer would take 20 s; it stalls at ~6 s (the notice) and the late
      // watch gives up at ~12 s.
      const tA = await send(convA, 'slow:20000 first question')
      await waitFor(() => phoneA.events.find((e) => e.event === 'error' && e.data.turnId === tA), 60_000, "A's stall notice")
      expect(phoneA.events.find((e) => e.event === 'error')?.data.laneStillRunning).toBe(true)

      // B: sent after the notice, waits for A (and says so).
      const tB = await send(convA, 'second question')
      await waitFor(() => phoneA.events.find((e) => e.event === 'queued' && e.data.turnId === tB), 30_000, "B's queued")

      // C, another conversation of the same agent, starts at once (N2). Held
      // behind B it would start only at the give-up, about 6 s from now.
      const cSentAt = Date.now()
      const tC = await send(convC, 'a question on another conversation')
      const cStart = await waitFor(() => phoneC.events.find((e) => e.event === 'message-start' && e.data.turnId === tC), 30_000, "C's start")
      expect(cStart.at - cSentAt).toBeLessThan(2_500)
      const cEnd = await waitFor(() => phoneC.events.find((e) => e.event === 'message-end' && e.data.turnId === tC), 60_000, "C's answer")
      expect(String(cEnd.data.fullText)).toContain('a question on another conversation')

      // A stays quiet for a second window: the late watch gives up (N1). B must
      // get its OWN answer, never A's.
      const bEnd = await waitFor(() => phoneA.events.find((e) => e.event === 'message-end' && e.data.turnId === tB), 90_000, "B's answer")
      expect(String(bEnd.data.fullText)).toContain('second question')
      expect(String(bEnd.data.fullText)).not.toContain('first question')
      expect(cEnd.at).toBeLessThan(bEnd.at)

      const stored = await waitFor(() => {
        const r = rows(convA)
        return r.filter((x) => x.role === 'assistant').length >= 2 ? r : undefined
      }, 30_000, 'the rows of conversation A')
      expect(stored.filter((r) => r.role === 'user').map((r) => r.text)).toEqual(['slow:20000 first question', 'second question'])
      const answers = stored.filter((r) => r.role === 'assistant')
      expect(answers).toHaveLength(2)
      expect(answers[0]).toMatchObject({ text: '[Error: The main AI stopped responding on this turn.]', source: 'agent-error' })
      expect(answers[1]!.text).toContain('second question')
      expect(answers.some((r) => r.text.includes('first question'))).toBe(false)
      // A's own answer was cut short by the interrupt: it never arrived anywhere.
      expect(phoneA.events.some((e) => e.event === 'message-late')).toBe(false)
    } finally {
      phoneA.close()
      phoneC.close()
    }
  }, 180_000)
})
