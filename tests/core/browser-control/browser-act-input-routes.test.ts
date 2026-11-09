/**
 * The agent's act route (src/web/routes/browser-v1.ts, core/browser-control/act-args.ts) for the
 * input agents got from the old relay, over a real hub with the browser faked at the hub: what
 * reaches the extension for drag, zoom, click_label (sent as a click on its label), text
 * all_frames, type slowly and dialog read, each argument checked and cut to size. And the op's
 * own answers (src/ops/browser.ts): its schema names the new actions and fields, a zoom's image
 * stays out of a result that did not ask for it, and a step that opened a dialog says so.
 * Fake data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-browser-act-input-routes'))

import express from 'express'
import { browserV1Router, _resetBrowserRoutesForTesting } from '../../../src/web/routes/browser-v1.js'
import * as h from '../../../src/core/browser-control/hub.js'
import { cleanArgs } from '../../../src/core/browser-control/act-args.js'
import { getOp, opInputJsonSchema } from '../../../src/ops/index.js'

const A = { device: 'extension-input', label: 'Browser A', browser: 'chrome', version: '9.9', caps: ['screenshot', 'trusted-input'] }
const AGENT = { 'x-walnut-caller-kind': 'agent' }
let server: Server
let base = ''
let timer: ReturnType<typeof setInterval> | undefined
let seen: Array<{ action: string; args: Record<string, unknown> }> = []

async function act(body: Record<string, unknown>) {
  const r = await fetch(`${base}/browser/act`, { method: 'POST', headers: { 'content-type': 'application/json', ...AGENT }, body: JSON.stringify({ device: A.device, tab: 43, ...body }) })
  return { status: r.status, body: await r.json() as Record<string, any> }
}
const last = () => seen[seen.length - 1]

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', browserV1Router)
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
}, 60_000)

afterAll(async () => {
  if (timer) clearInterval(timer)
  h._resetBrowserHubForTesting()
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(async () => {
  if (timer) clearInterval(timer)
  h._resetBrowserHubForTesting()
  _resetBrowserRoutesForTesting()
  seen = []
  await h.poll(A, 0)
  h.ownTab(A.device, 43, 'agent', { url: 'https://shop.example.test/board' })
  timer = setInterval(async () => {
    for (const cmd of await h.poll(A, 0)) {
      seen.push({ action: cmd.action, args: cmd.args })
      h.answer(A.device, cmd.id, true, { tab: 43, url: 'https://shop.example.test/board', echo: cmd.action })
    }
  }, 10)
})

describe('what reaches the extension', () => {
  it('click_label goes as a click on that label', async () => {
    const r = await act({ action: 'click_label', label: 5 })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(last()).toMatchObject({ action: 'click', args: { label: 5, tab: 43 } })
  })

  it('click_label without a whole number is refused before the browser', async () => {
    for (const label of [undefined, 0, 2.5, '3']) {
      const r = await act({ action: 'click_label', ...(label !== undefined ? { label } : {}) })
      expect(r.status).toBe(400)
      expect(r.body.code).toBe('bad_request')
    }
    expect(seen).toEqual([])
  })

  it('drag carries both ends and its steps, held to 2 to 50', async () => {
    expect((await act({ action: 'drag', ref: 'e3', to_ref: 'e9', steps: 99 })).status).toBe(200)
    expect(last()).toMatchObject({ action: 'drag', args: { ref: 'e3', to_ref: 'e9', steps: 50 } })
    await act({ action: 'drag', x: 10, y: 20, to_x: 30.5, to_y: 40 })
    expect(last()).toMatchObject({ action: 'drag', args: { x: 10, y: 20, to_x: 30.5, to_y: 40 } })
  })

  it('zoom carries its region; text all_frames, type slowly and dialog read their switches', async () => {
    await act({ action: 'zoom', x: 1, y: 2, width: 30, height: 20 })
    expect(last()).toMatchObject({ action: 'zoom', args: { x: 1, y: 2, width: 30, height: 20 } })
    await act({ action: 'text', all_frames: true })
    expect(last()).toMatchObject({ action: 'text', args: { all_frames: true } })
    await act({ action: 'type', x: 5, y: 6, text: 'abc', slowly: true, trusted: true })
    expect(last()).toMatchObject({ action: 'type', args: { x: 5, y: 6, text: 'abc', slowly: true, trusted: true } })
    await act({ action: 'dialog', read: true })
    expect(last()).toMatchObject({ action: 'dialog', args: { read: true } })
    await act({ action: 'screenshot', annotate: true })
    expect(last()).toMatchObject({ action: 'screenshot', args: { annotate: true } })
  })
})

describe('act-args', () => {
  it('keeps the new keys of the right type only', () => {
    expect(cleanArgs({ action: 'drag', to_ref: 'e9'.padEnd(80, '9'), to_x: 'far', to_y: 4, steps: 1 })).toEqual({ to_ref: 'e9'.padEnd(40, '9'), to_y: 4, steps: 2 })
    expect(cleanArgs({ action: 'text', all_frames: 'yes', annotate: 1, slowly: true, read: false })).toEqual({ slowly: true, read: false })
    expect(cleanArgs({ action: 'click', label: 2.5 })).toEqual({})
    expect(cleanArgs({ action: 'click', label: 1001 })).toEqual({})
    expect(cleanArgs({ action: 'click', label: 12 })).toEqual({ label: 12 })
  })
})

describe('the browser op', () => {
  const op = () => getOp('browser')!
  const map = (args: Record<string, unknown>, body: Record<string, unknown>) => op().mapResult!({ args, body }) as Record<string, any>

  it('names the new actions and fields in its schema', () => {
    const schema = opInputJsonSchema(op()) as { properties: Record<string, { enum?: string[] }> }
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining(['drag', 'zoom', 'click_label']))
    for (const k of ['to_ref', 'to_x', 'to_y', 'steps', 'label', 'annotate', 'all_frames', 'slowly', 'read']) expect(schema.properties[k], k).toBeDefined()
    expect(op().description).toMatch(/drag \{ref or x, y; to_ref or to_x, to_y/)
    expect(op().description).toMatch(/click_label \{label\}/)
  })

  it('a zoom\'s picture stays out of a result that did not ask for it inline', () => {
    const body = { image: 'data:image/png;base64,AAAA', pixels: { width: 200, height: 100 }, tab: 43 }
    expect(map({ action: 'zoom' }, body).image).toBeUndefined()
    expect(map({ action: 'zoom', inline: true }, body).image).toBe(body.image)
    expect(map({ action: 'zoom' }, body).outcome).toContain('200x100 pixels')
  })

  it('an annotated screenshot names its labels; a dialog read says what is open', () => {
    expect(map({ action: 'screenshot', annotate: true }, { labels: [{ label: 1, ref: 'e2' }], tab: 43 }).next).toMatch(/click_label/)
    const d = map({ action: 'dialog', read: true }, { open: true, dialog: { type: 'prompt', message: 'New name?', default_prompt: 'Untitled' }, tab: 43 })
    expect(d.outcome).toContain('A prompt is open')
    expect(d.next).toMatch(/text/)
    expect(map({ action: 'dialog', read: true }, { open: false, note: 'No dialog Walnut saw open.' }).next).toBe('No dialog Walnut saw open.')
  })

  it('a click that opened a dialog, and a drag, say so', () => {
    const c = map({ action: 'click', trusted: true }, { clicked: 'button', dialog: { type: 'confirm', message: 'Delete it?' }, tab: 43 })
    expect(c.outcome).toContain('It opened a confirm: "Delete it?"')
    expect(c.next).toMatch(/dialog accept/)
    expect(map({ action: 'drag' }, { dragged: 'a to b', native: true, tab: 43 }).outcome).toContain('Dragged a to b (the page\'s own drag and drop)')
    expect(map({ action: 'click' }, { clicked: 'x', matched: { ref: 'f3:e2', of: 2 }, tab: 43 }).outcome).toContain('the best of 2 match(es), f3:e2')
  })
})
