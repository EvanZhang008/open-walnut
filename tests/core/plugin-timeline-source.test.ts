/**
 * A plugin adds a source to the day timeline through `walnut.registry.timelineSource`,
 * and its segments show up in the timeline answer, with the host's rules applied:
 * the id is namespaced, the priority is capped below what the Mac measures, junk
 * is dropped, a late source is reported instead of failing the answer, and the
 * handle (or the plugin's teardown) withdraws it. Also: a plugin op that answers
 * JSON TEXT reaches every caller as an object (the calendar_query `value` papercut).
 */
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('plugin-timeline-source-test'))
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config-manager.js')>()
  return {
    ...actual,
    getConfig: vi.fn(async () => ({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, provider: { type: 'bedrock' }, plugins: {} })),
    updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { removePluginOps } from '../../src/ops/registry.js'
import { pluginOpName } from '../../src/core/plugins/ids.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { callPluginOp, createServerPluginApi, structuredOpResult } from '../../src/core/plugins/server-api.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../src/core/peers/peer-throttle.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { buildTimeline } from '../../src/core/time-tracking/timeline/build.js'
import { clearTimelineSources, listTimelineSources, registerTimelineSource } from '../../src/core/time-tracking/timeline/registry.js'
import type { TimelineRange } from '../../src/core/time-tracking/timeline/types.js'
import { DEFAULT_WORK_HOURS } from '../../src/core/time-tracking/work-hours.js'
import { systemTz } from '../../src/core/health/day-key.js'
import { createTestPluginApi } from './plugin-test-utils.js'

const logger: PluginLogger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  child: vi.fn(() => logger),
}

const MON = '2026-10-05'
const at = (h: number, m = 0): string => new Date(2026, 9, 5, h, m).toISOString()
const END_OF_DAY = new Date(2026, 9, 6).getTime()
const contexts: PluginContext[] = []
const owners = new Set<string>()

function pluginApi(pluginId: string) {
  owners.add(pluginId)
  const context = new PluginContext({ id: pluginId, dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId), logger })
  contexts.push(context)
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginId })
  const api = createServerPluginApi({ context, pluginName: pluginId, legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry() })
  return { context, api }
}

const timeline = (sourceTimeoutMs?: number) =>
  buildTimeline(MON, MON, { workHours: DEFAULT_WORK_HOURS, workHoursSource: 'default', tz: systemTz(), nowMs: END_OF_DAY, ...(sourceTimeoutMs ? { sourceTimeoutMs } : {}) })

beforeEach(() => clearTimelineSources())
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  for (const owner of owners) removePluginOps(owner)
  owners.clear()
  clearTimelineSources()
})

