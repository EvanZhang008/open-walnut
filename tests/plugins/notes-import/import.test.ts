/**
 * The importer end to end against the stand-in Notion workspace and the fake host's notes vault:
 * the tree, every block kind, databases, attachments, links, and what a second run does
 * (nothing for unchanged pages, an update for a changed one, the person's edits kept, a moved
 * note found where it is now).
 */
import { describe, expect, it } from 'vitest'
import { createFakeWalnut } from '../../../packages/plugin-api/src/testing.js'
import { runImport } from '../../../plugin-store/notes-import/src/server/importer'
import { bodyOf, withBody } from '../../../plugin-store/notes-import/src/server/note-file'
import { Mapping } from '../../../plugin-store/notes-import/src/server/mapping'
import { NotionClient } from '../../../plugin-store/notes-import/src/server/notion/client'
import { NotionSource } from '../../../plugin-store/notes-import/src/server/notion/source'
import { para, standardWorkspace, type FakeNotion, fakeSecret } from './fake-notion'

const FOLDER = 'Import from Notion'

function setup() {
  const { notion, ids } = standardWorkspace()
  const fake = createFakeWalnut({ pluginId: 'notes-import' })
  const mapping = new Mapping(fake.api.storage.database)
  return { notion, ids, fake, mapping }
}

function freshRecords(ctx: { mapping: Mapping }) {
  // Another machine, or plugin data cleared: the notes are there, the importer's records are not.
  ctx.mapping = new Mapping(createFakeWalnut({ pluginId: 'notes-import' }).api.storage.database)
}

async function run(ctx: { notion: FakeNotion; fake: ReturnType<typeof createFakeWalnut>; mapping: Mapping }, extra: { rootIds?: string[]; folder?: string; token?: string; signal?: AbortSignal; onProgress?: (p: { counts: { done: number } }) => void } = {}) {
  const client = new NotionClient(extra.token ?? ctx.notion.token, { fetch: ctx.notion.fetch, sleep: async () => undefined })
  return runImport({
    source: new NotionSource(client),
    notes: ctx.fake.api.notes!,
    mapping: ctx.mapping,
    folder: extra.folder ?? FOLDER,
    rootIds: extra.rootIds,
    download: (url, max, signal) => client.download(url, max, signal),
    signal: extra.signal ?? new AbortController().signal,
    onProgress: extra.onProgress ?? (() => undefined),
  })
}

const note = (fake: ReturnType<typeof createFakeWalnut>, path: string) => {
  const v = fake.notes.get(path)
  if (typeof v !== 'string') throw new Error(`no note at ${path}; have:\n${[...fake.notes.keys()].join('\n')}`)
  return v
}

