/**
 * `open-walnut doctor` end to end: a real server on port 0, its real probes
 * (login shell, claude preflight, SQLite, the terminal's dtach), and the real
 * CLI command reading it over HTTP. Only the answer's shape is pinned; what
 * this machine has installed is its own business.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-doctor-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { runDoctor } from '../../src/commands/doctor.js'

let server: HttpServer
let port: number
const previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH

beforeAll(async () => {
  process.env.WALNUT_DISABLE_SEARCH = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  if (previousDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH
  else process.env.WALNUT_DISABLE_SEARCH = previousDisableSearch
})

describe('GET /api/diagnostics on a real server', () => {
  it('reports this server and this machine as JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics?redact=0`)
    expect(res.status).toBe(200)
    const r = await res.json() as {
      collector: string; server: { port: number; pid: number; dataDir: string }
      local: { sqliteOk: boolean | null; processPath: { count: number } }; config: { searchDisabled: boolean } | null
      hosts: unknown[]; warnings: string[]
    }
    expect(r.collector).toBe('server')
    expect(r.server).toMatchObject({ port, pid: process.pid, dataDir: WALNUT_HOME })
    expect(r.local.sqliteOk).toBe(true)
    expect(r.local.processPath.count).toBeGreaterThan(0)
    expect(r.config?.searchDisabled).toBe(true)
    expect(Array.isArray(r.hosts)).toBe(true)
    expect(Array.isArray(r.warnings)).toBe(true)
  }, 30_000)

  it('serves the redacted text block, and the CLI prints exactly that block', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics?format=text`)
    const text = await res.text()
    expect(text.startsWith('Open Walnut doctor (server, ')).toBe(true)
    expect(text).toContain(`port ${port}`)
    expect(text).toContain('sqlite     ok')
    const user = os.userInfo().username
    if (user.length > 2) expect(text).not.toContain(`/Users/${user}/`)

    const out: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true })
    const prev = process.env.OPEN_WALNUT_API_URL
    process.env.OPEN_WALNUT_API_URL = `http://127.0.0.1:${port}`
    try {
      await runDoctor({}, { json: false })
    } finally {
      write.mockRestore()
      if (prev === undefined) delete process.env.OPEN_WALNUT_API_URL
      else process.env.OPEN_WALNUT_API_URL = prev
    }
    const printed = out.join('')
    expect(printed.startsWith('Open Walnut doctor (server, ')).toBe(true)
    expect(printed).toContain(`port ${port}`)
    expect(process.exitCode ?? 0).toBe(0)
  }, 30_000)

  // Review round 1, items 2 and 4 end to end: a planted token and a planted user name.
  it('never prints a planted token, and masks a planted user name outside any home path', async () => {
    const FAKE_USER = 'zqplantedperson'
    const FAKE_KEY = 'sk-ant-PLANTEDE2EKEYPLANTEDE2EKEY0123'
    const saved = { USER: process.env.USER, PATH: process.env.PATH, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
    process.env.USER = FAKE_USER
    process.env.ANTHROPIC_API_KEY = FAKE_KEY
    process.env.PATH = `/opt/${FAKE_USER}/bin:/opt/${FAKE_KEY}/bin:${saved.PATH ?? ''}`
    try {
      const text = await (await fetch(`http://127.0.0.1:${port}/api/diagnostics?format=text`)).text()
      const json = await (await fetch(`http://127.0.0.1:${port}/api/diagnostics`)).text()
      const raw = await (await fetch(`http://127.0.0.1:${port}/api/diagnostics?redact=0`)).text()
      for (const out of [text, json, raw]) expect(out).not.toContain(FAKE_KEY)
      for (const out of [text, json]) expect(out).not.toContain(FAKE_USER)
      expect(text).toContain('/opt/\u2026/bin')
      // The raw form keeps names (it is for this machine's own terminal), which proves the planted segment was reported.
      expect(raw).toContain(`/opt/${FAKE_USER}/bin`)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }, 30_000)
})