describe('walnut.registry.timelineSource', () => {
  it("puts a fake plugin's segments on the timeline, namespaced, capped, and cleaned", async () => {
    const { api } = pluginApi('drive-log')
    let seen: TimelineRange | undefined
    api.registry.timelineSource({
      id: 'drives',
      label: 'Car trips',
      lane: 'activity',
      priority: 500,
      async segments(range) {
        seen = range
        return {
          segments: [
            { start: at(8), end: at(8, 40), kind: 'drive', label: 'Drive to work', confidence: 'measured', detail: { km: 12, raw: { lat: 1 } as never } },
            { start: at(9), end: at(8), kind: 'drive', label: 'backwards', confidence: 'measured' },
            { start: at(9), end: at(9, 30), kind: '', label: 'no kind', confidence: 'measured' },
            { start: 'not a date', end: at(9), kind: 'drive', label: 'junk', confidence: 'measured' },
          ],
          coverage: { available: true, note: 'from the car app' },
        }
      },
    })
    const answer = await timeline()
    expect(seen).toMatchObject({ from: MON, to: MON })
    expect(answer.sources).toEqual([expect.objectContaining({
      id: 'drive-log:drives', owner: 'drive-log', label: 'Car trips', priority: 80, available: true, note: 'from the car app', segments: 1,
    })])
    const drive = answer.days[0]!.blocks.find((b) => b.kind === 'drive')
    expect(drive).toMatchObject({ label: 'Drive to work', min: 40, source: 'drive-log:drives', confidence: 'measured', detail: { km: 12 } })
    expect(answer.days[0]!.summary.wholeDay).toMatchObject({ driveMin: 40 })
  })

  it('never outranks what the Mac measured: Walnut attention keeps its minutes inside a plugin segment', async () => {
    registerTimelineSource('core', {
      id: 'walnut', label: 'Walnut', lane: 'activity', priority: 100,
      segments: async () => ({ segments: [{ start: at(8, 10), end: at(8, 20), kind: 'walnut', label: 'Marina checklist', confidence: 'measured' }] }),
    })
    pluginApi('drive-log').api.registry.timelineSource({
      id: 'drives', label: 'Car trips', lane: 'activity', priority: 80,
      segments: async () => ({ segments: [{ start: at(8), end: at(8, 40), kind: 'drive', label: 'Drive', confidence: 'measured' }] }),
    })
    const blocks = (await timeline()).days[0]!.blocks.filter((b) => b.kind !== 'gap')
    expect(blocks.map((b) => [b.kind, b.min])).toEqual([['drive', 10], ['screen', 10], ['drive', 20]])
  })

  it('reports a source that is late or throws, and still answers with the rest', async () => {
    const { api } = pluginApi('slowpoke')
    api.registry.timelineSource({ id: 'never', label: 'Never answers', lane: 'activity', segments: () => new Promise(() => {}) })
    api.registry.timelineSource({ id: 'broken', label: 'Throws', lane: 'place', segments: async () => { throw new Error('car offline') } })
    const answer = await timeline(50)
    const byId = Object.fromEntries(answer.sources.map((s) => [s.id, s]))
    expect(byId['slowpoke:never']).toMatchObject({ available: false, segments: 0 })
    expect(byId['slowpoke:never']!.note).toMatch(/did not answer/)
    expect(byId['slowpoke:broken']).toMatchObject({ available: false, note: 'failed: car offline' })
    expect(answer.days).toHaveLength(1)
  })

  it('withdraws on dispose and on plugin teardown; one id is never registered twice', async () => {
    const first = pluginApi('drive-log')
    const spec = { id: 'drives', label: 'Car trips', lane: 'activity' as const, segments: async () => ({ segments: [] }) }
    const handle = first.api.registry.timelineSource(spec)
    expect(() => first.api.registry.timelineSource(spec)).toThrow(/already registered by drive-log/)
    handle.dispose()
    expect(listTimelineSources()).toEqual([])
    first.api.registry.timelineSource(spec)
    expect(listTimelineSources().map((s) => s.spec.id)).toEqual(['drive-log:drives'])
    await first.context.dispose()
    expect(listTimelineSources()).toEqual([])
  })

  it('a plugin cannot take a core id, and the calendar bridge steps aside for the calendar plugin', async () => {
    registerTimelineSource('core', { id: 'calendar', label: 'Calendar (bridge)', lane: 'activity', priority: 50, segments: async () => ({ segments: [] }) }, { replaceableByOwner: 'calendar' })
    expect(listTimelineSources().map((s) => s.spec.id)).toEqual(['calendar'])
    const { api } = pluginApi('calendar')
    const own = api.registry.timelineSource({ id: 'events', label: 'Calendar', lane: 'activity', segments: async () => ({ segments: [] }) })
    expect(listTimelineSources().map((s) => s.spec.id)).toEqual(['calendar:events'])
    own.dispose()
    expect(listTimelineSources().map((s) => s.spec.id)).toEqual(['calendar'])
    expect(() => registerTimelineSource('some-plugin', { id: 'calendar', label: 'Fake', lane: 'activity', segments: async () => ({ segments: [] }) }))
      .toThrow(/already registered by core/)
  })

  it('refuses a malformed spec with a sentence', () => {
    const { api } = pluginApi('drive-log')
    expect(() => api.registry.timelineSource({ id: 'x', label: 'X', lane: 'sideways' as never, segments: async () => ({ segments: [] }) })).toThrow(/lane must be activity or place/)
    expect(() => api.registry.timelineSource({ id: 'x', label: '', lane: 'activity', segments: async () => ({ segments: [] }) })).toThrow(/label is required/)
  })
})

describe('plugin op answers', () => {
  it('JSON text becomes the object; prose stays text', () => {
    expect(structuredOpResult('{"status":"ok","n":2}')).toEqual({ status: 'ok', n: 2 })
    expect(structuredOpResult(' [1, 2] ')).toEqual([1, 2])
    expect(structuredOpResult('{not json}')).toBe('{not json}')
    expect(structuredOpResult('Sent.')).toBe('Sent.')
    expect(structuredOpResult({ a: 1 })).toEqual({ a: 1 })
  })

  it('a plugin op that returns JSON text answers an object in-process and over the gateway', async () => {
    const { api } = pluginApi('cal-fake')
    api.registry.op({
      name: 'query', title: 'Query', description: 'Answer like a model tool does.', readonly: true,
      handler: async () => JSON.stringify({ status: 'ok', events: [{ title: 'Standup' }] }, null, 2),
    })
    const name = pluginOpName('cal-fake', 'query')
    const local = await callPluginOp('cal-fake', name, {}, LOCAL_ORIGIN)
    expect(local).toEqual({ ok: true, result: { status: 'ok', events: [{ title: 'Standup' }] } })
    const gateway = await handleGatewayCapability('tools.call', 'a1b2c3d4-1111-2222-3333-444455556666', { name, args: {} }, 'devbox', { throttle: new PeerThrottle(), cloudMode: false })
    expect(gateway).toEqual({ ok: true, result: { status: 'ok', events: [{ title: 'Standup' }] } })
  })
})
