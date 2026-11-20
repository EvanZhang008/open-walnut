/**
 * Topics on an ephemeral server (A2, 2026-11-20 acceptance: dev:ephemeral never captured a reply,
 * so the feature could not be tried there). With the experiment on, a real server started as an
 * ephemeral one runs the topics services: the reply capture listens for turn ends and the mail
 * bridge for arrivals. Its mail is held (topic-mail.test.ts, "a test or ephemeral server sends no
 * mail").
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-topics-ephemeral', { IS_EPHEMERAL: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus } from '../../../src/core/event-bus.js'
import { topicMailListening } from '../../../src/core/topics/topic-mail-port.js'

let server: Server

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await updateConfig({ experimental: { topics: true } } as never)
  server = await startServer({ port: 0, dev: true })
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('an ephemeral server with topics on', () => {
  it('runs the reply capture and the mail bridge', async () => {
    expect(server.listening).toBe(true)
    const subscribers = (bus as unknown as { subscribers: Map<string, unknown> }).subscribers
    await vi.waitFor(() => expect(subscribers.has('topic-replies')).toBe(true), { timeout: 15_000 })
    await vi.waitFor(() => expect(topicMailListening()).toBe(true), { timeout: 15_000 })
  })
})
