/**
 * The plugin's real `activate()` on the fake host: the ops and their reach, connecting with a
 * secret checked against Notion (kept in secrets, never in state), the refusals (a test run, a
 * replica, a malformed secret), and one whole import through the ops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeWalnut } from '../../../packages/plugin-api/src/testing.js'
import { activate, deactivate } from '../../../plugin-store/notes-import/src/server'
import { mergeReport } from '../../../plugin-store/notes-import/src/server/runtime'
import { standardWorkspace, fakeSecret } from './fake-notion'

// The real pace is three requests a second; the stand-in answers as fast as it is asked.
beforeEach(() => { vi.stubEnv('WALNUT_NOTION_PER_SECOND', '1000') })
afterEach(() => { deactivate(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

function op(fake: ReturnType<typeof createFakeWalnut>, name: string) {
  const found = fake.registeredOps.find((d) => d.name === name)
  if (!found) throw new Error(`no op ${name}`)
  return (args: Record<string, unknown> = {}) => found.handler(args, { call: async () => undefined }) as Promise<any>
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('notes-import activate', () => {
  it('declares its ops: reads answer remotely, every change stays in the App', async () => {
    const fake = createFakeWalnut({ pluginId: 'notes-import' })
    await activate(fake.api)
    expect(Object.fromEntries(fake.registeredOps.map((d) => [d.name, `${d.readonly ? 'read' : 'write'}:${d.remote}`]))).toEqual({
      status: 'read:allow', folders: 'read:allow',
      notion_connect: 'write:deny', notion_disconnect: 'write:deny', notion_check: 'write:deny',
      import_start: 'write:deny', import_cancel: 'write:deny', import_remove_gone: 'write:deny', import_restore_gone: 'write:deny', notion_preview: 'read:deny',
      organize_plan: 'write:deny', organize_cancel: 'write:deny', organize_apply: 'write:deny', organize_undo: 'write:deny',
    })
  })

  it('connects, imports through the ops, and never puts the secret in its state', async () => {
    const { notion } = standardWorkspace()
    vi.stubGlobal('fetch', notion.fetch)
    const fake = createFakeWalnut({ pluginId: 'notes-import' })
    await activate(fake.api)
    await expect(op(fake, 'notion_connect')({ token: 'hello' })).rejects.toThrow(/does not look like a Notion secret/)
    await expect(op(fake, 'notion_connect')({ token: 'ntn_wrongsecret_abc' })).rejects.toThrow(/looks too short/)
    await expect(op(fake, 'notion_connect')({ token: fakeSecret('wrong') })).rejects.toMatchObject({ code: 'source_auth' })
    const state = await op(fake, 'notion_connect')({ token: notion.token })
    expect(state.notion).toMatchObject({ connected: true, workspace: 'Acme notes' })
    expect(await fake.api.secrets.get('notion_token')).toBe(notion.token)
    await until(async () => !!(await op(fake, 'status')()).notion.access)
    const access = (await op(fake, 'status')()).notion.access
    // The page reachable only through its parent's blocks is not counted until an import walks it.
    expect(access).toMatchObject({ pages: 7, databases: 1 })
    expect(access.roots.map((r: { title: string }) => r.title)).toEqual(['Home', 'Second root'])
    expect(JSON.stringify(await op(fake, 'status')())).not.toContain(notion.token)

    await op(fake, 'import_start')({ folder: 'Imports/Notion' })
    await until(async () => (await op(fake, 'status')()).job?.phase === 'done')
    const done = (await op(fake, 'status')()).job
    expect(done.counts).toMatchObject({ created: 9, failed: 0 })
    expect(done.firstPath).toBe('Imports/Notion/Home/Home.md')
    expect(fake.notes.has('Imports/Notion/Home/Tasks/Write report.md')).toBe(true)
    expect((await op(fake, 'status')()).defaultFolder).toBe('Imports/Notion')
    expect((await op(fake, 'folders')()).folders).toContain('Imports/Notion/Home')
  })

  it('refuses changes in a test run and on a replica', async () => {
    const testRun = createFakeWalnut({ pluginId: 'notes-import' })
    ;(testRun.api as { testRun?: () => string }).testRun = () => 'webdriver-1'
    await activate(testRun.api)
    await expect(op(testRun, 'notion_connect')({ token: fakeSecret('abc') })).rejects.toThrow(/test run/)
    await expect(op(testRun, 'import_start')({})).rejects.toThrow(/test run/)
    deactivate()
    const replica = createFakeWalnut({ pluginId: 'notes-import' })
    ;(replica.api as { replica: boolean }).replica = true
    await activate(replica.api)
    await expect(op(replica, 'import_start')({})).rejects.toThrow(/main Walnut/)
    expect((await op(replica, 'status')()).replica).toBe(true)
  })

  it('runs one change at a time: a second click, a retry or another window is refused, and Undo stays possible', async () => {
    const { notion } = standardWorkspace()
    vi.stubGlobal('fetch', notion.fetch)
    const plan = { summary: 'Group the child page', steps: [{ kind: 'move', from: 'Home/Child A', to: 'Topics/Child A', why: 'group' }] }
    const fake = createFakeWalnut({ pluginId: 'notes-import', overrides: { ai: { run: async () => ({ json: plan }) } } as never })
    await activate(fake.api)
    await op(fake, 'notion_connect')({ token: notion.token })
    const status = async () => (await op(fake, 'status')()) as any
    // Two imports started together: one runs.
    const both = await Promise.allSettled([op(fake, 'import_start')({}), op(fake, 'import_start')({})])
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    await until(async () => (await status()).job?.phase === 'done')
    expect(fake.notes.has('Import from Notion/Home (2)/Home (2).md')).toBe(false)

    await op(fake, 'organize_plan')({})
    await expect(op(fake, 'organize_plan')({})).rejects.toThrow(/already organizing/)
    await until(async () => (await status()).organize.phase === 'ready')
    // Every step left out: nothing to apply, and the plan is still there.
    await expect(op(fake, 'organize_apply')({ leaveOut: [0] })).rejects.toThrow(/Every step is left out/)
    expect((await status()).organize.phase).toBe('ready')
    const applies = await Promise.allSettled([op(fake, 'organize_apply')(), op(fake, 'organize_apply')()])
    expect(applies.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    await until(async () => (await status()).organize.phase === 'applied')
    expect(fake.notes.has('Import from Notion/Topics/Child A/Child A.md')).toBe(true)

    // Done puts the run aside, and a plan for another folder keeps it too: Undo still puts the
    // first folder back, once.
    await op(fake, 'organize_cancel')()
    expect((await status()).organize).toMatchObject({ phase: 'idle', backup: { folder: 'Import from Notion' } })
    await fake.api.notes!.write('Other/Note.md', 'other\n')
    await op(fake, 'organize_plan')({ folder: 'Other' })
    await until(async () => (await status()).organize.phase === 'ready')
    expect((await status()).organize).toMatchObject({ folder: 'Other', backup: { folder: 'Import from Notion' } })
    await op(fake, 'organize_cancel')()
    const undos = await Promise.allSettled([op(fake, 'organize_undo')(), op(fake, 'organize_undo')()])
    expect(undos.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    await until(async () => (await status()).organize.undoneAt !== undefined)
    expect(fake.notes.has('Import from Notion/Home/Child A/Child A.md')).toBe(true)
    expect(fake.notes.has('Import from Notion/Topics/Child A/Child A.md')).toBe(false)
    await expect(op(fake, 'organize_undo')()).rejects.toThrow(/nothing to undo/)
  })

  it('Cancel drops a plan at once, even while the AI run is slow to stop, and its late answer changes nothing', async () => {
    const { notion } = standardWorkspace()
    vi.stubGlobal('fetch', notion.fetch)
    let answer: ((v: unknown) => void) | null = null
    const plan = { summary: 'Late', steps: [{ kind: 'move', from: 'Home/Child A', to: 'Topics/Child A', why: 'group' }] }
    // An AI run that ignores the abort and answers only when told to.
    const fake = createFakeWalnut({ pluginId: 'notes-import', overrides: { ai: { run: () => new Promise((resolve) => { answer = resolve }) } } as never })
    await activate(fake.api)
    await op(fake, 'notion_connect')({ token: notion.token })
    const status = async () => (await op(fake, 'status')()) as any
    await op(fake, 'import_start')({})
    await until(async () => (await status()).job?.phase === 'done')
    await op(fake, 'organize_plan')({})
    await until(() => answer !== null)
    expect((await status()).organize.phase).toBe('planning')
    await op(fake, 'organize_cancel')()
    expect((await status()).organize.phase).toBe('idle')
    // Free for the next thing at once.
    await op(fake, 'import_start')({})
    await until(async () => (await status()).job?.phase === 'done')
    answer!({ json: plan })
    await new Promise((r) => setTimeout(r, 50))
    expect((await status()).organize.phase).toBe('idle')
  })

  it('a run that stopped part way is undone before a new plan, and a restart before it began changes nothing', async () => {
    const fake = createFakeWalnut({ pluginId: 'notes-import' })
    await fake.api.storage.writeJson('state.json', {
      undo: { id: 'run-a', folder: 'Import from Notion', at: '2026-01-01T00:00:00.000Z' },
      organize: { phase: 'applying', folder: 'Import from Notion', plan: { folder: 'Import from Notion', summary: 's', steps: [], madeAt: 'm' } },
    })
    await activate(fake.api)
    const status = async () => (await op(fake, 'status')()) as any
    // Cut off before its own journal started: the plan is back, nothing to undo of it.
    expect((await status()).organize).toMatchObject({ phase: 'ready', error: expect.stringMatching(/nothing changed/) })
    deactivate()
    const again = createFakeWalnut({ pluginId: 'notes-import', overrides: { storage: fake.api.storage } as never })
    await again.api.storage.writeJson('state.json', {
      undo: { id: 'run-a', folder: 'Import from Notion', at: '2026-01-01T00:00:00.000Z' },
      organize: { phase: 'applying', folder: 'Import from Notion', journal: 'run-a', plan: { folder: 'Import from Notion', summary: 's', steps: [], madeAt: 'm' } },
    })
    await activate(again.api)
    expect(((await op(again, 'status')()) as any).organize.phase).toBe('failed')
    await expect(op(again, 'organize_plan')({})).rejects.toThrow(/stopped part way. Undo it first/)
  })

  it('deletes notes gone from Notion from the last run\'s list only, and Undo brings them back', async () => {
    const { notion, ids } = standardWorkspace()
    vi.stubGlobal('fetch', notion.fetch)
    const fake = createFakeWalnut({ pluginId: 'notes-import' })
    await activate(fake.api)
    await op(fake, 'notion_connect')({ token: notion.token })
    const runOnce = async () => {
      const ended = (await op(fake, 'status')()).job?.endedAt
      await op(fake, 'import_start')({})
      await until(async () => { const job = (await op(fake, 'status')()).job; return job?.phase === 'done' && job.endedAt !== ended }, 20000)
      return (await op(fake, 'status')()).job
    }
    await runOnce()
    ;(notion as any).pages.get(ids.second).trashed = true
    const job = await runOnce()
    const gone = 'Import from Notion/Second root.md'
    expect(job.gonePaths).toEqual([gone])
    const was = fake.notes.get(gone)
    // Only a note the run listed: anything else is refused, and nothing is deleted.
    await expect(op(fake, 'import_remove_gone')({ paths: ['Import from Notion/Home/Home.md'] })).rejects.toThrow(/not in the last import/)
    expect(fake.notes.has('Import from Notion/Home/Home.md')).toBe(true)
    const after = await op(fake, 'import_remove_gone')({ paths: [gone] })
    expect(fake.notes.has(gone)).toBe(false)
    expect(after.job).toMatchObject({ gonePaths: [], removedPaths: [gone] })
    // The note's text never goes to the page, only its path.
    expect(JSON.stringify(after)).not.toContain('Another tree')
    const back = await op(fake, 'import_restore_gone')()
    expect(fake.notes.get(gone)).toBe(was)
    expect(back.job.gonePaths).toEqual([gone])
    expect(back.job.removedPaths).toBeUndefined()
    // Deleted again, then a new import: it is gone for good, and not offered back.
    await op(fake, 'import_remove_gone')({ paths: [gone] })
    const next = await runOnce()
    expect(next.removedPaths).toBeUndefined()
    expect(next.gonePaths ?? []).toEqual([])
    expect(fake.notes.has(gone)).toBe(false)
  })

  it('a top-level page trashed in Notion is gone for a folder of that page too, and the report follows a note organize moved', async () => {
    const { notion, ids } = standardWorkspace()
    vi.stubGlobal('fetch', notion.fetch)
    const plan = { summary: 'Group it', steps: [{ kind: 'move', from: 'Second root', to: 'Topics/Second root', why: 'group' }] }
    const fake = createFakeWalnut({ pluginId: 'notes-import', overrides: { ai: { run: async () => ({ json: plan }) } } as never })
    await activate(fake.api)
    await op(fake, 'notion_connect')({ token: notion.token })
    const status = async () => (await op(fake, 'status')()) as any
    const runOnce = async (args: Record<string, unknown> = {}) => {
      const ended = (await status()).job?.endedAt
      await op(fake, 'import_start')(args)
      await until(async () => { const job = (await status()).job; return job?.phase === 'done' && job.endedAt !== ended }, 20000)
      return (await status()).job
    }
    const F = 'Import from Notion'
    await runOnce({ folder: 'Only second', rootIds: [ids.second] })
    await runOnce({ folder: F })
    ;(notion as any).pages.get(ids.second).trashed = true
    expect((await runOnce({ folder: 'Only second', rootIds: [ids.second] })).gonePaths).toEqual(['Only second/Second root.md'])
    expect((await runOnce({ folder: F })).gonePaths).toEqual([`${F}/Second root.md`])
    // Organize moves the gone note: the report names it where it is now, and Delete deletes it there.
    await op(fake, 'organize_plan')({ folder: F })
    await until(async () => (await status()).organize.phase === 'ready')
    await op(fake, 'organize_apply')()
    await until(async () => (await status()).organize.phase === 'applied')
    const moved = `${F}/Topics/Second root.md`
    expect(fake.notes.has(moved)).toBe(true)
    expect((await status()).job.gonePaths).toEqual([moved])
    await op(fake, 'import_remove_gone')({ paths: [moved] })
    expect(fake.notes.has(moved)).toBe(false)
    // A listed note that is not there any more is said so, never shown as deleted.
    await op(fake, 'import_restore_gone')()
    await fake.api.notes!.remove(moved)
    await expect(op(fake, 'import_remove_gone')({ paths: [moved] })).rejects.toThrow(/could not find the note of Second root/)
  })

  it('deletes a gone note where the person renamed it, turns links to it into words, and Undo puts both back', async () => {
    const { notion, ids } = standardWorkspace()
    vi.stubGlobal('fetch', notion.fetch)
    const fake = createFakeWalnut({ pluginId: 'notes-import' })
    await activate(fake.api)
    await op(fake, 'notion_connect')({ token: notion.token })
    const status = async () => (await op(fake, 'status')()) as any
    const runOnce = async () => {
      const ended = (await status()).job?.endedAt
      await op(fake, 'import_start')({})
      await until(async () => { const job = (await status()).job; return job?.phase === 'done' && job.endedAt !== ended }, 20000)
      return (await status()).job
    }
    const F = 'Import from Notion'
    await runOnce()
    // Plan trip is trashed in Notion; the person edited it in Walnut first.
    const plan = `${F}/Home/Tasks/Plan trip.md`
    await fake.api.notes!.write(plan, `${fake.notes.get(plan)}\nMy line\n`)
    ;(notion as any).pages.get(ids.row2).trashed = true
    const job = await runOnce()
    expect(job.gonePaths).toEqual([plan])
    expect(job.goneEdited).toEqual([plan])
    // Renamed after the run listed it: Delete finds it by its page.
    const renamed = `${F}/Home/Tasks/Plan trip renamed.md`
    await fake.api.notes!.move(plan, renamed)
    // Walnut's rename fixes the links to it, as Notes does.
    const writeReport = `${F}/Home/Tasks/Write report.md`
    const relinked = (fake.notes.get(writeReport) as string).split(`${F}/Home/Tasks/Plan trip`).join(`${F}/Home/Tasks/Plan trip renamed`)
    await fake.api.notes!.write(writeReport, relinked)
    const linked = fake.notes.get(writeReport) as string
    expect(linked).toContain('[[Import from Notion/Home/Tasks/Plan trip renamed\\|Plan trip]]')
    await op(fake, 'import_remove_gone')({ paths: [plan] })
    expect(fake.notes.has(renamed)).toBe(false)
    expect((await status()).job.gonePaths).toEqual([])
    // The link to the deleted note is its words now, in the table too.
    const after = fake.notes.get(writeReport) as string
    expect(after).not.toContain('Plan trip renamed')
    expect(after).toContain('| Plan trip |')
    await op(fake, 'import_restore_gone')()
    expect(fake.notes.has(renamed)).toBe(true)
    expect(fake.notes.get(writeReport)).toBe(linked)
  })

  it('a run for one note adds to the last report; each folder keeps its pages; a deleted note comes back', async () => {
    const { notion, ids } = standardWorkspace()
    vi.stubGlobal('fetch', notion.fetch)
    const fake = createFakeWalnut({ pluginId: 'notes-import' })
    await activate(fake.api)
    await op(fake, 'notion_connect')({ token: notion.token })
    const runOnce = async (args: Record<string, unknown> = {}) => {
      const ended = (await op(fake, 'status')()).job?.endedAt
      await op(fake, 'import_start')(args)
      await until(async () => { const job = (await op(fake, 'status')()).job; return job?.phase === 'done' && job.endedAt !== ended }, 20000)
      return op(fake, 'status')()
    }
    // A folder made from one page only remembers that page.
    const one = await runOnce({ folder: 'Only second', rootIds: [ids.second] })
    expect(one.history[0]).toMatchObject({ folder: 'Only second', rootIds: [ids.second] })
    const F = 'Import from Notion'
    await runOnce({ folder: F })
    // A report with an update in it, then a note deleted in Walnut.
    notion.setBlocks(ids.second, [{ object: 'block', id: 'b-s', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', plain_text: 'Changed', text: { content: 'Changed' }, annotations: {}, href: null }] } }], '2024-06-01T00:00:00.000Z')
    await fake.api.notes!.remove(`${F}/Home/Notes (2).md`)
    const report = (await runOnce({ folder: F })).job
    expect(report.updatedPaths).toEqual([`${F}/Second root.md`])
    expect(report.deletedPaths).toEqual([`${F}/Home/Notes (2).md`])
    // Bring it back: the note returns, and the update stays on the report.
    const back = (await runOnce({ folder: F, bringBack: [`${F}/Home/Notes (2).md`] })).job
    expect(fake.notes.has(`${F}/Home/Notes (2).md`)).toBe(true)
    expect(back.restored).toEqual([`${F}/Home/Notes (2).md`])
    expect(back.updatedPaths).toEqual([`${F}/Second root.md`])
    expect(back.deletedPaths ?? []).toEqual([])
    expect(back.counts).toMatchObject({ updated: 1, created: 1 })
  })

  it('a run carried on after Stop reports the whole import, files left in Notion and warnings included', () => {
    const counts = { found: 9, done: 9, created: 9, updated: 0, unchanged: 0, kept: 0, failed: 0, files: 2, filesKeptInSource: 1, deleted: 0 }
    const prev = { folder: 'F', phase: 'cancelled', counts, errors: [], warnings: ['w1'], keptPaths: [], firstPath: null, roots: [], filesInSource: [{ name: 'a.zip', note: 'F/Home.md' }], newPaths: ['F/Home.md'] } as any
    const next = { folder: 'F', phase: 'done', counts: { ...counts, created: 121, unchanged: 9, files: 0, filesKeptInSource: 0, relinked: 1 }, errors: [], warnings: [], keptPaths: [], firstPath: null, roots: [], filesInSource: [], newPaths: [] } as any
    mergeReport(prev, next)
    expect(next.counts).toMatchObject({ created: 130, unchanged: 0, files: 2, filesKeptInSource: 1, relinked: 1 })
    expect(next.filesInSource).toEqual([{ name: 'a.zip', note: 'F/Home.md' }])
    expect(next.warnings).toEqual(['w1'])
  })

  it('refuses to organize the whole vault', async () => {
    const fake = createFakeWalnut({ pluginId: 'notes-import' })
    await activate(fake.api)
    await expect(op(fake, 'organize_plan')({ folder: '/' })).rejects.toThrow(/Pick a folder/)
    await expect(op(fake, 'organize_plan')({ folder: '..' })).rejects.toThrow(/Pick a folder/)
  })

  it('shows what the connection could see at once after a restart, and looks again once it is a day old', async () => {
    const { notion } = standardWorkspace()
    let searches = 0
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('/v1/search')) searches++
      return notion.fetch(url, init)
    })
    const first = createFakeWalnut({ pluginId: 'notes-import' })
    await activate(first.api)
    await op(first, 'notion_connect')({ token: notion.token })
    await until(async () => !!(await op(first, 'status')()).notion.access)
    deactivate()
    // The same plugin data and secrets, a new start: the last look is shown, Notion is not asked.
    const restart = async () => {
      const again = createFakeWalnut({ pluginId: 'notes-import', overrides: { storage: first.api.storage, secrets: first.api.secrets } as never })
      await activate(again.api)
      return again
    }
    const before = searches
    const again = await restart()
    expect((await op(again, 'status')()).notion).toMatchObject({ connected: true, checking: false, access: { pages: 7 } })
    await new Promise((r) => setTimeout(r, 50))
    expect(searches).toBe(before)
    deactivate()
    // A day old: shown, and looked at again in the background.
    const state = await first.api.storage.readJson<any>('state.json', {})
    state.access.checkedAt = new Date(Date.now() - 25 * 3600_000).toISOString()
    await first.api.storage.writeJson('state.json', state)
    const later = await restart()
    expect((await op(later, 'status')()).notion.access).toMatchObject({ pages: 7 })
    await until(async () => searches > before && !(await op(later, 'status')()).notion.checking)
    expect(Date.now() - Date.parse((await op(later, 'status')()).notion.access.checkedAt)).toBeLessThan(60_000)
  })

  it('applies only the plan the person looked at', async () => {
    const { notion } = standardWorkspace()
    vi.stubGlobal('fetch', notion.fetch)
    const plan = { summary: 'Group', steps: [{ kind: 'move', from: 'Home/Child A', to: 'Topics/Child A', why: 'group' }] }
    const fake = createFakeWalnut({ pluginId: 'notes-import', overrides: { ai: { run: async () => ({ json: plan }) } } as never })
    await activate(fake.api)
    await op(fake, 'notion_connect')({ token: notion.token })
    const status = async () => (await op(fake, 'status')()) as any
    await op(fake, 'import_start')({})
    await until(async () => (await status()).job?.phase === 'done')
    await op(fake, 'organize_plan')({})
    await until(async () => (await status()).organize.phase === 'ready')
    const madeAt = (await status()).organize.plan.madeAt
    await expect(op(fake, 'organize_apply')({ plan: '2020-01-01T00:00:00.000Z' })).rejects.toThrow(/plan changed since you looked/)
    expect((await status()).organize.phase).toBe('ready')
    await op(fake, 'organize_apply')({ plan: madeAt })
    await until(async () => (await status()).organize.phase === 'applied')
  })

  it('an access check of a connection dropped meanwhile never lands on the new one', async () => {
    const { notion } = standardWorkspace()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let searches = 0
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      // The first connection's check is slow, then told its secret is no good.
      if (String(url).includes('/v1/search') && ++searches === 1) {
        await gate
        return new Response(JSON.stringify({ object: 'error', status: 401, code: 'unauthorized', message: 'API token is invalid.' }), { status: 401, headers: { 'content-type': 'application/json' } })
      }
      return notion.fetch(url, init)
    })
    const fake = createFakeWalnut({ pluginId: 'notes-import' })
    await activate(fake.api)
    const status = async () => (await op(fake, 'status')()) as any
    await op(fake, 'notion_connect')({ token: notion.token })
    await op(fake, 'notion_disconnect')()
    await op(fake, 'notion_connect')({ token: notion.token })
    await until(async () => !!(await status()).notion.access)
    release()
    await new Promise((r) => setTimeout(r, 50))
    expect((await status()).notion).toMatchObject({ connected: true, checking: false, access: { pages: 7 } })
    expect((await status()).notion.error).toBeUndefined()
  })
})
