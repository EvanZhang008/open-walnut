import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readRouterAreas, updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js'
import {
  confirmRouterIncoming, confirmedRouteRule, pendingRuleAreas, readPendingRuleMatches, routerAreaRules, routerRuleRevision,
  routerRulesView, ruleBindingsRevision, saveRouterRuleBindings, RouterRuleError, type RouterRuleTarget, type RouterRulesDeps,
} from '../../src/core/router/rules.js'
import { setRoutingRule, type RoutingRuleAuthor } from '../../src/core/triage/routing-rules.js'
import type { RouterItem, RouterSource } from '../../src/core/router/types.js'
import { seedTaskStore } from '../helpers/router-task-store.js'

const PERSON: RoutingRuleAuthor = { by: 'human' }
const SHARED = 'desk@marina.example.invalid'
const mail = (message: string, version = `v-${message}`): RouterSource => ({ kind: 'mail', account: SHARED, message, version })

let home: string
let targets: Map<string, RouterRuleTarget>
let cache: Map<string, RouterItem>
let replaced: Set<string>

const resolve = vi.fn(async (source: RouterSource): Promise<RouterItem> => {
  const item = cache.get(source.message)
  if (!item) throw Object.assign(new Error('missing'), { code: 'source_missing' })
  if (source.version !== item.source.version) throw Object.assign(new Error('changed'), { code: 'source_changed' })
  return item
})
const current = vi.fn(async (sources: readonly RouterSource[]) => sources.filter((one) => !replaced.has(one.message)))
const deps = (extra: RouterRulesDeps = {}): RouterRulesDeps => ({
  targets: async (ids) => new Map(ids.flatMap((id) => targets.has(id) ? [[id, targets.get(id)!] as const] : [])),
  resolve, current, now: () => 1_000, ...extra,
})

function cached(message: string, sender: string, subject: string, rfc = `rfc-${message}`): RouterSource {
  const source = mail(message)
  cache.set(message, { source, key: `key-${message}`, scopeKey: rfc, sender, subject })
  return source
}

function baseAreas(): RouterAreasFile {
  return {
    version: 1,
    areas: [
      { id: 'personal', name: 'Personal', host: '__local__', taskIds: ['task-p'], sources: [] },
      { id: 'work', name: 'Work', host: '__local__', taskIds: ['task-w'], sources: [] },
    ],
    routers: [], items: [],
  }
}

async function bind(entries: Array<{ ruleId: string; areaId: string }>) {
  const view = await routerRulesView(home, deps())
  const byId = new Map(view.rules.map((rule) => [rule.id, rule.revision]))
  return saveRouterRuleBindings({
    bindings: entries.map((one) => ({ ...one, revision: byId.get(one.ruleId)! })),
    expectedRevision: view.fileRevision,
  }, home, deps())
}

async function expectRuleError(run: () => Promise<unknown>, code: string, status: number) {
  let caught: unknown
  try { await run() } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(RouterRuleError)
  expect((caught as RouterRuleError).code).toBe(code)
  expect((caught as RouterRuleError).status).toBe(status)
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-rules-'))
  seedTaskStore(home)
  targets = new Map([['task-florist', { title: 'Florist visits', open: true }], ['task-invoices', { title: 'Dock invoices', open: true }]])
  cache = new Map()
  replaced = new Set()
  resolve.mockClear(); current.mockClear()
  await updateRouterAreas(home, () => baseAreas())
})

afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('rule fingerprints', () => {
  it('changes with the match or target, not with enabled or note', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    const before = routerRuleRevision(rule)
    expect(routerRuleRevision(await setRoutingRule(home, { id: rule.id, enabled: false, note: 'quiet' }, PERSON))).toBe(before)
    expect(routerRuleRevision(await setRoutingRule(home, { id: rule.id, subject: 'pickup' }, PERSON))).not.toBe(before)
    expect(routerRuleRevision({ ...rule, taskId: 'task-invoices' })).not.toBe(before)
  })
})

