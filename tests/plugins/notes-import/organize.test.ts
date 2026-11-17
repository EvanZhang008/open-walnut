/**
 * Organize: a plan is checked against the folder before it is shown, applying it moves, merges
 * and writes index pages with every link fixed, a merged page stays merged on the next import,
 * and Undo reverses exactly what the run did: the vault comes back byte for byte when nothing
 * changed since, from a run cut off at any step too, and what the person changed or made after
 * the run stays theirs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeWalnut } from '../../../packages/plugin-api/src/testing.js'
import { runImport } from '../../../plugin-store/notes-import/src/server/importer'
import { rewriteLinks } from '../../../plugin-store/notes-import/src/server/links'
import { Mapping } from '../../../plugin-store/notes-import/src/server/mapping'
import { NotionClient } from '../../../plugin-store/notes-import/src/server/notion/client'
import { NotionSource } from '../../../plugin-store/notes-import/src/server/notion/source'
import { applyPlan, checkSteps, describeFolder, TREE_BUDGET, type PlanStep } from '../../../plugin-store/notes-import/src/server/organize'
import { Journal, undoRun, type JournalEntry } from '../../../plugin-store/notes-import/src/server/undo'
import type { NotesService } from '../../../packages/plugin-api/src/server'
import { para, standardWorkspace } from './fake-notion'

const F = 'Import from Notion'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

async function imported() {
  const { notion, ids } = standardWorkspace()
  const fake = createFakeWalnut({ pluginId: 'notes-import' })
  const mapping = new Mapping(fake.api.storage.database)
  const go = () => {
    const client = new NotionClient(notion.token, { fetch: notion.fetch, sleep: async () => undefined })
    return runImport({ source: new NotionSource(client), notes: fake.api.notes!, mapping, folder: F, download: (u, m, s) => client.download(u, m, s), signal: new AbortController().signal, onProgress: () => undefined })
  }
  await go()
  return { notion, ids, fake, mapping, go }
}

const text = (fake: ReturnType<typeof createFakeWalnut>, p: string) => fake.notes.get(p) as string

describe('organize', () => {
  it('rewrites links, table-escaped ones and embeds included, and leaves others alone', () => {
    const moves = new Map([['A/Old.md', 'A/New/Old.md'], ['A/_attachment/x.png', 'B/_attachment/x.png']])
    expect(rewriteLinks('see [[A/Old|Old]], [[A/Old]], | [[A/Old\\|Old]] |, ![[A/_attachment/x.png]], [[A/Other|O]]', moves))
      .toBe('see [[A/New/Old|Old]], [[A/New/Old]], | [[A/New/Old\\|Old]] |, ![[B/_attachment/x.png]], [[A/Other|O]]')
  })

  it('reads links Walnut\'s editor saved escaped, and writes them back bare', () => {
    const moves = new Map([['A/my_note.md', 'B/my_note.md']])
    expect(rewriteLinks('see \\[\\[A/my\\_note|Mine\\]\\] and \\[\\[A/Other\\]\\], | \\[\\[A/my\\_note\\|M\\]\\] |', moves))
      .toBe('see [[B/my_note|Mine]] and \\[\\[A/Other\\]\\], | [[B/my_note\\|M]] |')
    // A note with no link to a moved note is left byte for byte, escaped links and all.
    expect(rewriteLinks('only \\[\\[A/Other\\]\\]', moves)).toBe('only \\[\\[A/Other\\]\\]')
  })

  it('fixes and undoes links in a note Walnut\'s editor saved escaped', async () => {
    const { fake, mapping } = await imported()
    await fake.api.notes!.write('Journal/Today.md', `See \\[\\[${F}/Home/Child A/Child A|Child A\\]\\]\n`)
    const { journal, dataDir } = await startJournal()
    await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan: await planOf(fake, [STEPS[0]]), journal, onStep: () => undefined })
    expect(text(fake, 'Journal/Today.md')).toContain(`See [[${F}/Topics/Child A/Child A|Child A]]`)
    // Edited after the run: the edit stays, the link points back.
    await fake.api.notes!.write('Journal/Today.md', `${text(fake, 'Journal/Today.md')}more\n`)
    await undoRun({ notes: fake.api.notes!, mapping, dataDir, id: journal.info.id })
    expect(text(fake, 'Journal/Today.md')).toMatch(/\nSee \[\[Import from Notion\/Home\/Child A\/Child A\|Child A\]\]\nmore\n$/)
  })

  it('checks every step against the folder as the earlier steps leave it', async () => {
    const { fake } = await imported()
    const steps: PlanStep[] = [
      { kind: 'move', from: 'Second root.md', to: 'Archive/Second root.md', why: 'old' },
      { kind: 'move', from: 'Second root.md', to: 'Elsewhere.md', why: 'twice' },
      { kind: 'move', from: '../outside.md', to: 'x.md', why: 'escape' },
      { kind: 'move', from: 'Home/_attachment', to: 'Files', why: 'files' },
      { kind: 'merge', sources: ['Home/Notes (2).md'], into: 'Home/Notes.md', why: 'duplicate' },
      { kind: 'merge', sources: ['Home/Nope.md'], into: 'Home/Notes.md', why: 'missing' },
      { kind: 'index', path: 'Index.md', content: '[[Home/Home|Home]]', why: 'index' },
      { kind: 'index', path: 'Index.md', content: 'again', why: 'exists' },
    ]
    const checked = await checkSteps(fake.api.notes!, F, steps)
    expect(checked.map((c) => c.ok)).toEqual([true, false, false, false, true, false, true, false])
    expect(checked[1].problem).toMatch(/not in the folder/)
    expect(checked[3].problem).toMatch(/Attachment/)
  })

  it('applies moves, merges and index pages, fixes links, keeps merges on re-import, and undoes', async () => {
    const { fake, mapping, go } = await imported()
    await fake.api.notes!.write('Journal/Today.md', `See [[${F}/Home/Child A/Child A|Child A]] and [[${F}/Home/Notes (2)|the other]]\n`)
    const before = new Map(fake.notes)
    const rowsBefore = await mapping.all(F, 'notion')
    const { journal, dataDir } = await startJournal()

    const result = await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan: await planOf(fake, STEPS), journal, onStep: () => undefined })
    expect(result).toMatchObject({ applied: 3, skipped: [], openPath: `${F}/Index.md` })
    expect(fake.notes.has(`${F}/Topics/Child A/Child A.md`)).toBe(true)
    expect(fake.notes.has(`${F}/Topics/Child A/Deep page.md`)).toBe(true)
    expect(fake.notes.has(`${F}/Home/Child A/Child A.md`)).toBe(false)
    expect(fake.notes.has(`${F}/Home/Notes (2).md`)).toBe(false)
    const home = text(fake, `${F}/Home/Home.md`)
    expect(home).toContain(`[[${F}/Topics/Child A/Child A|Child A]]`)
    expect(home).toContain(`[[${F}/Home/Notes|Notes]]\n\n[[${F}/Home/Notes|Notes (2)]]`)
    expect(text(fake, `${F}/Home/Notes.md`)).toContain('First notes\n\n## Notes\n\nSecond notes')
    expect(text(fake, `${F}/Index.md`)).toContain(`[[${F}/Topics/Child A/Child A|Child A]]`)
    expect(text(fake, 'Journal/Today.md')).toMatch(/\nSee \[\[Import from Notion\/Topics\/Child A\/Child A\|Child A\]\] and \[\[Import from Notion\/Home\/Notes\|the other\]\]\n$/)

    // The next import updates moved notes where they are and does not bring the merged one back.
    const again = await go()
    expect(again.counts).toMatchObject({ created: 0, failed: 0 })
    expect(fake.notes.has(`${F}/Home/Notes (2).md`)).toBe(false)
    expect(fake.notes.has(`${F}/Home/Child A/Child A.md`)).toBe(false)

    const { kept } = await undoRun({ notes: fake.api.notes!, mapping, dataDir, id: journal.info.id })
    expect(kept).toEqual([])
    expectSame(fake, before)
    // The records are as before too: an import now changes nothing and brings nothing new.
    expect(await mapping.all(F, 'notion')).toEqual(rowsBefore)
    expect((await go()).counts).toMatchObject({ created: 0, updated: 0, failed: 0 })
    expectSame(fake, before)
  })

  it('a run cut off after any step is undone to exactly what was there before', async () => {
    const { fake, mapping } = await imported()
    await fake.api.notes!.write('Journal/Today.md', `See [[${F}/Home/Child A/Child A|Child A]]\n`)
    const pristine = new Map(fake.notes)
    const rowsBefore = await mapping.all(F, 'notion')
    const plan = await planOf(fake, STEPS)
    // How many lines a whole run writes down.
    const probe = await startJournal()
    await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan, journal: probe.journal, onStep: () => undefined })
    const lines = (await Journal.read(probe.dataDir, probe.journal.info.id)).entries.length
    await undoRun({ notes: fake.api.notes!, mapping, dataDir: probe.dataDir, id: probe.journal.info.id })
    expectSame(fake, pristine)
    expect(lines).toBeGreaterThan(5)
    for (let cut = 1; cut <= lines + 4; cut++) {
      // The process stops right after the cut-th line is written: the change it names is not made.
      const { journal, dataDir } = await startJournal()
      let n = 0
      const dying = { add: async (entry: JournalEntry) => { await journal.add(entry); if (++n === cut) throw new Error('stopped') } }
      await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan, journal: dying, onStep: () => undefined }).catch(() => undefined)
      await undoRun({ notes: fake.api.notes!, mapping, dataDir, id: journal.info.id })
      expectSame(fake, pristine, `cut after line ${cut}`)
      expect(await mapping.all(F, 'notion'), `records, cut after line ${cut}`).toEqual(rowsBefore)
      expect(await mapping.merged(F, 'notion'), `merged, cut after line ${cut}`).toEqual(new Set())
    }
  })

  it('an undo cut off part way can be run again, and a second undo changes nothing', async () => {
    const { fake, mapping } = await imported()
    const pristine = new Map(fake.notes)
    const plan = await planOf(fake, STEPS)
    for (let failAt = 1; failAt <= 12; failAt++) {
      const { journal, dataDir } = await startJournal()
      await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan, journal, onStep: () => undefined })
      // Notes whose writes fail from the failAt-th change on, as a service going away would.
      let n = 0
      const real = fake.api.notes!
      const failing = new Proxy(real, {
        get(target, key) {
          const value = Reflect.get(target, key)
          if (key !== 'write' && key !== 'move' && key !== 'remove') return typeof value === 'function' ? value.bind(target) : value
          return async (...args: unknown[]) => { if (++n >= failAt) throw new Error('notes went away'); return (value as (...a: unknown[]) => unknown).apply(target, args) }
        },
      })
      await undoRun({ notes: failing, mapping, dataDir, id: journal.info.id }).catch(() => undefined)
      await undoRun({ notes: real, mapping, dataDir, id: journal.info.id })
      expectSame(fake, pristine, `undo failed at change ${failAt}`)
      await undoRun({ notes: real, mapping, dataDir, id: journal.info.id })
      expectSame(fake, pristine, `second undo after failing at ${failAt}`)
    }
  })

  it('fixing links after a move keeps the person\'s edit theirs, and fixes links in notes outside the folder too', async () => {
    const { fake, mapping, go, notion, ids } = await imported()
    const homePath = `${F}/Home/Home.md`
    await fake.api.notes!.write(homePath, `${text(fake, homePath)}\nMy own line\n`)
    await fake.api.notes!.write('Journal/Today.md', `See [[${F}/Home/Child A/Child A|Child A]]\n`)
    const steps: PlanStep[] = [{ kind: 'move', from: 'Home/Child A', to: 'Topics/Child A', why: 'group' }]
    const { journal } = await startJournal()
    await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan: await planOf(fake, steps), journal, onStep: () => undefined })
    expect(text(fake, homePath)).toContain(`[[${F}/Topics/Child A/Child A|Child A]]`)
    expect(text(fake, 'Journal/Today.md')).toContain(`See [[${F}/Topics/Child A/Child A|Child A]]\n`)
    // Notion changes Home and Second root: the edited Home stays the person's, the other updates.
    notion.setBlocks(ids.home, [para('Notion rewrote home')], '2024-07-01T00:00:00.000Z')
    notion.setBlocks(ids.second, [para('Notion rewrote second')], '2024-07-01T00:00:00.000Z')
    const again = await go()
    expect(again.counts).toMatchObject({ kept: 1, failed: 0 })
    expect(text(fake, homePath)).toContain('My own line')
    expect(text(fake, `${F}/Second root.md`)).toContain('Notion rewrote second')
    // A relinked note the person never touched still counts as untouched.
    expect(text(fake, `${F}/Topics/Child A/Child A.md`)).not.toContain('My own line')
  })

  it('never moves a folder holding a file notes cannot keep', async () => {
    const { fake } = await imported()
    fake.notes.set(`${F}/Home/data.csv`, 'a,b\n')
    const checked = await checkSteps(fake.api.notes!, F, [{ kind: 'move', from: 'Home', to: 'Topics/Home', why: 'x' }])
    expect(checked[0]).toMatchObject({ ok: false })
    expect(checked[0].problem).toMatch(/data\.csv/)
  })

  it('Undo keeps what the person changed or made after the organize run', async () => {
    const { fake, mapping } = await imported()
    await fake.api.notes!.write('Journal/Today.md', `See [[${F}/Home/Child A/Child A|Child A]]\n`)
    const { journal, dataDir } = await startJournal()
    await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan: await planOf(fake, STEPS), journal, onStep: () => undefined })
    const homePath = `${F}/Home/Home.md`
    const moved = `${F}/Topics/Child A/Deep page.md`
    // After the run: a moved note is edited, a relinked note is edited, the index is edited,
    // a new note takes the old place of a moved one, and one more note is made.
    await fake.api.notes!.write(moved, `${text(fake, moved)}\nWritten after organizing\n`)
    await fake.api.notes!.write(homePath, `${text(fake, homePath)}\nMy line after\n`)
    await fake.api.notes!.write(`${F}/Index.md`, `${text(fake, `${F}/Index.md`)}\nmy index line\n`)
    await fake.api.notes!.write(`${F}/Home/Child A/Child A.md`, 'a new note in the old place\n')
    await fake.api.notes!.write(`${F}/My new note.md`, 'mine\n')
    await fake.api.notes!.write('Journal/Today.md', `${text(fake, 'Journal/Today.md')}more\n`)

    const { kept } = await undoRun({ notes: fake.api.notes!, mapping, dataDir, id: journal.info.id })
    // The edited moved note goes back with its edit.
    expect(text(fake, `${F}/Home/Child A/Deep page.md`)).toContain('Written after organizing')
    expect(fake.notes.has(moved)).toBe(false)
    // The new note in the old place stays; the note that was moved from there stays where it went.
    expect(text(fake, `${F}/Home/Child A/Child A.md`)).toMatch(/\na new note in the old place\n$/)
    expect(fake.notes.has(`${F}/Topics/Child A/Child A.md`)).toBe(true)
    // Edited notes keep the edit and only have their links pointed back, to where each note is
    // after the undo: Child A stayed where it went.
    const home = text(fake, homePath)
    expect(home).toContain('My line after')
    expect(home).toContain(`[[${F}/Topics/Child A/Child A|Child A]]`)
    expect(text(fake, 'Journal/Today.md')).toMatch(/\nSee \[\[Import from Notion\/Topics\/Child A\/Child A\|Child A\]\]\nmore\n$/)
    expect(text(fake, `${F}/Index.md`)).toContain('my index line')
    expect(text(fake, `${F}/My new note.md`)).toMatch(/\nmine\n$/)
    // The merged note is back, its target as before.
    expect(fake.notes.has(`${F}/Home/Notes (2).md`)).toBe(true)
    expect(text(fake, `${F}/Home/Notes.md`)).not.toContain('## Notes')
    expect(kept.sort()).toEqual([`${F}/Home/Child A/Child A.md`, homePath, `${F}/Index.md`, 'Journal/Today.md'].sort())
  })

  it('a merge undone beside a note made at its place since keeps both', async () => {
    const { fake, mapping } = await imported()
    const { journal, dataDir } = await startJournal()
    await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan: await planOf(fake, [STEPS[1]]), journal, onStep: () => undefined })
    await fake.api.notes!.write(`${F}/Home/Notes (2).md`, 'someone else\n')
    await undoRun({ notes: fake.api.notes!, mapping, dataDir, id: journal.info.id })
    expect(text(fake, `${F}/Home/Notes (2).md`)).toMatch(/\nsomeone else\n$/)
    expect(text(fake, `${F}/Home/Notes (2) (restored).md`)).toContain('Second notes')
  })

  it('a move that cannot go back leaves every link pointing at where the note stays', async () => {
    const { fake, mapping } = await imported()
    const { journal, dataDir } = await startJournal()
    await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan: await planOf(fake, [STEPS[0]]), journal, onStep: () => undefined })
    expect(text(fake, `${F}/Home/Home.md`)).toContain(`[[${F}/Topics/Child A/Child A|Child A]]`)
    // A note made at the old place since: the moved one stays where it is.
    await fake.api.notes!.write(`${F}/Home/Child A/Child A.md`, 'mine\n')
    const { kept } = await undoRun({ notes: fake.api.notes!, mapping, dataDir, id: journal.info.id })
    expect(kept).toContain(`${F}/Home/Child A/Child A.md`)
    expect(text(fake, `${F}/Home/Child A/Child A.md`)).toMatch(/mine\n$/)
    expect(fake.notes.has(`${F}/Topics/Child A/Child A.md`)).toBe(true)
    // Home is back as the import wrote it, its link following the note that stayed.
    expect(text(fake, `${F}/Home/Home.md`)).toContain(`[[${F}/Topics/Child A/Child A|Child A]]`)
    expect(text(fake, `${F}/Home/Home.md`)).not.toContain(`[[${F}/Home/Child A/Child A|`)
  })

  it('organizing a folder inside the import keeps the import\'s records', async () => {
    const { fake, mapping, go } = await imported()
    const sub = `${F}/Home`
    const plan = { folder: sub, summary: 's', steps: await checkSteps(fake.api.notes!, sub, [{ kind: 'move', from: 'Child A', to: 'Topics/Child A', why: 'group' }]), madeAt: '' }
    const { journal } = await startJournal()
    await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan, journal, onStep: () => undefined })
    const paths = [...(await mapping.all(F, 'notion')).values()].map((r) => r.path)
    expect(paths).toContain(`${sub}/Topics/Child A/Child A.md`)
    expect(paths).not.toContain(`${sub}/Child A/Child A.md`)
    // The next import finds the moved note and the relinked Home as its own: nothing doubled, nothing kept as edited.
    const result = await go()
    expect(fake.notes.has(`${sub}/Child A/Child A.md`)).toBe(false)
    expect(result.counts.kept ?? 0).toBe(0)
  })

  it('a merge source edited while organizing is kept, and is not marked merged', async () => {
    const { fake, mapping } = await imported()
    const notes = fake.api.notes!
    const source = `${F}/Home/Notes (2).md`
    // The person edits the source just as the merged note is written.
    const edited: NotesService = { ...notes, write: async (p, c, o) => {
      const out = await notes.write(p, c, o)
      if (p === `${F}/Home/Notes.md`) await notes.write(source, `${text(fake, source)}late edit\n`)
      return out
    } } as NotesService
    const { journal, dataDir } = await startJournal()
    const result = await applyPlan({ notes: edited, mapping, sourceId: 'notion', plan: await planOf(fake, [STEPS[1]]), journal, onStep: () => undefined })
    expect(result.skipped.map((s) => s.problem).join()).toMatch(/changed while organizing/)
    expect(text(fake, source)).toContain('late edit')
    expect((await mapping.merged(F, 'notion')).size).toBe(0)
    // Undo brings back nothing the run did not remove: no stale copy beside the edited one.
    const { kept } = await undoRun({ notes, mapping, dataDir, id: journal.info.id })
    expect([...fake.notes.keys()].filter((p) => p.includes('restored'))).toEqual([])
    expect(text(fake, source)).toContain('late edit')
    expect(kept).not.toContain(source)
    expect([...(await mapping.all(F, 'notion')).values()].some((r) => r.path === source)).toBe(true)
  })

  it('an index in a subfolder links each note it means, and says which links matched none', async () => {
    const { fake, mapping } = await imported()
    const content = '# Home\n\n- [[Notes|Notes]]\n- [[Child A/Deep page|Deep]]\n- [[Child A]]\n- [[Home/Tasks/Tasks.md|Tasks]]\n- [[Nowhere|Gone]]\n'
    const [step] = await checkSteps(fake.api.notes!, F, [{ kind: 'index', path: 'Home/Index.md', content, why: 'index' }])
    expect(step.ok).toBe(true)
    expect((step.step as { content: string }).content).toBe('# Home\n\n- [[Home/Notes|Notes]]\n- [[Home/Child A/Deep page|Deep]]\n- [[Home/Child A/Child A]]\n- [[Home/Tasks/Tasks|Tasks]]\n- Gone\n')
    expect(step.note).toBe('1 of its 5 links matched no note, so they are plain text')
    const { journal } = await startJournal()
    await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan: { folder: F, summary: 's', steps: [step], madeAt: '' }, journal, onStep: () => undefined })
    const written = text(fake, `${F}/Home/Index.md`)
    for (const m of written.matchAll(/\[\[([^\]|]+)/g)) expect(fake.notes.has(`${m[1]}.md`)).toBe(true)
    // Bare lines of links, or a run of links on one line, become one list item per note.
    const [bare] = await checkSteps(fake.api.notes!, F, [{ kind: 'index', path: 'Home/Bare.md', content: '# Home\n\n[[Notes|Notes]]\n[[Child A]] [[Tasks/Tasks|Tasks]]\nSee [[Notes]] for more\n', why: 'index' }])
    expect((bare.step as { content: string }).content).toBe('# Home\n\n- [[Home/Notes|Notes]]\n- [[Home/Child A/Child A]]\n- [[Home/Tasks/Tasks|Tasks]]\n- See [[Home/Notes]] for more\n')
    // An index none of whose links match a note is not written at all.
    const [none] = await checkSteps(fake.api.notes!, F, [{ kind: 'index', path: 'Home/Other index.md', content: '- [[Day 1]]\n- [[Day 2]]\n', why: 'index' }])
    expect(none).toMatchObject({ ok: false, problem: 'None of its links match a note in the folder' })
  })

  it('an index links another index the same plan makes, before or after it, and drops its line to one that fails', async () => {
    const { fake } = await imported()
    const steps: PlanStep[] = [
      { kind: 'index', path: 'Index.md', content: '- [[Home/Home index|Home index]]\n- [[Home/Notes]]\n- [[Broken index]]\n', why: 'top' },
      { kind: 'index', path: 'Home/Home index.md', content: '- [[Notes]]\n- [[Child A]]\n- [[Index]]\n', why: 'home' },
      { kind: 'index', path: 'Broken index.md', content: '- [[Nowhere]]\n', why: 'fails' },
    ]
    const [top, home, broken] = await checkSteps(fake.api.notes!, F, steps)
    expect(top.ok && home.ok).toBe(true)
    expect(broken.ok).toBe(false)
    // The line to the index that fails goes with it.
    expect((top.step as { content: string }).content).toBe('- [[Home/Home index|Home index]]\n- [[Home/Notes]]\n')
    expect((home.step as { content: string }).content).toContain('- [[Index]]')
    expect(top.note).toBeUndefined()
  })

  it('a line in an index to an index the plan leaves out goes with it', async () => {
    const { fake } = await imported()
    const steps: PlanStep[] = [
      { kind: 'index', path: 'Index.md', content: '- [[Home/Home index|Home index]]\n- [[Home/Notes]]\n', why: 'top' },
      { kind: 'index', path: 'Home/Home index.md', content: '- [[Notes]]\n', why: 'home' },
    ]
    const [top] = await checkSteps(fake.api.notes!, F, [steps[0]], undefined, new Set(['Home/Home index.md']))
    expect(top.ok).toBe(true)
    expect((top.step as { content: string }).content).toBe('- [[Home/Notes]]\n')
    expect(top.note).toBeUndefined()
  })

  it('merging a page whose text the target already has adds nothing to the target', async () => {
    const { fake, mapping } = await imported()
    const notes = fake.api.notes!
    const into = `${F}/Home/Notes.md`
    const source = `${F}/Home/Notes (2).md`
    const split = (s: string) => { const end = s.indexOf('\n---\n', 4) + 5; return [s.slice(0, end), s.slice(end)] }
    const [sourceHead] = split(text(fake, source))
    const [, intoBody] = split(text(fake, into))
    await notes.write(source, sourceHead + intoBody)
    const before = text(fake, into)
    const { journal } = await startJournal()
    const result = await applyPlan({ notes, mapping, sourceId: 'notion', plan: await planOf(fake, [STEPS[1]]), journal, onStep: () => undefined })
    expect(result.skipped).toEqual([])
    expect(fake.notes.has(source)).toBe(false)
    expect(text(fake, into)).toBe(before)
  })

  it('a move that failed leaves links to the note where it is, and Undo keeps them', async () => {
    const { fake, mapping } = await imported()
    const notes = fake.api.notes!
    // A note appears at the target just as the move is made, so the move fails.
    const failing: NotesService = { ...notes, move: async (from, to) => {
      if (from === `${F}/Second root.md`) throw Object.assign(new Error('A note is already there'), { code: 'note_exists' })
      return notes.move(from, to)
    } } as NotesService
    await notes.write('Journal/Today.md', `See [[${F}/Second root|Second root]] and [[${F}/Home/Child A/Child A|A]]\n`)
    const { journal, dataDir } = await startJournal()
    const result = await applyPlan({ notes: failing, mapping, sourceId: 'notion', plan: await planOf(fake, [
      { kind: 'move', from: 'Second root.md', to: 'Archive/Second root.md', why: 'old' }, STEPS[0],
    ]), journal, onStep: () => undefined })
    expect(result.skipped.map((s) => s.problem).join()).toMatch(/made there meanwhile/)
    expect(text(fake, 'Journal/Today.md')).toContain(`[[${F}/Second root|Second root]]`)
    await notes.write(`${F}/Archive/Second root.md`, 'someone else\n')
    await undoRun({ notes, mapping, dataDir, id: journal.info.id })
    expect(text(fake, 'Journal/Today.md')).toContain(`[[${F}/Second root|Second root]]`)
    expect(text(fake, 'Journal/Today.md')).toContain(`[[${F}/Home/Child A/Child A|A]]`)
  })

  it('a link to a heading of a moved note follows it', () => {
    const moves = new Map([['A/Note.md', 'B/Note.md']])
    expect(rewriteLinks('[[A/Note#Plan|plan]] [[A/Note#^b1]] \\[\\[A/Note#Plan\\]\\]', moves)).toBe('[[B/Note#Plan|plan]] [[B/Note#^b1]] [[B/Note#Plan]]')
  })

  it('stops between changes when the plugin stops, and Undo reverses what it did', async () => {
    const { fake, mapping } = await imported()
    const before = new Map(fake.notes)
    const { journal, dataDir } = await startJournal()
    const stop = new AbortController()
    await expect(applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan: await planOf(fake, STEPS), journal, signal: stop.signal,
      onStep: (done) => { if (done === 1) stop.abort() } })).rejects.toThrow(/stopped/)
    expect(fake.notes.has(`${F}/Topics/Child A/Child A.md`)).toBe(true)
    expect(fake.notes.has(`${F}/Index.md`)).toBe(false)
    await undoRun({ notes: fake.api.notes!, mapping, dataDir, id: journal.info.id })
    expectSame(fake, before)
  })

  it('an index links its notes where they are when their moves were left out', async () => {
    const { fake, mapping } = await imported()
    const all: PlanStep[] = [
      { kind: 'move', from: 'Second root.md', to: 'Archive/Second root.md', why: 'old' },
      { kind: 'move', from: 'Home/Child A', to: 'Topics/Child A', why: 'group' },
      { kind: 'index', path: 'Index.md', content: '- [[Archive/Second root|Second root]]\n- [[Topics/Child A/Child A|Child A]]\n- [[Topics/Child A/Deep page|Deep]]\n', why: 'index' },
    ]
    // The plan is checked whole; the person left out the first move: Second root stays, the index
    // links it there.
    const full = await planOf(fake, all)
    const { journal } = await startJournal()
    await applyPlan({ notes: fake.api.notes!, mapping, sourceId: 'notion', plan: { ...full, steps: full.steps.slice(1) }, allSteps: all, journal, onStep: () => undefined })
    const index = text(fake, `${F}/Index.md`)
    expect(index).toContain(`[[${F}/Second root|Second root]]`)
    expect(index).toContain(`[[${F}/Topics/Child A/Child A|Child A]]`)
    expect(index).toContain(`[[${F}/Topics/Child A/Deep page|Deep]]`)
    expect(fake.notes.has(`${F}/Archive/Second root.md`)).toBe(false)
  })

  it('never renames a note or folder it moves', async () => {
    const { fake } = await imported()
    const checked = await checkSteps(fake.api.notes!, F, [
      { kind: 'move', from: 'Second root.md', to: 'Archive/Old root.md', why: 'rename' },
      { kind: 'move', from: 'Home/Child A', to: 'Topics/Kid', why: 'rename folder' },
      { kind: 'move', from: 'Second root.md', to: 'Archive/Second root.md', why: 'fine' },
    ])
    expect(checked.map((c) => c.ok)).toEqual([false, false, true])
    expect(checked[0].problem).toMatch(/keeps the names/)
  })

  it('keeps the last few journals and always the newest', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ni-journal-'))
    dirs.push(dataDir)
    const made: string[] = []
    for (let i = 0; i < 8; i++) made.push((await Journal.start(dataDir, F)).info.id)
    const left = fs.readdirSync(path.join(dataDir, 'organize')).map((n) => n.replace(/\.jsonl$/, ''))
    expect(left.length).toBe(5)
    expect(left).toContain(made.at(-1))
  })
})

const STEPS: PlanStep[] = [
  { kind: 'move', from: 'Home/Child A', to: 'Topics/Child A', why: 'group' },
  { kind: 'merge', sources: ['Home/Notes (2).md'], into: 'Home/Notes.md', why: 'duplicate' },
  { kind: 'index', path: 'Index.md', content: '# Index\n\n- [[Topics/Child A/Child A|Child A]]\n', why: 'index' },
]

async function planOf(fake: ReturnType<typeof createFakeWalnut>, steps: PlanStep[]) {
  return { folder: F, summary: 's', steps: await checkSteps(fake.api.notes!, F, steps), madeAt: '' }
}

async function startJournal() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ni-journal-'))
  dirs.push(dataDir)
  return { dataDir, journal: await Journal.start(dataDir, F) }
}

function expectSame(fake: ReturnType<typeof createFakeWalnut>, before: Map<string, unknown>, label = '') {
  const now = new Map(fake.notes)
  expect([...now.keys()].sort(), label).toEqual([...before.keys()].sort())
  for (const [p, v] of before) expect(now.get(p), `${label} ${p}`).toEqual(v)
}

describe('the folder picture for a plan', () => {
  it('fits one AI request for a big import with long names, and lists every folder', async () => {
    // 2026-11-17, a real 4567-note import: the plan request was over ai.run's 200,000 characters.
    const name = '\u4e3b\u89c2\u7684\u6211 - Idea - Feeling - My Output - Routine'
    const entries: Array<{ path: string; type: 'folder' | 'note'; size: number }> = []
    for (let d = 0; d < 300; d++) {
      entries.push({ path: `${F}/${name} ${d}`, type: 'folder', size: 0 })
      for (let n = 0; n < 20; n++) entries.push({ path: `${F}/${name} ${d}/Daily Review (${n}) of a long day.md`, type: 'note', size: 8000 })
    }
    const notes = { list: async () => entries } as unknown as NotesService
    const { text, noteCount } = await describeFolder(notes, F)
    expect(noteCount).toBe(6000)
    expect(JSON.stringify({ folder: F, notes: noteCount, tree: text }).length).toBeLessThan(TREE_BUDGET + 1000)
    for (let d = 0; d < 300; d++) expect(text).toContain(`${name} ${d}/\n`)
    expect(text).toMatch(/… and \d+ more entries/)
  })

  it('lists a small folder whole', async () => {
    const notes = { list: async () => [{ path: `${F}/A`, type: 'folder', size: 0 }, { path: `${F}/A/B.md`, type: 'note', size: 3 }] } as unknown as NotesService
    expect((await describeFolder(notes, F)).text).toBe('A/\nA/B.md  (3 bytes)')
  })
})
