import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RouterAreaError,
  activeRouter,
  readRouterAreas,
  routerAreasPath,
  routerFolders,
  sourceArea,
  taskArea,
  updateRouterAreas,
  type RouterArea,
  type RouterAreasFile,
} from '../../src/core/router/areas.js'
import type { RouterSource } from '../../src/core/router/types.js'
import { seedTaskStore } from '../helpers/router-task-store.js'

let home: string

const SHARED = 'desk@marina.example.invalid'
const mail = (account: string, message: string): RouterSource => ({ kind: 'mail', account, message })

function area(id: string, extra: Partial<RouterArea> = {}): RouterArea {
  return { id, name: `Area ${id}`, host: '__local__', taskIds: [], sources: [], ...extra }
}

function twoAreas(): RouterAreasFile {
  return {
    version: 1,
    areas: [
      area('personal', { taskIds: ['task-p1', 'task-p2'], sources: [{ kind: 'mail', account: SHARED }] }),
      area('work', { taskIds: ['task-w1'], sources: [{ kind: 'mail', account: SHARED }, { kind: 'slack', account: 'T0ACME' }] }),
    ],
    routers: [
      { taskId: 'task-p1', areaId: 'personal', paused: false },
      { taskId: 'task-p2', areaId: 'personal', paused: true },
    ],
    items: [
      { source: mail(SHARED, 'INBOX:1:10'), areaId: 'personal' },
      { source: mail(SHARED, 'INBOX:1:11'), areaId: 'work' },
    ],
  }
}

async function expectAreaError(run: () => unknown, code: string, status: number): Promise<RouterAreaError> {
  let caught: unknown
  try { await run() } catch (err) { caught = err }
  expect(caught).toBeInstanceOf(RouterAreaError)
  const error = caught as RouterAreaError
  expect(error.code).toBe(code)
  expect(error.status).toBe(status)
  return error
}