describe('areas file bindings', () => {
  it('reads a file with no bindings and keeps the field out of it', async () => {
    const file = await readRouterAreas(home)
    expect(file).not.toHaveProperty('ruleBindings')
    expect(JSON.parse(fs.readFileSync(path.join(home, 'router', 'areas.json'), 'utf-8'))).not.toHaveProperty('ruleBindings')
  })

  it('refuses a binding to an unknown area or one rule bound twice', async () => {
    const revision = 'a'.repeat(64)
    await expect(updateRouterAreas(home, (file) => ({ ...file, ruleBindings: [{ ruleId: 'rr-1', revision, areaId: 'nowhere', confirmedAt: 1 }] })))
      .rejects.toMatchObject({ code: 'invalid_areas' })
    await expect(updateRouterAreas(home, (file) => ({ ...file, ruleBindings: [
      { ruleId: 'rr-1', revision, areaId: 'work', confirmedAt: 1 }, { ruleId: 'rr-1', revision, areaId: 'personal', confirmedAt: 1 },
    ] }))).rejects.toMatchObject({ code: 'invalid_areas' })
  })
})

describe('saveRouterRuleBindings', () => {
  it('stores only the id and fingerprint, and returns the full view', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    const reply = await bind([{ ruleId: rule.id, areaId: 'personal' }])
    const file = await readRouterAreas(home)
    expect(file.ruleBindings).toEqual([{ ruleId: rule.id, revision: routerRuleRevision(rule), areaId: 'personal', confirmedAt: 1_000 }])
    expect(JSON.stringify(file)).not.toContain('bakery.example.invalid')
    expect(reply.fileRevision).toBe(ruleBindingsRevision(file))
    expect(reply.rules).toEqual([expect.objectContaining({ id: rule.id, taskTitle: 'Florist visits', areaId: 'personal', confirmed: true, enabled: true })])
    expect(file.items).toEqual([])
    expect(file.areas.map((area) => area.taskIds)).toEqual([['task-p'], ['task-w']])
  })

  it('lets exactly one of two confirmations read at the same revision win', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    const view = await routerRulesView(home, deps())
    const body = (areaId: string) => ({ bindings: [{ ruleId: rule.id, revision: view.rules[0]!.revision, areaId }], expectedRevision: view.fileRevision })
    const results = await Promise.allSettled([saveRouterRuleBindings(body('personal'), home, deps()), saveRouterRuleBindings(body('work'), home, deps())])
    expect(results.filter((one) => one.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((one) => one.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toMatchObject({ code: 'rules_changed', status: 409 })
    expect((await readRouterAreas(home)).ruleBindings).toHaveLength(1)
  })

  it('refuses a stale fingerprint, a missing area and a rule bound twice', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    const view = await routerRulesView(home, deps())
    await setRoutingRule(home, { id: rule.id, subject: 'pickup' }, PERSON)
    await expectRuleError(() => saveRouterRuleBindings({ bindings: [{ ruleId: rule.id, revision: view.rules[0]!.revision, areaId: 'personal' }],
      expectedRevision: view.fileRevision }, home, deps()), 'rule_changed', 409)
    const fresh = await routerRulesView(home, deps())
    await expectRuleError(() => saveRouterRuleBindings({ bindings: [{ ruleId: rule.id, revision: fresh.rules[0]!.revision, areaId: 'nowhere' }],
      expectedRevision: fresh.fileRevision }, home, deps()), 'area_missing', 409)
    const twice = { ruleId: rule.id, revision: fresh.rules[0]!.revision, areaId: 'personal' }
    await expectRuleError(() => saveRouterRuleBindings({ bindings: [twice, { ...twice, areaId: 'work' }], expectedRevision: fresh.fileRevision }, home, deps()),
      'rule_bound_twice', 400)
    await expectRuleError(() => saveRouterRuleBindings({ bindings: [twice] }, home, deps()), 'revision_required', 400)
  })

  it('keeps an unchanged stale binding while another rule changes, and cancels or moves on request', async () => {
    const bakery = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    const dock = await setRoutingRule(home, { subject: 'invoice', taskId: 'task-invoices' }, PERSON)
    await bind([{ ruleId: bakery.id, areaId: 'personal' }])
    const staleBinding = (await readRouterAreas(home)).ruleBindings![0]!
    await setRoutingRule(home, { id: bakery.id, subject: 'pickup' }, PERSON)
    const view = await routerRulesView(home, deps())
    expect(view.rules.find((rule) => rule.id === bakery.id)).toMatchObject({ areaId: 'personal', confirmed: false })
    const dockRevision = view.rules.find((rule) => rule.id === dock.id)!.revision
    const kept = await saveRouterRuleBindings({ bindings: [...view.bindings, { ruleId: dock.id, revision: dockRevision, areaId: 'work' }],
      expectedRevision: view.fileRevision }, home, deps({ now: () => 2_000 }))
    expect(kept.bindings).toEqual([staleBinding, { ruleId: dock.id, revision: dockRevision, areaId: 'work', confirmedAt: 2_000 }])
    const moved = await saveRouterRuleBindings({ bindings: [{ ruleId: dock.id, revision: dockRevision, areaId: 'personal' }],
      expectedRevision: kept.fileRevision }, home, deps())
    expect(moved.bindings).toEqual([{ ruleId: dock.id, revision: dockRevision, areaId: 'personal', confirmedAt: 1_000 }])
    const cleared = await saveRouterRuleBindings({ bindings: [], expectedRevision: moved.fileRevision }, home, deps())
    expect(cleared.bindings).toEqual([])
    expect(await readRouterAreas(home)).not.toHaveProperty('ruleBindings')
  })
})

