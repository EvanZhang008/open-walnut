/**
 * Through a REAL server just after it started: a request a page says was rejected before it
 * reached the server is named by the route it would take, never "unknown request" (2026-11-22:
 * right after a restart every page request rejected in the connection queue read "GET unknown
 * request rejected in the page", because only templates answered since the boot were known).
 * This proves the wiring in server.ts (the app's own router asked through resolveWith).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-page-error-route-name'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { answeredTemplates } from '../../src/core/usage-watch/record.js'
import { pageErrorKind } from '../../src/core/usage-watch/normalize.js'

let server: HttpServer

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
}, 120_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
}, 60_000)

describe('a page request the server never answered', () => {
  it('is named by the route the server would take', () => {
    expect(server.listening).toBe(true)
    const line = (url: string) => `[api] GET ${url} rejected after 20000ms in the connection queue (pool saturated)`
    expect(pageErrorKind(line('/api/v1/tasks/mvm0n3bu-6910/threads'), '', answeredTemplates)?.kind).toBe('GET /api/v1/tasks/:id/threads rejected in the page')
    expect(pageErrorKind(line('/api/routines/mwo4xvsv-ec9a'), '', answeredTemplates)?.kind).toMatch(/^GET \/api\/routines\/:\w+ rejected in the page$/)
    expect(pageErrorKind(line('/api/no-such-thing/x'), '', answeredTemplates)?.kind).toBe('GET unknown request rejected in the page')
  })
})