function rawFile(): string {
  return fs.readFileSync(path.join(home, 'router', 'areas.json'), 'utf-8')
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-areas-'))
  // A non-empty save stamps the task store first (core/router/data-version.ts).
  seedTaskStore(home)
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('readRouterAreas', () => {
  it('reads an empty file when nothing was written', async () => {
    expect(await readRouterAreas(home)).toEqual({ version: 1, areas: [], routers: [], items: [] })
  })

  it('refuses a file of a newer version instead of guessing', async () => {
    fs.mkdirSync(path.join(home, 'router'), { recursive: true })
    fs.writeFileSync(path.join(home, 'router', 'areas.json'), JSON.stringify({ version: 2, areas: [], routers: [], items: [] }))
    await expectAreaError(() => readRouterAreas(home), 'unsupported_version', 409)
  })

  it('refuses relative homes and ".." segments', async () => {
    await expectAreaError(() => readRouterAreas('relative/home'), 'invalid_home', 400)
    await expectAreaError(() => readRouterAreas(`${home}/../other`), 'invalid_home', 400)
    await expectAreaError(() => updateRouterAreas(`${home}/x/..`, (file) => file), 'invalid_home', 400)
    expect(routerAreasPath(home)).toBe(path.join(home, 'router', 'areas.json'))
  })
})

describe('sourceArea and taskArea', () => {
  it('splits one account between personal and work item by item', async () => {
    const file = await updateRouterAreas(home, () => twoAreas())
    expect(sourceArea(file, mail(SHARED, 'INBOX:1:10'))?.id).toBe('personal')
    expect(sourceArea(file, mail(SHARED, 'INBOX:1:11'))?.id).toBe('work')
  })

  it('gives a task an area only through a router assignment, whatever list it is on', async () => {
    const file = await updateRouterAreas(home, () => twoAreas())
    // Routers (paused or not) run isolated in their area.
    expect(taskArea(file, 'task-p1')?.id).toBe('personal')
    expect(taskArea(file, 'task-p2')?.id).toBe('personal')
    // A member an older build listed with no router assignment is ordinary work (2026-11-14).
    expect(taskArea(file, 'task-w1')).toBeUndefined()
  })

  it('never guesses an unknown item: an account source grants nothing by itself', async () => {
    const file = await updateRouterAreas(home, () => twoAreas())
    expect(sourceArea(file, mail(SHARED, 'INBOX:1:99'))).toBeUndefined()
    expect(sourceArea(file, { kind: 'slack', account: 'T0ACME', message: 'C1/1700000000.1' })).toBeUndefined()
  })

  it('matches kind, account and message exactly', async () => {
    const file = await updateRouterAreas(home, () => twoAreas())
    const lookalikes: RouterSource[] = [
      mail('Desk@marina.example.invalid', 'INBOX:1:10'),
      mail(` ${SHARED}`, 'INBOX:1:10'),
      mail(`${SHARED} `, 'INBOX:1:10'),
      mail(SHARED, 'inbox:1:10'),
      mail(SHARED, 'INBOX:1:10 '),
      { kind: 'slack', account: SHARED, message: 'INBOX:1:10' },
    ]
    for (const source of lookalikes) expect(sourceArea(file, source)).toBeUndefined()
  })

  it('gives a task on no list no area', async () => {
    const file = await updateRouterAreas(home, () => twoAreas())
    expect(taskArea(file, 'task-elsewhere')).toBeUndefined()
  })
})

describe('activeRouter', () => {
  it('returns the one router that is not paused, and none once it pauses', async () => {
    let file = await updateRouterAreas(home, () => twoAreas())
    expect(activeRouter(file, 'personal')?.taskId).toBe('task-p1')
    expect(activeRouter(file, 'work')).toBeUndefined()
    file = await updateRouterAreas(home, (current) => ({
      ...current,
      routers: current.routers.map((router) => ({ ...router, paused: true })),
    }))
    expect(activeRouter(file, 'personal')).toBeUndefined()
    expect(activeRouter(file, 'missing')).toBeUndefined()
  })

  it('allows two routers in one area but at most one active', async () => {
    await updateRouterAreas(home, () => twoAreas())
    await expectAreaError(() => updateRouterAreas(home, (current) => ({
      ...current,
      routers: current.routers.map((router) => ({ ...router, paused: false })),
    })), 'invalid_areas', 400)
    expect(activeRouter(await readRouterAreas(home), 'personal')?.taskId).toBe('task-p1')
  })

  it('refuses a router task outside its area', async () => {
    await updateRouterAreas(home, () => twoAreas())
    await expectAreaError(() => updateRouterAreas(home, (current) => ({
      ...current,
      routers: [...current.routers, { taskId: 'task-p2', areaId: 'work', paused: false }],
    })), 'invalid_areas', 400)
  })
})

describe('updateRouterAreas validation', () => {
  const cases: Array<[string, (file: RouterAreasFile) => void]> = [
    ['an unsafe area id', (file) => { file.areas[0].id = '../escape' }],
    ['an uppercase area id', (file) => { file.areas[0].id = 'Personal' }],
    ['an area id over 80 characters', (file) => { file.areas[0].id = 'a'.repeat(81) }],
    ['a blank name', (file) => { file.areas[0].name = '   ' }],
    ['a name over 120 characters', (file) => { file.areas[0].name = 'n'.repeat(121) }],
    ['an empty host', (file) => { file.areas[0].host = '' }],
    ['a host over 200 characters', (file) => { file.areas[0].host = 'h'.repeat(201) }],
    ['a duplicate area id', (file) => { file.areas[1].id = 'personal' }],
    ['one task in two areas', (file) => { file.areas[1].taskIds.push('task-p1') }],
    ['an account listed twice in one area', (file) => { file.areas[0].sources.push({ kind: 'mail', account: SHARED }) }],
    ['an unknown source kind', (file) => { (file.areas[0].sources[0] as { kind: string }).kind = 'fax' }],
    ['one item in two areas', (file) => { file.items.push({ source: mail(SHARED, 'INBOX:1:10'), areaId: 'work' }) }],
    ['an item whose account the area does not list', (file) => {
      file.items.push({ source: { kind: 'slack', account: 'T0ACME', message: 'C1/1' }, areaId: 'personal' })
    }],
    ['an item whose account differs only in case', (file) => {
      file.items.push({ source: mail('DESK@marina.example.invalid', 'INBOX:1:12'), areaId: 'personal' })
    }],
    ['an item of an unknown area', (file) => { file.items.push({ source: mail(SHARED, 'INBOX:1:12'), areaId: 'nowhere' }) }],
    ['a router of an unknown area', (file) => { file.routers.push({ taskId: 'task-w1', areaId: 'nowhere', paused: true }) }],
    ['one task assigned as a router twice', (file) => { file.routers.push({ taskId: 'task-p1', areaId: 'personal', paused: true }) }],
    ['an empty delivery version', (file) => { file.items[0].source.version = '' }],
    ['a delivery version with a control character', (file) => { file.items[0].source.version = 'bad\nversion' }],
    ['a delivery version over 200 characters', (file) => { file.items[0].source.version = 'v'.repeat(201) }],
    ['an empty canonical key', (file) => { file.items[0].canonicalKey = '' }],
    ['a canonical key that is not a string', (file) => { (file.items[0] as { canonicalKey?: unknown }).canonicalKey = 7 }],
    ['a canonical key with a control character', (file) => { file.items[0].canonicalKey = 'key\nother' }],
    ['a canonical key over 2048 characters', (file) => { file.items[0].canonicalKey = 'k'.repeat(2049) }],
    ['one canonical key of one account in two areas', (file) => {
      file.items[0].canonicalKey = 'rfc-shared'
      file.items[1].canonicalKey = 'rfc-shared'
    }],
  ]

  for (const [label, edit] of cases) {
    it(`refuses ${label} and keeps the file as it was`, async () => {
      await updateRouterAreas(home, () => twoAreas())
      const before = rawFile()
      await expectAreaError(() => updateRouterAreas(home, (current) => { edit(current); return current }), 'invalid_areas', 400)
      expect(rawFile()).toBe(before)
    })
  }

  it('keeps confirmations for separate deliveries of one handle without authorizing a missing or later version', async () => {
    const first = { ...mail(SHARED, 'conversation-1'), version: 'first' };
    const second = { ...first, version: 'second' };
    const file = twoAreas();
    file.items = [{ source: first, areaId: 'personal', canonicalKey: 'rfc:first' }, { source: second, areaId: 'work', canonicalKey: 'rfc:second' }];
    const saved = await updateRouterAreas(home, () => file);
    expect(sourceArea(saved, first)?.id).toBe('personal');
    expect(sourceArea(saved, second)?.id).toBe('work');
    expect(sourceArea(saved, { ...first, version: 'third' })).toBeUndefined();
    expect(sourceArea(saved, mail(SHARED, 'conversation-1'))).toBeUndefined();
    expect((await readRouterAreas(home)).items).toEqual(file.items);
  });

  it('lets several exact items of one area share a canonical key, and keeps it on the item', async () => {
    await updateRouterAreas(home, () => twoAreas())
    const file = await updateRouterAreas(home, (current) => {
      current.items[0].canonicalKey = 'rfc-one'
      current.items.push({ source: mail(SHARED, 'All:1:99'), areaId: 'personal', canonicalKey: 'rfc-one' })
      return current
    })
    expect(file.items.filter((item) => item.canonicalKey === 'rfc-one').map((item) => item.source.message)).toEqual(['INBOX:1:10', 'All:1:99'])
    expect((await readRouterAreas(home)).items[0].canonicalKey).toBe('rfc-one')
  })

  it('reads an older file with no canonical keys unchanged, and writes no key it was not given', async () => {
    await updateRouterAreas(home, () => twoAreas())
    expect(rawFile()).not.toContain('canonicalKey')
    expect((await readRouterAreas(home)).items.every((item) => !('canonicalKey' in item))).toBe(true)
  })

  it('lets one canonical key appear in two areas only under different accounts', async () => {
    const file = twoAreas()
    file.areas[1].sources.push({ kind: 'mail', account: 'home@marina.example.invalid' })
    file.items[0].canonicalKey = 'rfc-same'
    file.items.push({ source: mail('home@marina.example.invalid', 'INBOX:2:1'), areaId: 'work', canonicalKey: 'rfc-same' })
    const saved = await updateRouterAreas(home, () => file)
    expect(saved.items.filter((item) => item.canonicalKey === 'rfc-same')).toHaveLength(2)
  })

  it('lets a slack item of a listed workspace join its area', async () => {
    await updateRouterAreas(home, () => twoAreas())
    const file = await updateRouterAreas(home, (current) => ({
      ...current,
      items: [...current.items, { source: { kind: 'slack', account: 'T0ACME', message: 'C1/1' }, areaId: 'work' }],
    }))
    expect(sourceArea(file, { kind: 'slack', account: 'T0ACME', message: 'C1/1' })?.id).toBe('work')
  })
})

describe('updateRouterAreas history', () => {
  it('refuses to move an item that already has an area', async () => {
    await updateRouterAreas(home, () => twoAreas())
    const error = await expectAreaError(() => updateRouterAreas(home, (current) => ({
      ...current,
      items: current.items.map((item) => ({ ...item, areaId: item.areaId === 'personal' ? 'work' : item.areaId })),
    })), 'area_reassignment', 409)
    expect(error.message).toMatch(/cannot move from area personal to work/)
    expect(sourceArea(await readRouterAreas(home), mail(SHARED, 'INBOX:1:10'))?.id).toBe('personal')
  })

  it('lets an item leave the lists, as an open item of the same area, or with its area', async () => {
    await updateRouterAreas(home, () => twoAreas())
    // A restricted item opened in its own area (the 2026-11-14 move to the simple flow).
    let file = await updateRouterAreas(home, (current) => ({ ...current, items: current.items.slice(1), openItems: [current.items[0]!] }))
    expect(sourceArea(file, mail(SHARED, 'INBOX:1:10'))?.id).toBe('personal')
    // Opened into another area is still a move.
    await expectAreaError(() => updateRouterAreas(home, (current) => ({
      ...current, openItems: current.openItems!.map((one) => ({ ...one, areaId: 'work' })),
    })), 'area_reassignment', 409)
    file = await updateRouterAreas(home, (current) => ({ ...current, openItems: [] }))
    expect(sourceArea(file, mail(SHARED, 'INBOX:1:10'))).toBeUndefined()
    file = await updateRouterAreas(home, (current) => ({
      ...current,
      areas: current.areas.filter((one) => one.id !== 'work'),
      items: current.items.filter((item) => item.areaId !== 'work'),
    }))
    expect(file.areas.map((one) => one.id)).toEqual(['personal'])
  })

  it('refuses to move a task to another area, and lets it leave its area', async () => {
    await updateRouterAreas(home, () => twoAreas())
    await expectAreaError(() => updateRouterAreas(home, (current) => {
      current.areas[0].taskIds = ['task-p1']
      current.areas[1].taskIds.push('task-p2')
      current.routers = current.routers.filter((router) => router.taskId !== 'task-p2')
      return current
    }), 'area_reassignment', 409)
    expect(taskArea(await readRouterAreas(home), 'task-p2')?.id).toBe('personal')
    // Leaving is fine: the simple flow takes non-router work out of its area.
    const left = await updateRouterAreas(home, (current) => {
      current.areas[1].taskIds = []
      return current
    })
    expect(left.areas[1].taskIds).toEqual([])
  })

  it('lets a confirmed item gain a canonical key, never change or drop one', async () => {
    await updateRouterAreas(home, () => twoAreas())
    await updateRouterAreas(home, (current) => { current.items[0].canonicalKey = 'rfc-one'; return current })
    const before = rawFile()
    await expectAreaError(() => updateRouterAreas(home, (current) => { current.items[0].canonicalKey = 'rfc-two'; return current }), 'area_reassignment', 409)
    await expectAreaError(() => updateRouterAreas(home, (current) => { delete current.items[0].canonicalKey; return current }), 'area_reassignment', 409)
    expect(rawFile()).toBe(before)
  })

  it('allows deleting an area that never held a task or an item', async () => {
    await updateRouterAreas(home, () => ({ ...twoAreas(), areas: [...twoAreas().areas, area('spare')] }))
    const file = await updateRouterAreas(home, (current) => ({ ...current, areas: current.areas.filter((one) => one.id !== 'spare') }))
    expect(file.areas.map((one) => one.id)).toEqual(['personal', 'work'])
  })
})

describe('updateRouterAreas persistence', () => {
  it('keeps every concurrent update', async () => {
    await updateRouterAreas(home, () => ({ version: 1, areas: [area('ops', { sources: [{ kind: 'mail', account: SHARED }] })], routers: [], items: [] }))
    await Promise.all(Array.from({ length: 20 }, (_, i) => updateRouterAreas(home, async (current) => {
      await new Promise((resolve) => setTimeout(resolve, i % 3))
      current.areas[0].taskIds.push(`task-${i}`)
      current.items.push({ source: mail(SHARED, `INBOX:1:${i}`), areaId: 'ops' })
      return current
    })))
    const file = await readRouterAreas(home)
    expect([...file.areas[0].taskIds].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `task-${i}`).sort())
    expect(file.items).toHaveLength(20)
    for (let i = 0; i < 20; i++) expect(sourceArea(file, mail(SHARED, `INBOX:1:${i}`))?.id).toBe('ops')
  })

  it('stores only the configured fields, never an item body or subject', async () => {
    const withExtras = twoAreas() as unknown as { items: Array<Record<string, unknown>>; areas: Array<Record<string, unknown>> }
    withExtras.items[0].body = 'Body text of the private letter'
    withExtras.items[0].subject = 'Private subject line'
    ;(withExtras.items[0].source as Record<string, unknown>).snippet = 'Snippet of the private letter'
    withExtras.areas[0].notes = 'free-form notes'
    await updateRouterAreas(home, () => withExtras as unknown as RouterAreasFile)
    const raw = rawFile()
    expect(raw).not.toContain('Body text')
    expect(raw).not.toContain('Private subject')
    expect(raw).not.toContain('Snippet')
    expect(raw).not.toContain('free-form')
    const stored = JSON.parse(raw) as RouterAreasFile
    expect(Object.keys(stored.items[0]).sort()).toEqual(['areaId', 'source'])
    expect(Object.keys(stored.items[0].source).sort()).toEqual(['account', 'kind', 'message'])
  })

  it('hands the change a copy, so a change that throws leaves nothing behind', async () => {
    await updateRouterAreas(home, () => twoAreas())
    const before = rawFile()
    await expect(updateRouterAreas(home, (current) => {
      current.areas[0].name = 'Changed'
      throw new Error('change failed')
    })).rejects.toThrow('change failed')
    expect(rawFile()).toBe(before)
    expect((await readRouterAreas(home)).areas[0].name).toBe('Area personal')
  })
})

describe('the folders a router watches', () => {
  it('keeps a folder list on the area, deduplicated, and falls back to the default without one', async () => {
    const file = await updateRouterAreas(home, () => ({
      ...twoAreas(), areas: [area('personal', { ...twoAreas().areas[0], folders: ['inbox', 'Receipts', 'Receipts'] }), twoAreas().areas[1]!],
    }))
    expect(file.areas[0]!.folders).toEqual(['inbox', 'Receipts'])
    expect(routerFolders(file.areas[0]!, ['inbox'])).toEqual(['inbox', 'Receipts'])
    expect(file.areas[1]).not.toHaveProperty('folders')
    expect(routerFolders(file.areas[1]!, ['inbox'])).toEqual(['inbox'])
    expect(routerFolders({ folders: [] }, ['inbox'])).toEqual(['inbox'])
  })

  it('refuses more than 50 folders or a folder name over 200 characters', async () => {
    for (const folders of [Array.from({ length: 51 }, (_, i) => `F${i}`), ['x'.repeat(201)]]) {
      await expectAreaError(() => updateRouterAreas(home, () => ({ ...twoAreas(), areas: [area('personal', { ...twoAreas().areas[0], folders })] })), 'invalid_areas', 400)
    }
  })
})