describe('confirmRouterIncoming', () => {
  it('confirms nothing without bindings', async () => {
    await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    expect(await confirmRouterIncoming([cached('INBOX:1:1', 'Bakery <desk@bakery.example.invalid>', 'Pickup')], home, deps())).toEqual([])
    expect((await readRouterAreas(home)).items).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('adds only the exact matching item and its account, never the rule target', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    await bind([{ ruleId: rule.id, areaId: 'personal' }])
    const hit = cached('INBOX:1:1', 'Bakery <desk@bakery.example.invalid>', 'Pickup')
    const miss = cached('INBOX:1:2', 'Pat <pat@marina.example.invalid>', 'Lunch')
    // Only the source this call wrote is answered: never the miss, nor the version-less copy of the hit.
    expect(await confirmRouterIncoming([hit, miss, { kind: 'mail', account: SHARED, message: 'INBOX:1:1' }], home, deps())).toEqual([hit])
    const file = await readRouterAreas(home)
    expect(file.items).toEqual([{ source: hit, areaId: 'personal', canonicalKey: 'rfc-INBOX:1:1' }])
    expect(file.areas[0]).toMatchObject({ taskIds: ['task-p'], sources: [{ kind: 'mail', account: SHARED }] })
    // Already listed: a second call writes nothing, so it answers nothing.
    expect(await confirmRouterIncoming([hit], home, deps())).toEqual([])
  })

  it('leaves the item unassigned when the rule is off, changed or its target is complete or gone', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    await bind([{ ruleId: rule.id, areaId: 'personal' }])
    const source = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Pickup')
    await setRoutingRule(home, { id: rule.id, enabled: false }, PERSON)
    expect(await confirmRouterIncoming([source], home, deps())).toEqual([])
    await setRoutingRule(home, { id: rule.id, enabled: true }, PERSON)
    targets.set('task-florist', { title: 'Florist visits', open: false })
    expect(await confirmRouterIncoming([source], home, deps())).toEqual([])
    targets.delete('task-florist')
    expect(await confirmRouterIncoming([source], home, deps())).toEqual([])
    targets.set('task-florist', { title: 'Florist visits', open: true })
    await setRoutingRule(home, { id: rule.id, from: 'bakery.example' }, PERSON)
    expect(await confirmRouterIncoming([source], home, deps())).toEqual([])
    expect((await readRouterAreas(home)).items).toEqual([])
  })

  it('leaves conflicting areas unassigned and picks one area when its own rules agree', async () => {
    const bakery = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    const invoice = await setRoutingRule(home, { subject: 'invoice', taskId: 'task-invoices' }, PERSON)
    await bind([{ ruleId: bakery.id, areaId: 'personal' }, { ruleId: invoice.id, areaId: 'work' }])
    const both = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Invoice for pickup')
    expect(await confirmRouterIncoming([both], home, deps())).toEqual([])
    expect((await readRouterAreas(home)).items).toEqual([])
    const view = await routerRulesView(home, deps())
    await saveRouterRuleBindings({ bindings: view.rules.map((rule) => ({ ruleId: rule.id, revision: rule.revision, areaId: 'personal' })),
      expectedRevision: view.fileRevision }, home, deps())
    expect(await confirmRouterIncoming([both], home, deps())).toEqual([both])
    expect((await readRouterAreas(home)).items).toEqual([{ source: both, areaId: 'personal', canonicalKey: 'rfc-INBOX:1:1' }])
    expect((await routerAreaRules(await readRouterAreas(home), 'personal', cache.get('INBOX:1:1')!, home, deps())).map((rule) => rule.id))
      .toEqual([bakery.id, invoice.id])
  })

  it('refuses a replaced delivery and a copy already in another area', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    await bind([{ ruleId: rule.id, areaId: 'personal' }])
    const gone = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Pickup')
    replaced.add('INBOX:1:1')
    const copy = cached('INBOX:2:9', 'desk@bakery.example.invalid', 'Pickup', 'rfc-shared')
    await updateRouterAreas(home, (file) => {
      file.areas[1]!.sources.push({ kind: 'mail', account: SHARED })
      file.items.push({ source: mail('INBOX:9:9'), areaId: 'work', canonicalKey: 'rfc-shared' })
      return file
    })
    expect(await confirmRouterIncoming([gone, copy], home, deps())).toEqual([])
    expect((await readRouterAreas(home)).items.map((item) => item.source.message)).toEqual(['INBOX:9:9'])
  })

  it('goes quiet when the bindings changed since the caller captured them', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    const captured = ruleBindingsRevision(await readRouterAreas(home))
    await bind([{ ruleId: rule.id, areaId: 'personal' }])
    expect(await confirmRouterIncoming([cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Pickup')], home, deps({ expectedBindingsRevision: captured })))
      .toEqual([])
    expect((await readRouterAreas(home)).items).toEqual([])
  })

  it('fails closed and grants nothing when the current check fails', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    await bind([{ ruleId: rule.id, areaId: 'personal' }])
    const source = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Pickup')
    await expect(confirmRouterIncoming([source], home, deps({ current: async () => { throw new Error('cache offline') } }))).rejects.toThrow('cache offline')
    expect((await readRouterAreas(home)).items).toEqual([])
  })
})