describe('notion import', () => {
  it('brings in the tree, every block kind, databases, attachments and links', async () => {
    const ctx = setup()
    const outcome = await run(ctx)
    expect(outcome.errors).toEqual([])
    const paths = [...ctx.fake.notes.keys()].sort()
    expect(paths).toEqual(expect.arrayContaining([
      `${FOLDER}/Home/Home.md`,
      `${FOLDER}/Home/Child A/Child A.md`,
      `${FOLDER}/Home/Child A/Deep page.md`,
      `${FOLDER}/Home/Notes.md`,
      `${FOLDER}/Home/Notes (2).md`,
      `${FOLDER}/Home/Tasks/Tasks.md`,
      `${FOLDER}/Home/Tasks/Write report.md`,
      `${FOLDER}/Home/Tasks/Plan trip.md`,
      `${FOLDER}/Second root.md`,
    ]))
    expect(outcome.counts).toMatchObject({ created: 9, failed: 0, files: 2, filesKeptInSource: 1 })
    // "Notes (2)" is named apart from another page, not from a note of the person's.
    expect(outcome.namedApart).toEqual([])
    // Child A's sub-page was only found while rendering it, and Child A became a folder note
    // then; the link Home already had to it was fixed.
    expect(paths).not.toContain(`${FOLDER}/Home/Child A.md`)

    const home = note(ctx.fake, `${FOLDER}/Home/Home.md`)
    expect(home).toMatch(/^---\nid: n_fake\d+\ntitle: "Home"\nsource: notion\nnotion_id: 1a2b3c4d-0000-4000-8000-0000000003e9\n/)
    expect(home).toContain('# Welcome')
    expect(home).toContain('Some **bold** and a [link](https://example.com/a%20b) to [[Import from Notion/Home/Child A/Child A|Child A]].')
    expect(home).toContain('- Outer\n  - Inner\n1. First\n2. Second\n- [x] Done thing')
    expect(home).toContain("> [!note]- Details\n> Hidden text")
    expect(home).toContain('> [!note]\n> 💡 Heads up')
    expect(home).toContain('```javascript\nconst a = 1\n```')
    expect(home).toContain("```math\ne = mc^2\n```")
    expect(home).toContain('Inline maths: $`a^2 + b^2`$.')
    expect(home).toContain('> Quoted')
    expect(home).toContain('| Col A | Col B |\n| --- | --- |\n| a\\|1 | line1<br>line2 |')
    expect(home).toContain('![[Import from Notion/Home/_attachment/photo.png]]\n\n*A photo*')
    expect(home).toContain('![[Import from Notion/Home/_attachment/report.pdf]]')
    expect(home).toMatch(/\[archive\.zip \(in Notion\)\]\(https:\/\/www\.notion\.so\/[0-9a-f]{32}#[0-9a-f]{32}\)/)
    expect(home).toContain('[https://video.example.test/v](https://video.example.test/v)')
    expect(home).toContain('Left column\n\nRight column')
    expect(home).toContain('[[Import from Notion/Home/Notes|Notes]]\n\n[[Import from Notion/Home/Notes (2)|Notes (2)]]')
    expect(home).toContain('[[Import from Notion/Home/Tasks/Tasks|Tasks]]')
    const png = [...ctx.fake.notes.entries()].find(([p]) => p.endsWith('.png'))![1]
    expect(png).toBeInstanceOf(Uint8Array)

    expect(note(ctx.fake, `${FOLDER}/Home/Child A/Child A.md`)).toContain('Back to [[Import from Notion/Home/Home|Home]]')
    expect(note(ctx.fake, `${FOLDER}/Home/Child A/Deep page.md`)).toContain('Found only by walking')

    const db = note(ctx.fake, `${FOLDER}/Home/Tasks/Tasks.md`)
    expect(db).toContain('About Tasks')
    expect(db).toContain('| Name | Status | Due | Tags | Done | Related |')
    expect(db).toContain('| [[Import from Notion/Home/Tasks/Write report\\|Write report]] | Done | 2024-03-01 | alpha, beta | ✓ | [[Import from Notion/Home/Tasks/Plan trip\\|Plan trip]] |')
    const row = note(ctx.fake, `${FOLDER}/Home/Tasks/Write report.md`)
    expect(row).toContain('| Property | Value |\n| --- | --- |\n| Status | Done |')
    expect(row).toContain('| Related | [[Import from Notion/Home/Tasks/Plan trip\\|Plan trip]] |')
    expect(row).toContain('Row body')
  })

  it('files keep their Notion names: a second of one name is "(2)", and a re-import downloads none again', async () => {
    const ctx = setup()
    // A second file block of the same name on the page.
    const home = ctx.notion.pages.get(ctx.ids.home)!
    const pdf = home.blocks.find((b) => (b as { type?: string }).type === 'pdf')!
    ctx.notion.setBlocks(ctx.ids.home, [...home.blocks, { ...(pdf as object), id: '1a2b3c4d-0000-4000-8000-000000000999' }], '2024-04-01T00:00:00.000Z')
    expect((await run(ctx)).counts).toMatchObject({ files: 3 })
    const first = note(ctx.fake, `${FOLDER}/Home/Home.md`)
    expect(first).toContain('![[Import from Notion/Home/_attachment/report.pdf]]')
    expect(first).toContain('![[Import from Notion/Home/_attachment/report (2).pdf]]')
    const now = ctx.notion.pages.get(ctx.ids.home)!
    ctx.notion.setBlocks(ctx.ids.home, [para('Changed'), ...now.blocks], '2024-05-01T00:00:00.000Z')
    const again = await run(ctx)
    expect(again.counts).toMatchObject({ updated: 1, files: 0 })
    expect(note(ctx.fake, `${FOLDER}/Home/Home.md`)).toContain('![[Import from Notion/Home/_attachment/report (2).pdf]]')
    // A file an earlier version saved as name-<key> is the same file, not downloaded again.
    const old = `${FOLDER}/Home/_attachment/photo-${ctx.ids.imageBlock.replace(/-/g, '').slice(-10)}.png`
    ctx.fake.notes.set(old, ctx.fake.notes.get(`${FOLDER}/Home/_attachment/photo.png`)!)
    ctx.fake.notes.delete(`${FOLDER}/Home/_attachment/photo.png`)
    freshRecords(ctx)
    ctx.notion.setBlocks(ctx.ids.home, [para('Changed again'), ...now.blocks], '2024-06-01T00:00:00.000Z')
    expect((await run(ctx)).counts).toMatchObject({ files: 0 })
    expect(note(ctx.fake, `${FOLDER}/Home/Home.md`)).toContain(`![[${old}]]`)
  })

  it('a second run fetches no page that did not change, updates one that did, and keeps the person\'s edits', async () => {
    const ctx = setup()
    await run(ctx)
    ctx.notion.calls = []
    const again = await run(ctx)
    expect(again.counts).toMatchObject({ created: 0, updated: 0, unchanged: 9, kept: 0, failed: 0 })
    expect(ctx.notion.calls.filter((c) => c.includes('/children'))).toEqual([])

    // The person edits one note; Notion changes it and another.
    const childPath = `${FOLDER}/Home/Child A/Child A.md`
    const homePath = `${FOLDER}/Home/Home.md`
    const homeBefore = note(ctx.fake, homePath)
    const homeId = /^id: (\S+)/m.exec(homeBefore)![1]
    await ctx.fake.api.notes!.write(childPath, `${note(ctx.fake, childPath)}\nMy own line\n`)
    ctx.notion.setBlocks(ctx.ids.childA, [para('Changed in Notion')], '2024-05-01T00:00:00.000Z')
    const home = ctx.notion.pages.get(ctx.ids.home)!
    ctx.notion.setBlocks(ctx.ids.home, [para('New home text'), ...home.blocks.slice(-4)], '2024-05-01T00:00:00.000Z')
    const third = await run(ctx)
    expect(third.counts).toMatchObject({ updated: 1, kept: 1, failed: 0 })
    expect(third.keptPaths).toEqual([childPath])
    expect(note(ctx.fake, childPath)).toContain('My own line')
    const homeAfter = note(ctx.fake, homePath)
    expect(homeAfter).toContain('New home text')
    // The note keeps its vault id across the update.
    expect(homeAfter).toMatch(new RegExp(`^---\\nid: ${homeId}\\n`))
  })

  it('finds a note the person moved and updates it where it is', async () => {
    const ctx = setup()
    await run(ctx)
    await ctx.fake.api.notes!.move(`${FOLDER}/Second root.md`, `${FOLDER}/Archive/Second root.md`)
    ctx.notion.setBlocks(ctx.ids.second, [para('Moved and changed')], '2024-06-01T00:00:00.000Z')
    const again = await run(ctx)
    expect(again.counts).toMatchObject({ created: 0, updated: 1 })
    expect(ctx.fake.notes.has(`${FOLDER}/Second root.md`)).toBe(false)
    expect(note(ctx.fake, `${FOLDER}/Archive/Second root.md`)).toContain('Moved and changed')
  })

  it('links follow a note the person renamed, its record keeps the new place, and changed pages are listed', async () => {
    const ctx = setup()
    await run(ctx)
    const homePath = `${FOLDER}/Home/Home.md`
    await ctx.fake.api.notes!.move(`${FOLDER}/Home/Child A/Child A.md`, `${FOLDER}/Archive/Old child.md`)
    const again = await run(ctx)
    expect(again.counts).toMatchObject({ created: 0, updated: 0, failed: 0 })
    expect(again.updatedPaths).toEqual([])
    const home = note(ctx.fake, homePath)
    expect(home).toContain('[[Import from Notion/Archive/Old child|Child A]]')
    expect(home).not.toContain('Home/Child A/Child A|')
    // A third run finds everything where its record says: nothing to look for, nothing to write.
    const before = new Map(ctx.fake.notes)
    const third = await run(ctx)
    expect(third.counts).toMatchObject({ created: 0, updated: 0, unchanged: 9, failed: 0 })
    expect(new Map(ctx.fake.notes)).toEqual(before)
    // A page changed in Notion is named among the updated ones.
    ctx.notion.setBlocks(ctx.ids.second, [para('Changed')], '2024-06-01T00:00:00.000Z')
    const fourth = await run(ctx)
    expect(fourth.updatedPaths).toEqual([`${FOLDER}/Second root.md`])
  })

  it('takes Notion\'s version of an edited note when asked, keeping the person\'s beside it', async () => {
    const ctx = setup()
    await run(ctx)
    const childPath = `${FOLDER}/Home/Child A/Child A.md`
    await ctx.fake.api.notes!.write(childPath, `${note(ctx.fake, childPath)}\nMy own line\n`)
    ctx.notion.setBlocks(ctx.ids.childA, [para('Changed in Notion')], '2024-05-01T00:00:00.000Z')
    expect((await run(ctx)).keptPaths).toEqual([childPath])
    const client = new NotionClient(ctx.notion.token, { fetch: ctx.notion.fetch, sleep: async () => undefined })
    const taken = await runImport({ source: new NotionSource(client), notes: ctx.fake.api.notes!, mapping: ctx.mapping, folder: FOLDER, replace: [ctx.ids.childA], download: (u, m, s) => client.download(u, m, s), signal: new AbortController().signal, onProgress: () => undefined })
    const copy = `${FOLDER}/Home/Child A/Child A (your edit).md`
    expect(taken.replaced).toEqual([{ path: childPath, copy }])
    expect(taken.counts).toMatchObject({ updated: 1, kept: 0 })
    expect(note(ctx.fake, childPath)).toContain('Changed in Notion')
    expect(note(ctx.fake, childPath)).not.toContain('My own line')
    expect(note(ctx.fake, copy)).toContain('My own line')
    expect(note(ctx.fake, copy)).toContain('*Your version of [[Import from Notion/Home/Child A/Child A|Child A]]')
    expect(note(ctx.fake, copy)).not.toContain('notion_id')
    // The next run leaves both alone: the copy is the person's, the note as Notion has it.
    const again = await run(ctx)
    expect(again.counts).toMatchObject({ created: 0, updated: 0, kept: 0, failed: 0 })
    expect(note(ctx.fake, copy)).toContain('My own line')
  })

  it('a kind of block Notion does not share is one warning line, naming the pages it is in', async () => {
    const ctx = setup()
    const blocked = { object: 'block', type: 'unsupported', unsupported: {}, has_children: false }
    for (const id of [ctx.ids.home, ctx.ids.childA, ctx.ids.second]) {
      const page = ctx.notion.pages.get(id)!
      ctx.notion.setBlocks(id, [...page.blocks, { ...blocked, id: `blk-${id}` }], '2024-05-01T00:00:00.000Z')
    }
    const outcome = await run(ctx)
    const lines = outcome.warnings.filter((w) => w.startsWith('Notion does not share some blocks'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/: in 3 pages, "[^"]+", "[^"]+", "[^"]+"$/)
    expect(note(ctx.fake, `${FOLDER}/Second root.md`)).toMatch(/\*\[Open this part in Notion\]\(https:\/\/www\.notion\.so\//)
  })

  it('a link to a page outside the import keeps the page\'s title', async () => {
    const ctx = setup()
    // A relation names only the page's id: its title comes from what the connection showed.
    ctx.notion.setBlocks(ctx.ids.second, [para([{ type: 'mention', plain_text: '', mention: { type: 'page', page: { id: ctx.ids.home } }, annotations: {} } as never])], '2024-06-01T00:00:00.000Z')
    await run(ctx, { rootIds: [ctx.ids.second], folder: 'Only second' })
    expect(note(ctx.fake, 'Only second/Second root.md')).toMatch(/\[Home \(in Notion\)\]\(https:\/\/www\.notion\.so\/[0-9a-f]{32}\)/)
  })

  it('a link written while its page was outside the import points at its note once a later run brings it in', async () => {
    const ctx = setup()
    ctx.notion.setBlocks(ctx.ids.second, [para([{ type: 'mention', plain_text: 'Home', mention: { type: 'page', page: { id: ctx.ids.home } }, annotations: {} } as never])], '2024-06-01T00:00:00.000Z')
    await run(ctx, { rootIds: [ctx.ids.second] })
    expect(note(ctx.fake, `${FOLDER}/Second root.md`)).toContain('Home (in Notion)')
    // Everything now: Second root did not change in Notion, yet its link follows Home in.
    const outcome = await run(ctx)
    expect(outcome.counts).toMatchObject({ unchanged: 1, failed: 0, relinked: 1 })
    const second = note(ctx.fake, `${FOLDER}/Second root.md`)
    expect(second).not.toContain('(in Notion)')
    expect(second).toMatch(/\[\[Import from Notion\/Home[^\]|]*\|Home\]\]/)
    // Still as the import wrote it: the next run finds nothing to keep or update.
    expect((await run(ctx)).counts).toMatchObject({ kept: 0, updated: 0 })
  })

  it('a relation to a page that is not imported keeps that page\'s title', async () => {
    const ctx = setup()
    ;(ctx.notion as any).pages.get(ctx.ids.row2).trashed = true
    await run(ctx)
    const row = note(ctx.fake, `${FOLDER}/Home/Tasks/Write report.md`)
    expect(row).toMatch(/\[Plan trip \(in Notion\)\]\(https:\/\/www\.notion\.so\/[0-9a-f]{32}\)/)
    expect(row).not.toContain('Page in Notion')
  })

  it('imports only the chosen top-level pages, into any folder, without touching notes already there', async () => {
    const ctx = setup()
    await ctx.fake.api.notes!.write('Projects/Second root.md', 'my own note')
    const outcome = await run(ctx, { rootIds: [ctx.ids.second], folder: 'Projects' })
    expect(outcome.counts).toMatchObject({ created: 1 })
    expect(note(ctx.fake, 'Projects/Second root.md')).toContain('my own note')
    expect(note(ctx.fake, 'Projects/Second root (2).md')).toContain('Another tree')
    expect(outcome.namedApart).toEqual([{ path: 'Projects/Second root (2).md', beside: 'Projects/Second root.md' }])
    expect([...ctx.fake.notes.keys()].some((p) => p.includes('Home'))).toBe(false)
  })

  it('waits out rate limits and stops on a rejected secret', async () => {
    const ctx = setup()
    ctx.notion.rateLimitNext = 3
    const ok = await run(ctx)
    expect(ok.counts.failed).toBe(0)
    await expect(run(ctx, { token: fakeSecret('revoked') })).rejects.toMatchObject({ code: 'source_auth' })
  })

  it('tells an edited note from an unedited one with no record of the run that wrote it', async () => {
    const ctx = setup()
    await run(ctx)
    const childPath = `${FOLDER}/Home/Child A/Child A.md`
    await ctx.fake.api.notes!.write(childPath, `${note(ctx.fake, childPath)}\nMy own line\n`)
    freshRecords(ctx)
    ctx.notion.setBlocks(ctx.ids.childA, [para('Changed in Notion')], '2024-05-01T00:00:00.000Z')
    ctx.notion.setBlocks(ctx.ids.second, [para('Second changed')], '2024-05-01T00:00:00.000Z')
    const again = await run(ctx)
    expect(again.counts).toMatchObject({ created: 0, updated: 1, kept: 1, failed: 0 })
    expect(note(ctx.fake, childPath)).toContain('My own line')
    expect(note(ctx.fake, `${FOLDER}/Second root.md`)).toContain('Second changed')
  })

  it('finds a note moved out of the import folder instead of making it again', async () => {
    const ctx = setup()
    await run(ctx)
    await ctx.fake.api.notes!.move(`${FOLDER}/Second root.md`, 'Elsewhere/Second root.md')
    ctx.notion.setBlocks(ctx.ids.second, [para('Changed after the move')], '2024-06-01T00:00:00.000Z')
    const again = await run(ctx)
    expect(again.counts).toMatchObject({ created: 0, updated: 1, failed: 0 })
    expect(ctx.fake.notes.has(`${FOLDER}/Second root.md`)).toBe(false)
    expect(note(ctx.fake, 'Elsewhere/Second root.md')).toContain('Changed after the move')
  })

  it('starts at most three requests a second, and a 429 holds every request back', async () => {
    const ctx = setup()
    const slept: number[] = []
    // Its own secret: the pace is kept per secret, and other tests used the stand-in's.
    ctx.notion.token = fakeSecret('pace_test')
    const client = new NotionClient(ctx.notion.token, { fetch: ctx.notion.fetch, sleep: async (ms) => { slept.push(ms) } })
    const fakeNow = { t: 1_000_000 }
    const realNow = Date.now
    Date.now = () => fakeNow.t
    try {
      await Promise.all(Array.from({ length: 7 }, () => client.request('GET', `/v1/users/me`)))
      // Seven starts, one every 334 ms: the last one waits 6 gaps.
      expect(Math.max(...slept)).toBeGreaterThanOrEqual(6 * 333)
      slept.length = 0
      fakeNow.t += 60_000
      ctx.notion.rateLimitNext = 1
      await Promise.all([client.request('GET', '/v1/users/me'), client.request('GET', '/v1/users/me')])
      // The 429 paused the client: the retry and the other request both waited for it.
      expect(slept.filter((ms) => ms >= 1500).length).toBeGreaterThanOrEqual(1)
    } finally {
      Date.now = realNow
    }
  })

  it('a database found only as a block, cut off by a restart, comes back on the next run', async () => {
    // 2026-11-17, a real import: inline databases that a search for data sources does not list were
    // found while rendering their page; restarts cut the runs before they were written, and later
    // runs asked for them by id on the pages route, which answers a database id with a 400.
    const ctx = setup()
    const ds = ctx.notion.dataSources.get(ctx.ids.ds)!
    ds.hidden = true
    for (const id of [ctx.ids.row1, ctx.ids.row2]) ctx.notion.pages.get(id)!.hidden = true
    await run(ctx)
    const whole = [...ctx.fake.notes.keys()].sort()
    const under = `${FOLDER}/Home/Tasks/`
    expect(whole.filter((p) => p.startsWith(under)).length).toBeGreaterThan(1)
    // The cut: the database and its rows were never written, and nothing of them is on record.
    const rows = await ctx.mapping.all(FOLDER, 'notion')
    const files = await ctx.mapping.files(FOLDER, 'notion')
    for (const p of whole) if (p.startsWith(under)) ctx.fake.notes.delete(p)
    freshRecords(ctx)
    for (const [id, row] of rows) if (!row.path.startsWith(under)) await ctx.mapping.put(FOLDER, 'notion', id, row)
    for (const [key, path] of files) await ctx.mapping.putFile(FOLDER, 'notion', key, path)
    const again = await run(ctx)
    expect(again.counts.failed).toBe(0)
    expect([...ctx.fake.notes.keys()].sort()).toEqual(whole)
  })

  it('a link written before its page became a folder note leads to the folder note on the next run', async () => {
    // A run found a page's sub-pages while rendering it and made it a folder note, then a restart
    // cut the run before its end-of-run pass pointed the parent's link there.
    const ctx = setup()
    await run(ctx)
    const home = `${FOLDER}/Home/Home.md`
    const note = await ctx.fake.api.notes!.read(home)
    expect(note!.content).toContain(`[[${FOLDER}/Home/Child A/Child A|`)
    const stale = note!.content.replace(`[[${FOLDER}/Home/Child A/Child A|`, () => `[[${FOLDER}/Home/Child A|`)
    const written = await ctx.fake.api.notes!.write(home, withBody(stale, 'notion', bodyOf(stale)), { expectedHash: note!.hash })
    const [id, row] = [...(await ctx.mapping.all(FOLDER, 'notion'))].find(([, r]) => r.path === home)!
    await ctx.mapping.put(FOLDER, 'notion', id, { ...row, hash: written.hash })
    const again = await run(ctx)
    expect(again.counts.failed).toBe(0)
    const after = (await ctx.fake.api.notes!.read(home))!.content
    expect(after).toContain(`[[${FOLDER}/Home/Child A/Child A|`)
    expect(after).not.toContain(`[[${FOLDER}/Home/Child A|`)
    expect(again.counts.kept).toBe(0)
  })

  it('a page whose note a stopped run never wrote keeps its path: its own saved files hold no name', async () => {
    // A restart between a page's attachments and its note: the next run found the folder holding
    // only those files, named the page "Title (2)", and links written to "Title" led nowhere.
    const whole = setup()
    await run(whole)
    const expected = [...whole.fake.notes.keys()].sort()
    let cases = 0
    for (const at of expected.filter((p) => p.endsWith('.md'))) {
      const dir = at.slice(0, at.lastIndexOf('/'))
      const stem = at.slice(at.lastIndexOf('/') + 1, -3)
      // Every folder note: drop it and the notes under it, leave a file the importer saved there.
      if (dir.split('/').pop() !== stem || dir === FOLDER) continue
      cases++
      const ctx = setup()
      await run(ctx)
      const left = `${dir}/_attachment/left-over.png`
      ctx.fake.notes.set(left, ctx.fake.notes.get(`${FOLDER}/Home/_attachment/photo.png`)!)
      await ctx.mapping.putFile(FOLDER, 'notion', 'left-over-key', left)
      for (const p of [...ctx.fake.notes.keys()]) if (p.startsWith(`${dir}/`) && p.endsWith('.md')) ctx.fake.notes.delete(p)
      // The run that stopped wrote no record of those notes; its saved files are on record.
      const files = await ctx.mapping.files(FOLDER, 'notion')
      freshRecords(ctx)
      for (const [key, path] of files) await ctx.mapping.putFile(FOLDER, 'notion', key, path)
      const again = await run(ctx)
      expect(again.counts.failed).toBe(0)
      const now = [...ctx.fake.notes.keys()].filter((p) => p !== left).sort()
      expect(now, `the note of ${at} came back at its own path`).toEqual(expected)
    }
    expect(cases, Object.keys(Object.fromEntries(whole.fake.notes)).join('\n')).toBeGreaterThan(0)
  })

  it('a run stopped at any point, then run again, ends with the same notes as one that never stopped', async () => {
    const whole = setup()
    await run(whole)
    const expected = [...whole.fake.notes.keys()].sort()
    for (let stopAt = 1; stopAt <= 8; stopAt++) {
      const ctx = setup()
      const stop = new AbortController()
      let lateReports = 0
      let ended = false
      await expect(run(ctx, { signal: stop.signal, onProgress: (p) => { if (ended) lateReports++; if (p.counts.done >= stopAt) stop.abort(new Error('cancelled')) } })).rejects.toThrow()
      ended = true
      // Nothing goes on after the run ended.
      await new Promise((r) => setTimeout(r, 20))
      expect(lateReports, `stopped after ${stopAt}`).toBe(0)
      const again = await run(ctx)
      expect(again.counts.failed).toBe(0)
      expect([...ctx.fake.notes.keys()].sort(), `stopped after ${stopAt}`).toEqual(expected)
    }
  })

  it('leaves out a note the person deleted until its page changes, and starts afresh in an emptied folder', async () => {
    const ctx = setup()
    await run(ctx)
    const notesTwo = `${FOLDER}/Home/Notes (2).md`
    await ctx.fake.api.notes!.remove(notesTwo)
    const again = await run(ctx)
    expect(again.counts).toMatchObject({ created: 0, deleted: 1 })
    expect(again.deletedPaths).toEqual([notesTwo])
    expect(ctx.fake.notes.has(notesTwo)).toBe(false)
    // The whole folder deleted: everything comes in again.
    await ctx.fake.api.notes!.remove(FOLDER)
    const fresh = await run(ctx)
    expect(fresh.counts).toMatchObject({ created: 9, deleted: 0, failed: 0 })
    expect(ctx.fake.notes.has(notesTwo)).toBe(true)
  })

  it('a 429 that comes while a request waits its turn holds that request back too', async () => {
    const ctx = setup()
    ctx.notion.token = fakeSecret('pause_test')
    const slept: number[] = []
    const fakeNow = { t: 5_000_000 }
    const realNow = Date.now
    // A sleep that takes a moment, so the other request's 429 comes while this one sleeps.
    const client = new NotionClient(ctx.notion.token, { fetch: ctx.notion.fetch, sleep: async (ms) => { slept.push(ms); await new Promise((r) => setTimeout(r, 5)); fakeNow.t += ms } })
    Date.now = () => fakeNow.t
    try {
      ctx.notion.rateLimitNext = 1
      await Promise.all([client.request('GET', '/v1/users/me'), client.request('GET', '/v1/users/me')])
      // The second request slept its turn (a third of a second), then the 2 s pause the first one's
      // 429 started; the first one's retry waited that pause too.
      expect(slept[0]).toBeLessThan(500)
      expect(slept.filter((ms) => ms >= 1500).length).toBe(2)
    } finally {
      Date.now = realNow
    }
  })

  it('a new note never replaces one made at its place while the run went on', async () => {
    const ctx = setup()
    const real = ctx.fake.api.notes!
    const at = `${FOLDER}/Second root.md`
    let made = false
    const racing = new Proxy(real, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (key !== 'write') return typeof value === 'function' ? value.bind(target) : value
        return async (path: string, content: string, options?: unknown) => {
          // Someone writes a note at this path just before the import does.
          if (path === at && !made) { made = true; await real.write(at, 'my own note\n') }
          return (value as (...a: unknown[]) => unknown).call(target, path, content, options)
        }
      },
    })
    const client = new NotionClient(ctx.notion.token, { fetch: ctx.notion.fetch, sleep: async () => undefined })
    const outcome = await runImport({ source: new NotionSource(client), notes: racing, mapping: ctx.mapping, folder: FOLDER, download: (u, m, s) => client.download(u, m, s), signal: new AbortController().signal, onProgress: () => undefined })
    expect(outcome.counts.failed).toBe(0)
    expect(note(ctx.fake, at)).toMatch(/\nmy own note\n$/)
    expect(note(ctx.fake, `${FOLDER}/Second root (2).md`)).toContain('Second root')
    // The next run finds the imported note where it went.
    expect((await run(ctx)).counts).toMatchObject({ created: 0, failed: 0 })
    expect(note(ctx.fake, at)).toMatch(/\nmy own note\n$/)
  })

  it('never takes another import folder\'s copy of a page for a note moved out of this one', async () => {
    const ctx = setup()
    await run(ctx)
    await run(ctx, { folder: 'Second import' })
    await ctx.fake.api.notes!.remove(`${FOLDER}/Second root.md`)
    ctx.notion.setBlocks(ctx.ids.second, [para('Changed in Notion')], '2024-06-01T00:00:00.000Z')
    const again = await run(ctx)
    expect(again.counts).toMatchObject({ created: 1, updated: 0, failed: 0 })
    expect(note(ctx.fake, `${FOLDER}/Second root.md`)).toContain('Changed in Notion')
    // The other folder's copy changes only when that folder is imported.
    expect(note(ctx.fake, 'Second import/Second root.md')).not.toContain('Changed in Notion')
  })

  it('an emptied folder brings back pages an organize run merged away', async () => {
    const ctx = setup()
    await run(ctx)
    const notesTwo = `${FOLDER}/Home/Notes (2).md`
    await ctx.mapping.markMerged(FOLDER, 'notion', ctx.ids.notes2, `${FOLDER}/Home/Notes.md`)
    await ctx.fake.api.notes!.remove(notesTwo)
    expect((await run(ctx)).counts.created).toBe(0)
    await ctx.fake.api.notes!.remove(FOLDER)
    const fresh = await run(ctx)
    expect(fresh.counts).toMatchObject({ created: 9, failed: 0 })
    expect(ctx.fake.notes.has(notesTwo)).toBe(true)
  })

  it('keeps a note whose page was deleted in Notion, and says so', async () => {
    const ctx = setup()
    await run(ctx)
    const page = (ctx.notion as any).pages.get(ctx.ids.second)
    page.trashed = true
    const again = await run(ctx)
    expect(again.gonePaths).toEqual([`${FOLDER}/Second root.md`])
    expect(ctx.fake.notes.has(`${FOLDER}/Second root.md`)).toBe(true)
    expect(again.counts).toMatchObject({ created: 0, failed: 0 })
  })

  it('a link to a page trashed in Notion keeps its title', async () => {
    const ctx = setup()
    await run(ctx)
    ;(ctx.notion as any).pages.get(ctx.ids.row2).trashed = true
    await run(ctx)
    const db = note(ctx.fake, `${FOLDER}/Home/Tasks/Tasks.md`)
    expect(db).toContain('[[Import from Notion/Home/Tasks/Plan trip\\|Plan trip]]')
    expect(db).not.toContain('Untitled')
  })

  it('two pages of one title link as their notes are named', async () => {
    const ctx = setup()
    await run(ctx)
    const home = note(ctx.fake, `${FOLDER}/Home/Home.md`)
    expect(home).toContain('|Notes (2)]]')
    expect(home).toContain('/Home/Notes|Notes]]')
  })

  it('says plainly when Notion cannot be reached, after a few tries', async () => {
    let calls = 0
    const client = new NotionClient(fakeSecret('testsecret'), {
      fetch: (async () => { calls++; throw new TypeError('fetch failed: ECONNREFUSED') }) as unknown as typeof fetch,
      sleep: async () => undefined,
    })
    await expect(client.request('GET', '/v1/users/me')).rejects.toThrow('Walnut could not reach Notion. Check the internet connection, then try again.')
    expect(calls).toBe(3)
    expect(client.quietMs()).toBe(0)
  })

  it('a folder imported inside another keeps its own copies apart', async () => {
    const ctx = setup()
    await run(ctx)
    await run(ctx, { folder: `${FOLDER}/Work`, rootIds: [ctx.ids.second] })
    expect(ctx.fake.notes.has(`${FOLDER}/Work/Second root.md`)).toBe(true)
    ;(ctx.notion as any).setBlocks(ctx.ids.second, [para('Rewritten in Notion')], '2025-01-01T00:00:00.000Z')
    await run(ctx)
    // The outer folder updates its own note, never the inner folder's copy.
    expect(note(ctx.fake, `${FOLDER}/Second root.md`)).toContain('Rewritten in Notion')
    expect(note(ctx.fake, `${FOLDER}/Work/Second root.md`)).not.toContain('Rewritten in Notion')
    expect([...(await ctx.mapping.all(FOLDER, 'notion')).values()].map((r) => r.path)).toContain(`${FOLDER}/Second root.md`)
  })

  it('never asks Notion to change anything', async () => {
    const ctx = setup()
    await run(ctx)
    expect(ctx.notion.calls.filter((c) => !c.startsWith('GET ') && c !== 'POST /v1/search' && !/^POST \/v1\/data_sources\/[^/]+\/query$/.test(c))).toEqual([])
    const client = new NotionClient('ntn_x', { fetch: ctx.notion.fetch })
    await expect(client.request('PATCH', '/v1/pages/abc', {})).rejects.toThrow(/only reads/)
  })
})
