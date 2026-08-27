/**
 * POST /api/v1/tasks — create-time pin tier on the frozen mobile contract
 * (2026-08-27, additive).
 *
 * The field name and value set are IDENTICAL to POST /api/tasks (`focus_tier`,
 * built-ins + a registered ct_* id, '' = not specified) — the iOS app's tier
 * picker and the web console's must not have to speak two dialects. Error shape
 * follows this router's frozen envelope: { error: { code: 'bad_request',
 * message } }.
 *
 * Real startServer({ port: 0, dev: true }), same harness as
 * api-v1-task-create.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-tiercreate'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'

let server: HttpServer
let port: number

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
}

async function postTask(body: unknown): Promise<Response> {
  return fetch(apiUrl('/api/v1/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The tier split the focus surface serves. */
async function split(): Promise<Record<string, any>> {
  const res = await fetch(apiUrl('/api/focus/tasks'))
  expect(res.status).toBe(200)
  return res.json() as Promise<Record<string, any>>
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('POST /api/v1/tasks — focus_tier', () => {
  it('lands the task in the named built-in tier in ONE request', async () => {
    const res = await postTask({ title: 'Phone-picked Focus', focus_tier: 'focus' })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: Record<string, unknown> }
    // The slim projection carries focus_tier only on a pinned row with a stored
    // tier — see projectTask — so this IS the mobile-visible answer.
    expect(task.pinned).toBe(true)
    expect(task.focus_tier).toBe('focus')
    expect(typeof task.pin_order).toBe('number')

    expect((await split()).focus_tasks).toContain(task.id)
  })

  it('normalizes satellite to pinned with NO focus_tier in the projection', async () => {
    const res = await postTask({ title: 'Phone-picked Satellite', focus_tier: 'satellite' })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: Record<string, unknown> }
    expect(task.pinned).toBe(true)
    // The literal string never reaches the row, so the projection omits the key
    // entirely — exactly what an omitted-tier create returns.
    expect(task).not.toHaveProperty('focus_tier')
    expect((await split()).satellite_tasks).toContain(task.id)
  })

  it('pins from the tier alone', async () => {
    const res = await postTask({ title: 'Phone-picked Wait', focus_tier: 'wait' })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: Record<string, unknown> }
    expect(task.pinned).toBe(true)
    expect((await split()).wait_tasks).toContain(task.id)
  })

  it('400 bad_request for an unknown tier — never a silent Satellite', async () => {
    const res = await postTask({ title: 'Bad tier', focus_tier: 'urgent' })
    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code: string; message: string } }
    expect(json.error.code).toBe('bad_request')
    expect(json.error.message).toContain('unknown focus_tier')
    // The message enumerates the valid set so the app can recover in one trip.
    expect(json.error.message).toContain('satellite')
  })

  it('400 bad_request for a non-string focus_tier', async () => {
    // null is NOT here: like the date fields, it means "not specified" so a
    // client can send the whole create shape unconditionally.
    for (const value of [7, {}, ['focus'], true]) {
      const res = await postTask({ title: 'Type check', focus_tier: value })
      expect(res.status).toBe(400)
      const json = await res.json() as { error: { code: string; message: string } }
      expect(json.error.code).toBe('bad_request')
      expect(json.error.message).toContain('focus_tier')
    }
  })

  it('400 bad_request for pinned:false + a tier', async () => {
    const res = await postTask({ title: 'Contradiction', pinned: false, focus_tier: 'focus' })
    expect(res.status).toBe(400)
    const json = await res.json() as { error: { code: string; message: string } }
    expect(json.error.code).toBe('bad_request')
    expect(json.error.message).toMatch(/contradicts pinned: false/)
  })

  it('accepts a registered ct_* and rejects a bogus one', async () => {
    const made = await fetch(apiUrl('/api/focus/tiers'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Household' }),
    })
    expect(made.status).toBe(200)
    const { tier } = await made.json() as { tier: { id: string } }

    const ok = await postTask({ title: 'Custom tier from phone', focus_tier: tier.id })
    expect(ok.status).toBe(201)
    const { task } = await ok.json() as { task: Record<string, unknown> }
    expect(task.focus_tier).toBe(tier.id)
    expect((await split()).custom_tier_tasks[tier.id]).toContain(task.id)

    const bad = await postTask({ title: 'Ghost tier', focus_tier: 'ct_notreal1' })
    expect(bad.status).toBe(400)
    const json = await bad.json() as { error: { code: string; message: string } }
    expect(json.error.message).toContain('unknown focus_tier')
    expect(json.error.message).toContain(tier.id)
  })

  it('an empty / null focus_tier reads as "not specified", not as a bad value', async () => {
    // The shape a client sends when its picker was never touched.
    for (const value of ['', '   ', null]) {
      const res = await postTask({ title: 'Untouched picker', focus_tier: value })
      expect(res.status, JSON.stringify(value)).toBe(201)
      const { task } = await res.json() as { task: Record<string, unknown> }
      expect(task.pinned).toBe(true)
      expect(task).not.toHaveProperty('focus_tier')
    }
  })

  it('omitting focus_tier keeps the existing board default exactly', async () => {
    // No-regression guard for every existing caller (iOS build < the tier UI,
    // `walnut add`, the task_create op).
    const res = await postTask({ title: 'No tier named' })
    expect(res.status).toBe(201)
    const { task } = await res.json() as { task: Record<string, unknown> }
    expect(task.pinned).toBe(true)
    expect(task).not.toHaveProperty('focus_tier')
    expect((await split()).satellite_tasks).toContain(task.id)

    const off = await postTask({ title: 'Off the board', pinned: false })
    expect(off.status).toBe(201)
    const { task: unpinned } = await off.json() as { task: Record<string, unknown> }
    expect(unpinned.pinned).toBeUndefined()
    expect((await split()).pinned_tasks).not.toContain(unpinned.id)
  })
})