describe('confirmRouterIncoming with the bindings captured at arrival', () => {
  const snapshot = async () => (await readRouterAreas(home)).ruleBindings ?? []
  const items = async () => (await readRouterAreas(home)).items.map((one) => [one.source.message, one.areaId])
  const rules = async () => ({
    bakery: await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON),
    invoice: await setRoutingRule(home, { subject: 'invoice', taskId: 'task-invoices' }, PERSON),
  })

  it('grants under the captured binding after an unrelated binding was added, then removed', async () => {
    const { bakery, invoice } = await rules()
    await bind([{ ruleId: bakery.id, areaId: 'personal' }])
    const captured = await snapshot()
    await bind([{ ruleId: bakery.id, areaId: 'personal' }, { ruleId: invoice.id, areaId: 'work' }])
    const first = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Pickup')
    expect(await confirmRouterIncoming([first], home, deps({ expectedRuleBindings: captured }))).toEqual([first])
    expect(await items()).toEqual([['INBOX:1:1', 'personal']])

    const both = await snapshot()
    await bind([{ ruleId: bakery.id, areaId: 'personal' }])
    const second = cached('INBOX:1:2', 'desk@bakery.example.invalid', 'Pickup')
    expect(await confirmRouterIncoming([second], home, deps({ expectedRuleBindings: both }))).toEqual([second])
    expect(await items()).toEqual([['INBOX:1:1', 'personal'], ['INBOX:1:2', 'personal']])
  })

  it('a new binding of the same area that also matches adds no conflict and no authority', async () => {
    const { bakery, invoice } = await rules()
    await bind([{ ruleId: bakery.id, areaId: 'personal' }])
    const captured = await snapshot()
    await bind([{ ruleId: bakery.id, areaId: 'personal' }, { ruleId: invoice.id, areaId: 'personal' }])
    const source = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Invoice for pickup')
    expect(await confirmRouterIncoming([source], home, deps({ expectedRuleBindings: captured }))).toEqual([source])
    expect(await items()).toEqual([['INBOX:1:1', 'personal']])
  })

  it('grants nothing once the matching binding was removed, moved or confirmed again', async () => {
    const { bakery } = await rules()
    await bind([{ ruleId: bakery.id, areaId: 'personal' }])
    const captured = await snapshot()
    const source = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Pickup')
    await bind([])
    expect(await confirmRouterIncoming([source], home, deps({ expectedRuleBindings: captured }))).toEqual([])
    await bind([{ ruleId: bakery.id, areaId: 'work' }])
    expect(await confirmRouterIncoming([source], home, deps({ expectedRuleBindings: captured }))).toEqual([])
    // The same rule and area, confirmed again later: another binding than the one the arrival was captured under.
    const view = await routerRulesView(home, deps())
    await saveRouterRuleBindings({ bindings: [{ ruleId: bakery.id, revision: view.rules.find((one) => one.id === bakery.id)!.revision, areaId: 'personal' }],
      expectedRevision: view.fileRevision }, home, deps({ now: () => 5_000 }))
    expect(await confirmRouterIncoming([source], home, deps({ expectedRuleBindings: captured }))).toEqual([])
    expect(await items()).toEqual([])
  })

  it('a binding added after capture never authorizes the arrival, alone or beside an unrelated captured one', async () => {
    const { bakery, invoice } = await rules()
    const source = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Pickup')
    await bind([{ ruleId: bakery.id, areaId: 'personal' }])
    expect(await confirmRouterIncoming([source], home, deps({ expectedRuleBindings: [] }))).toEqual([])
    expect(await items()).toEqual([])

    await bind([{ ruleId: invoice.id, areaId: 'work' }])
    const unrelated = await snapshot()
    await bind([{ ruleId: invoice.id, areaId: 'work' }, { ruleId: bakery.id, areaId: 'personal' }])
    expect(await confirmRouterIncoming([source], home, deps({ expectedRuleBindings: unrelated }))).toEqual([])
    expect(await items()).toEqual([])
  })

  it('a binding of another area that now also matches is a conflict: nothing granted', async () => {
    const { bakery, invoice } = await rules()
    await bind([{ ruleId: bakery.id, areaId: 'personal' }])
    const captured = await snapshot()
    await bind([{ ruleId: bakery.id, areaId: 'personal' }, { ruleId: invoice.id, areaId: 'work' }])
    expect(await confirmRouterIncoming([cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Invoice for pickup')], home,
      deps({ expectedRuleBindings: captured }))).toEqual([])
    expect(await items()).toEqual([])
  })

  it('a captured binding whose rule changed, went off or lost its open target grants nothing', async () => {
    const { bakery } = await rules()
    await bind([{ ruleId: bakery.id, areaId: 'personal' }])
    const captured = await snapshot()
    const source = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Pickup')
    targets.set('task-florist', { title: 'Florist visits', open: false })
    expect(await confirmRouterIncoming([source], home, deps({ expectedRuleBindings: captured }))).toEqual([])
    targets.set('task-florist', { title: 'Florist visits', open: true })
    await setRoutingRule(home, { id: bakery.id, enabled: false }, PERSON)
    expect(await confirmRouterIncoming([source], home, deps({ expectedRuleBindings: captured }))).toEqual([])
    await setRoutingRule(home, { id: bakery.id, enabled: true, from: 'bakery.example' }, PERSON)
    expect(await confirmRouterIncoming([source], home, deps({ expectedRuleBindings: captured }))).toEqual([])
    expect(await items()).toEqual([])
  })

  it('fails closed with a snapshot too: a failed current check throws and grants nothing', async () => {
    const { bakery } = await rules()
    await bind([{ ruleId: bakery.id, areaId: 'personal' }])
    const captured = await snapshot()
    const source = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Pickup')
    await expect(confirmRouterIncoming([source], home, deps({
      expectedRuleBindings: captured, current: async () => { throw new Error('cache offline') },
    }))).rejects.toThrow('cache offline')
    expect(await items()).toEqual([])
  })
})

