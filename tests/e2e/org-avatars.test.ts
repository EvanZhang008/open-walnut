/**
 * The Org avatars' routes on a real server (src/web/routes/org-avatars-v1.ts):
 *   - PUT /api/v1/org/avatars/:id sets a preset, an SVG or an image, refuses a picture that could
 *     run or load, and `reset` brings the default back; an agent's write names it;
 *   - GET /api/v1/org/avatars/:id.png is the PNG of what the Org page shows (a chosen avatar, else
 *     the default), with no setting to turn on;
 *   - POST /api/v1/org/avatars/draw answers three SVGs from the model's reply.
 * Only the model call is replaced (no provider is configured in a test home).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-org-avatars'))

const drawn = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#dbeafe"/><circle cx="50" cy="60" r="30" fill="#60a5fa"/></svg>'
const modelCalls: Array<{ system: unknown; messages: unknown }> = []
vi.mock('../../src/model/model.js', async (orig) => ({
  ...(await orig<typeof import('../../src/model/model.js')>()),
  sendMessage: vi.fn(async (opts: { system: unknown; messages: unknown }) => {
    modelCalls.push(opts)
    return { content: [{ type: 'text', text: `${drawn}\n${drawn.replace('#60a5fa', '#f472b6')}\n${drawn.replace('#60a5fa', '#4ade80')}` }], stopReason: 'end_turn' }
  }),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask } from '../../src/core/task-manager.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { __setSharpForTests } from '../../src/utils/image-compress.js'

let base = ''
let leadId = ''
let taskId = ''

const put = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/org/avatars/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const png = (id: string) => fetch(`${base}/api/v1/org/avatars/${id}.png?size=64`)

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  __setSharpForTests(sharp as never)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  taskId = (await addTask({ title: 'Watch the nightly pipeline', project: 'Garden' })).task.id
  leadId = (await ensureProjectLead('Garden')).id
}, 60_000)

afterAll(async () => {
  __setSharpForTests(undefined)
  await stopServer()
})

describe('org avatars', () => {
  it('sets a preset, an SVG and an image; refuses what could run; reset clears it', async () => {
    let res = await put(leadId, { preset: 'sailor:1' })
    expect(res.status).toBe(200)
    expect((await getTask(leadId)).org_avatar).toMatchObject({ preset: 'sailor:1', by: 'human' })

    res = await put(leadId, { svg: drawn })
    expect(res.status).toBe(200)
    expect((await getTask(leadId)).org_avatar?.svg).toBe(drawn)

    res = await put(taskId, { image: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(res.status).toBe(200)

    for (const bad of [{ svg: '<svg viewBox="0 0 1 1"><script>x</script></svg>' }, { preset: 'dragon:1' }, { image: 'data:text/html;base64,PGI+' }, {}]) {
      res = await put(leadId, bad)
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
    expect((await getTask(leadId)).org_avatar?.svg).toBe(drawn)

    res = await put(taskId, { reset: true })
    expect(res.status).toBe(200)
    expect((await getTask(taskId)).org_avatar ?? null).toBeNull()

    res = await put('no-such-task', { preset: 'owl:8' })
    expect(res.status).toBe(404)
  })

  it('the phone PNG shows what the Org page shows, on a fresh install', async () => {
    let res = await png(leadId)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/image\/png/)
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata()
    expect([meta.width, meta.height]).toEqual([64, 64])
    // A task with no avatar of its own gets its default.
    res = await png(taskId)
    expect(res.status).toBe(200)
    expect((await png('nope')).status).toBe(404)
  })

  it('draws three avatars from the model, saving nothing', async () => {
    const res = await fetch(`${base}/api/v1/org/avatars/draw`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a seal in a hard hat', name: 'Garden VP', taskId: leadId }),
    })
    expect(res.status).toBe(200)
    const { svgs } = await res.json() as { svgs: string[] }
    expect(svgs).toHaveLength(3)
    expect(JSON.stringify(modelCalls.at(-1)?.messages)).toContain('a seal in a hard hat')
    expect((await getTask(leadId)).org_avatar?.svg).toBe(drawn)
    const empty = await fetch(`${base}/api/v1/org/avatars/draw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(empty.status).toBe(400)
  })
})