describe('confirmedRouteRule', () => {
  it('accepts only a rule of this area that matches the exact cached item', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    await bind([{ ruleId: rule.id, areaId: 'personal' }])
    const hit = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Pickup')
    const miss = cached('INBOX:1:2', 'pat@marina.example.invalid', 'Pickup')
    const areas = await readRouterAreas(home)
    await expect(confirmedRouteRule(areas, 'personal', rule.id, hit, home, deps())).resolves.toMatchObject({ id: rule.id, taskId: 'task-florist' })
    await expectRuleError(() => confirmedRouteRule(areas, 'work', rule.id, hit, home, deps()), 'rule_unavailable', 409)
    await expectRuleError(() => confirmedRouteRule(areas, 'personal', rule.id, miss, home, deps()), 'rule_unavailable', 409)
  })
})

describe('pending rule matches', () => {
  it('only missing fields that a rule needs keep its restriction; a known non-match clears it', () => {
    const pending = [{ areaId: 'personal', match: { subject: 'invoice' } },
      { areaId: 'work', match: { from: 'desk.example.invalid', subject: 'approval' } }];
    expect([...pendingRuleAreas(pending, { kind: 'mail', subject: 'Weekend plans' })]).toEqual([]);
    expect([...pendingRuleAreas(pending, { kind: 'mail', subject: 'Invoice ready' })]).toEqual(['personal']);
    expect([...pendingRuleAreas(pending, { kind: 'mail', subject: 'Approval required' })]).toEqual(['work']);
    expect([...pendingRuleAreas(pending, { kind: 'mail', sender: 'pat@example.invalid', subject: 'Approval required' })]).toEqual([]);
    expect([...pendingRuleAreas(pending, { kind: 'mail', sender: 'pat@example.invalid' })]).toEqual(['personal']);
    expect([...pendingRuleAreas(pending, { kind: 'mail' })]).toEqual(['personal', 'work']);
  })

  it('a failed confirm persists nothing, yet the live rule still names its area for the cached sender', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    await bind([{ ruleId: rule.id, areaId: 'personal' }])
    const source = cached('INBOX:1:1', 'desk@bakery.example.invalid', 'Pickup')
    await expect(confirmRouterIncoming([source], home, deps({ current: async () => { throw new Error('cache down') } }))).rejects.toThrow()
    const file = await readRouterAreas(home)
    expect(file.items).toEqual([])
    const pending = await readPendingRuleMatches(file, home, deps())
    expect(pending).toEqual([{ areaId: 'personal', match: { from: 'bakery.example.invalid' }, ruleId: rule.id }])
    expect([...pendingRuleAreas(pending, { kind: 'mail', sender: cache.get('INBOX:1:1')!.sender, subject: 'Pickup' })]).toEqual(['personal'])
    expect(pendingRuleAreas(pending, { kind: 'mail', sender: 'pat@marina.example.invalid', subject: 'Lunch' }).size).toBe(0)
    expect([...pendingRuleAreas(pending, { kind: 'mail' })]).toEqual(['personal'])
  })

  it('a complete, missing or disabled target or a stale binding is no pending rule', async () => {
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    await bind([{ ruleId: rule.id, areaId: 'personal' }])
    targets.set('task-florist', { title: 'Florist visits', open: false })
    expect(await readPendingRuleMatches(await readRouterAreas(home), home, deps())).toEqual([])
    targets.delete('task-florist')
    expect(await readPendingRuleMatches(await readRouterAreas(home), home, deps())).toEqual([])
    targets.set('task-florist', { title: 'Florist visits', open: true })
    await setRoutingRule(home, { id: rule.id, enabled: false }, PERSON)
    expect(await readPendingRuleMatches(await readRouterAreas(home), home, deps())).toEqual([])
    await setRoutingRule(home, { id: rule.id, enabled: true, from: 'bakery.example' }, PERSON)
    expect(await readPendingRuleMatches(await readRouterAreas(home), home, deps())).toEqual([])
  })

  it('reads nothing without bindings, and a failed target lookup throws', async () => {
    const lookups = vi.fn(async () => new Map<string, RouterRuleTarget>())
    expect(await readPendingRuleMatches(baseAreas(), home, deps({ targets: lookups }))).toEqual([])
    expect(lookups).not.toHaveBeenCalled()
    const rule = await setRoutingRule(home, { from: 'bakery.example.invalid', taskId: 'task-florist' }, PERSON)
    await bind([{ ruleId: rule.id, areaId: 'personal' }])
    await expect(readPendingRuleMatches(await readRouterAreas(home), home, deps({ targets: async () => { throw new Error('tasks down') } })))
      .rejects.toThrow('tasks down')
  })
})
