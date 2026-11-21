/**
 * The pain registry (src/core/org/reflection/pains.ts, pain-record.ts): a complaint the reflection
 * found is filed under the pain the judge matched or opens a new unowned one, his picture is kept
 * next to the registry, and the nightly note lists what has no rule or test and every guard test
 * not known to pass. And the thread card check (candidates.ts): a card waiting on his decision is
 * judged once per version, with its summary and buttons as he reads them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-pains'))

import { IMAGES_DIR, WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import {
  addComplaint, guardRunOf, lacksGenericDefault, normalizePain, painsFileOf, painsMarkdownOf, painsNightlyText, painsReport, renderPains, statusOf,
  resolvePainPath, GUARD_RUN_STALE_MS, PAIN_QUOTES_MAX, type PainEntry, type PainReport,
} from '../../../src/core/org/reflection/pains.js'
import { readPains, updatePains, writeGuardRun, readGuardRun } from '../../../src/core/org/reflection/pains-store.js'
import { importPains, painsPendingOf } from '../../../src/core/org/reflection/pain-record.js'
import { reflectForNode, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import { cardText, collectCandidates, type ReflectionThread } from '../../../src/core/org/reflection/candidates.js'
import { verifyFinding } from '../../../src/core/org/reflection/judge.js'
import { nightlyNote } from '../../../src/core/org/reflection/nightly.js'
import { readDayEntries } from '../../../src/core/org/reflection/records.js'
import { localDate, updateReflectionState } from '../../../src/core/org/reflection/state.js'
import { threadsFromRecords } from '../../../src/core/org/reflection/inputs.js'

const NOW = Date.parse('2026-11-19T20:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS', session_id: 'sess-vp' } as Task
const worker = { id: 'w-1', title: 'Upgrade the dock page', project: 'Marina', phase: 'IN_PROGRESS', session_id: 'sess-1' } as Task
const BEFORE = 'Shipped the new card layout.'

const report = (over: Partial<PainReport> = {}): PainReport => ({
  sameAs: '', title: 'Cards lose their reply', scope: 'all_users', kind: 'regression',
  quote: { at: iso(10), text: 'the reply under the card used to show', taskId: worker.id }, rootCause: 'The layout change dropped it.',
  owner: { taskId: worker.id, title: worker.title }, ...over,
})

const verdict = (pain: unknown, over: Record<string, unknown> = {}) => JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
  kind: 'regression', session_quote: BEFORE, user_quote: 'used to show', rule_quote: '', what_went_wrong: 'The card lost its reply.',
  correct_action: 'Bring the reply back.', already_fixed: false, correction: 'Bring the reply back under the card.',
  guidance: 'Keep what a card showed when its layout changes.', same_as: 0, skill: null, pain, ...over,
} })

function deps(over: Partial<ReflectDeps> & { threads?: ReflectionThread[]; messages?: Array<{ id: string; at: string; text: string; images?: string[] }>; answers?: string[] } = {}) {
  const prompts: string[] = []
  const answers = [...(over.answers ?? [])]
  const d: ReflectDeps = {
    readTranscript: async () => [
      { role: 'assistant', text: BEFORE, timestamp: iso(200) },
      ...(over.messages ?? []).map((m) => ({ role: 'user', text: m.text, timestamp: m.at, sentBy: 'person' })),
    ] as never,
    readMessages: async (id) => (id === worker.id ? over.messages ?? [] : []),
    readThreads: async (id) => (id === vp.id ? over.threads ?? [] : []),
    callModel: async (_s, user) => { prompts.push(user); return answers.shift() ?? verdict(null) },
    send: async () => true,
    confirmSend: async () => true,
    rulesText: async () => '',
    replyLanguage: async () => null,
    nowMs: () => NOW,
    ...over,
  }
  return { d, prompts }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await updateReflectionState(vp.id, (s) => { s.since = iso(23 * 60) }, NOW)
})

describe('the registry', () => {
  it('a complaint opens a new unowned pain, and one the judge matched is added to it', () => {
    const first = addComplaint([], report())
    expect(first.isNew).toBe(true)
    expect(first.entries[0]).toMatchObject({ title: 'Cards lose their reply', status: 'unowned', count: 1, owner: { taskId: worker.id } })
    const again = addComplaint(first.entries, report({ sameAs: first.id, quote: { at: iso(5), text: 'it is gone again' } }))
    expect(again).toMatchObject({ isNew: false, id: first.id })
    expect(again.entries).toHaveLength(1)
    expect(again.entries[0]).toMatchObject({ count: 2, lastAt: iso(5) })
  })

  it('the same words twice (a thread message and its task) count once, and only the newest quotes are kept', () => {
    let { entries, id } = addComplaint([], report())
    entries = addComplaint(entries, report({ sameAs: id })).entries
    expect(entries[0].count).toBe(1)
    for (let i = 0; i < PAIN_QUOTES_MAX + 3; i++) entries = addComplaint(entries, report({ sameAs: id, quote: { at: iso(9 - i), text: `again ${i}` } })).entries
    expect(entries[0].quotes).toHaveLength(PAIN_QUOTES_MAX)
    expect(entries[0].quotes.at(-1)!.text).toBe(`again ${PAIN_QUOTES_MAX + 2}`)
  })

  it('no rule or no test reads unowned whatever status was written', () => {
    const base = { status: 'live' as const }
    expect(statusOf({ ...base })).toBe('unowned')
    expect(statusOf({ ...base, rule: { where: 'docs/x.md', text: '' } })).toBe('unowned')
    expect(statusOf({ ...base, rule: { where: 'docs/x.md', text: '' }, test: { file: 'tests/x.test.ts', name: 'x' } })).toBe('live')
  })

  it('a hand-edited entry reads back with what is malformed left out', () => {
    expect(normalizePain({ title: 'no id' })).toBeNull()
    const e = normalizePain({ id: 'pn-1', title: 'T', status: 'done', scope: 'everyone', test: { file: 'tests/x.ts' }, quotes: [{ at: iso(1), text: 'w' }, { text: 'no time' }] })!
    expect(e).toMatchObject({ status: 'unowned', scope: 'all_users', count: 1 })
    expect(e.test).toBeUndefined()
    expect(e.quotes).toHaveLength(1)
  })

  it('the Markdown lists unowned pains first, with his words, the rule, the test and the owner', () => {
    const owned: PainEntry = { ...addComplaint([], report({ title: 'Owned pain' })).entries[0], id: 'pn-owned', status: 'live', rule: { where: 'docs/a.md', text: 'Keep it.' }, test: { file: 'tests/a.test.ts', name: 'keeps it' } }
    const open = addComplaint([], report()).entries[0]
    const md = renderPains('Marina VP', [owned, open], { schemaVersion: 1, at: iso(1), results: { 'pn-owned': { result: 'passed' } } })
    expect(md.indexOf('## Unowned')).toBeLessThan(md.indexOf('## Live'))
    expect(md).toContain('His words')
    expect(md).toContain('tests/a.test.ts "keeps it" (last run: passed)')
    expect(md).toContain(`Owner: ${worker.title} (${worker.id})`)
  })
})

describe('what the registry flags', () => {
  it('a pain every user meets lacks a generic default unless its rule is in the product\'s own code', () => {
    const all = { scope: 'all_users' as const }
    expect(lacksGenericDefault({ ...all, rule: { where: 'USER.md: How to respond', text: '' } })).toBe(true)
    expect(lacksGenericDefault({ ...all, rule: { where: '/x/guidance.md line 3', text: '' } })).toBe(true)
    expect(lacksGenericDefault({ ...all, rule: { where: '.claude/skills/ui/SKILL.md rule 4', text: '' } })).toBe(true)
    expect(lacksGenericDefault({ ...all, rule: { where: 'src/core/team-charter.ts line 58; USER.md', text: '' } })).toBe(false)
    expect(lacksGenericDefault({ ...all, rule: { where: '/x/walnut/src/core/a.ts', text: '' } })).toBe(false)
    expect(lacksGenericDefault({ ...all, rule: { where: 'web/src/AGENTS.md', text: '' } })).toBe(true)
    expect(lacksGenericDefault({ ...all, rule: { where: 'src/core/AGENTS.md', text: '' } })).toBe(true)
    expect(lacksGenericDefault({ scope: 'only_him', rule: { where: 'USER.md', text: '' } })).toBe(false)
    expect(lacksGenericDefault({ ...all })).toBe(false)
  })

  it('a guard run with no time, or a result it does not know, is read as nothing', () => {
    expect(guardRunOf({ results: {} })).toBeNull()
    expect(guardRunOf({ at: 'soon', results: {} })).toBeNull()
    expect(guardRunOf({ at: iso(1), results: { a: { result: 'passed' }, b: { result: 'great' } } })!.results).toEqual({ a: { result: 'passed' } })
  })
})

describe('the nightly report of the registry', () => {
  const guarded = (id: string): PainEntry => ({ ...addComplaint([], report({ title: id })).entries[0], id, status: 'live', rule: { where: 'docs/a.md', text: '' }, test: { file: `tests/${id}.test.ts`, name: id } })

  it('every guard test is reported when no run is known, or the last one is stale', () => {
    const e = [guarded('pn-a'), guarded('pn-b')]
    expect(painsReport(e, null, NOW).guards.map((g) => g.result)).toEqual(['stale', 'stale'])
    const old = { schemaVersion: 1 as const, at: new Date(NOW - GUARD_RUN_STALE_MS - 1).toISOString(), results: { 'pn-a': { result: 'passed' as const }, 'pn-b': { result: 'passed' as const } } }
    expect(painsReport(e, old, NOW).guards).toHaveLength(2)
  })

  it('a fresh run reports only the tests that did not pass (a browser spec CI runs is fine)', () => {
    const e = [guarded('pn-a'), guarded('pn-b'), guarded('pn-c'), guarded('pn-d')]
    const run = { schemaVersion: 1 as const, at: iso(60), results: { 'pn-a': { result: 'passed' as const }, 'pn-b': { result: 'failed' as const, detail: 'expected 1' }, 'pn-c': { result: 'ci_only' as const } } }
    const r = painsReport(e, run, NOW)
    expect(r.guards.map((g) => [g.entry.id, g.result])).toEqual([['pn-b', 'failed'], ['pn-d', 'not_run']])
    const text = painsNightlyText('/x/pains.json', r, run)
    expect(text).toContain('Guard test failed for pn-b')
    expect(text).toContain('Guard test not run for pn-d')
  })

  it('nothing to report is no text', () => {
    expect(painsNightlyText('/x', painsReport([], null, NOW), null)).toBe('')
  })

  it('the nightly note goes out for the registry alone on a day with no finding', async () => {
    const node = { ...vp }
    await fs.mkdir(path.dirname(painsFileOf(node.id)), { recursive: true })
    await fs.writeFile(painsFileOf(node.id), JSON.stringify({ schemaVersion: 1, entries: [addComplaint([], report()).entries[0]] }))
    const sent: string[] = []
    const evening = new Date(NOW); evening.setHours(21, 0, 0, 0)
    expect(await nightlyNote(node, 'Marina VP', evening.getTime(), async (_n, text) => { sent.push(text); return true })).toBe('sent')
    expect(sent[0]).toContain('no rule or no guard test yet')
    expect(sent[0]).toContain('Cards lose their reply')
    // The next night, the same list is not sent again.
    const next = evening.getTime() + 24 * 3600_000
    expect(await nightlyNote(node, 'Marina VP', next, async (_n, text) => { sent.push(text); return true })).toBe('none')
  })

  it('a note that failed to go out carries the same list again the next night', async () => {
    const node = { ...vp }
    await fs.mkdir(path.dirname(painsFileOf(node.id)), { recursive: true })
    await fs.writeFile(painsFileOf(node.id), JSON.stringify({ schemaVersion: 1, entries: [addComplaint([], report()).entries[0]] }))
    const evening = new Date(NOW); evening.setHours(21, 0, 0, 0)
    expect(await nightlyNote(node, 'Marina VP', evening.getTime(), async () => false)).toBe('failed')
    expect(await nightlyNote(node, 'Marina VP', evening.getTime() + 24 * 3600_000, async () => true)).toBe('sent')
  })

  it('a registry that cannot be read is said in the note', async () => {
    await fs.mkdir(path.dirname(painsFileOf(vp.id)), { recursive: true })
    await fs.writeFile(painsFileOf(vp.id), '{ broken')
    const sent: string[] = []
    const evening = new Date(NOW); evening.setHours(21, 0, 0, 0)
    await nightlyNote({ ...vp }, 'Marina VP', evening.getTime(), async (_n, text) => { sent.push(text); return true })
    expect(sent[0]).toContain('it cannot be read and no complaint is filed until it is fixed')
  })
})

describe('a finding with his words goes to the registry', () => {
  it('a new pain from the judge, his picture kept next to it, then a second complaint the judge matched', async () => {
    const pic = path.join(IMAGES_DIR, '1795-card.png')
    await fs.mkdir(path.dirname(pic), { recursive: true })
    await fs.writeFile(pic, 'png')
    const first = { id: 'u1', at: iso(100), text: 'The reply under the card used to show.', images: [pic] }
    const { d } = deps({ messages: [first], answers: [verdict({ same_as: '', title: 'Cards lose their reply', scope: 'all_users' })] })
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    const [pain] = await readPains(vp.id)
    expect(pain).toMatchObject({ title: 'Cards lose their reply', scope: 'all_users', status: 'unowned', count: 1, owner: { taskId: worker.id } })
    expect(pain.rule).toEqual({ where: 'guidance.md', text: 'Keep what a card showed when its layout changes.' })
    // Kept next to the registry by content, as a path relative to the node folder (it moves with its project).
    const kept = pain.quotes[0].images![0]
    expect(kept).toMatch(/^pains\/images\/[0-9a-f]{16}\.png$/)
    expect(await fs.readFile(resolvePainPath(vp.id, kept), 'utf-8')).toBe('png')
    expect(await fs.readFile(painsMarkdownOf(vp.id), 'utf-8')).toContain(resolvePainPath(vp.id, kept))
    expect(await fs.readFile(painsMarkdownOf(vp.id), 'utf-8')).toContain('Cards lose their reply')
    const day = await readDayEntries(vp.id, localDate(NOW))
    expect(day![0].pain).toMatchObject({ id: pain.id, isNew: true })

    // The next pass shows the judge the registry and files the new complaint under the pain it names.
    const second = { id: 'u2', at: iso(50), text: 'The reply under the card used to show, gone again.' }
    const { d: d2, prompts } = deps({ messages: [first, second], answers: [verdict({ same_as: pain.id, title: 'Replies gone', scope: 'all_users' }, { user_quote: 'gone again' })] })
    await reflectForNode(vp, 'Marina VP', [vp, worker], d2)
    expect(prompts.at(-1)).toContain(`${pain.id} Cards lose their reply`)
    const after = await readPains(vp.id)
    expect(after).toHaveLength(1)
    expect(after[0].count).toBe(2)
  })

  it('a finding the judge names no pain for is no complaint: nothing is filed', async () => {
    const { d } = deps({ messages: [{ id: 'u1', at: iso(100), text: 'The reply under the card used to show.' }], answers: [verdict(null)] })
    const r = await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(r.findings[0].verdict.verdict).toBe('bad_decision')
    expect(await readPains(vp.id)).toEqual([])
    expect((await readDayEntries(vp.id, localDate(NOW)))![0].pain).toBeUndefined()
  })

  it('a pain id the judge was not shown opens a new pain, never a guess', () => {
    const v = verifyFinding(verdict({ same_as: 'pn-made-up', title: 'Cards lose their reply', scope: 'only_him' }), {
      signal: 'regression', sessionText: BEFORE, userText: 'it used to show', rulesText: '', guidance: [], pains: [{ id: 'pn-real', title: 'Y' }],
    })
    expect(v.verdict).toBe('bad_decision')
    expect(v.verdict === 'bad_decision' && v.finding.pain).toEqual({ same_as: '', title: 'Cards lose their reply', scope: 'only_him' })
  })
})

describe('the registry is never written over what it cannot read', () => {
  const seed = async (text: string) => {
    await fs.mkdir(path.dirname(painsFileOf(vp.id)), { recursive: true })
    await fs.writeFile(painsFileOf(vp.id), text)
  }
  const one = () => addComplaint([], report()).entries[0]

  it('a pains.json that does not parse refuses the write and is left as it is', async () => {
    const broken = `{"schemaVersion":1,"entries":[${JSON.stringify(one())},]}`
    await seed(broken)
    await expect(updatePains(vp.id, 'Marina VP', (e) => [...e, one()], NOW)).rejects.toThrow(/not changed: it is not valid JSON/)
    expect(await fs.readFile(painsFileOf(vp.id), 'utf-8')).toBe(broken)
  })

  it('a file a newer release wrote is refused too, never downgraded', async () => {
    await seed(JSON.stringify({ schemaVersion: 2, entries: [one()] }))
    await expect(updatePains(vp.id, 'Marina VP', (e) => e, NOW)).rejects.toThrow(/newer Walnut/)
  })

  it('fields this release does not read, and entries it cannot read, are kept', async () => {
    const e = { ...one(), severity: 'high', tests: [{ file: 'a' }] }
    const odd = { title: 'no id', quotes: [{ at: iso(1), text: 'his words' }] }
    await seed(JSON.stringify({ schemaVersion: 1, entries: [e, odd] }))
    await updatePains(vp.id, 'Marina VP', (x) => x.map((p) => ({ ...p, note: 'seen' })), NOW)
    const back = JSON.parse(await fs.readFile(painsFileOf(vp.id), 'utf-8'))
    expect(back.entries[0]).toMatchObject({ severity: 'high', tests: [{ file: 'a' }], note: 'seen' })
    expect(back.entries[1]).toEqual(odd)
  })

  it('a known field cleared stays cleared (the written-over copy never brings it back)', async () => {
    await seed(JSON.stringify({ schemaVersion: 1, entries: [{ ...one(), test: { file: 'tests/a.test.ts', name: 'a' } }] }))
    await updatePains(vp.id, 'Marina VP', (x) => x.map(({ test: _t, ...p }) => p), NOW)
    expect((await readPains(vp.id))[0].test).toBeUndefined()
  })

  it('guard runs written at once all land, and the last is the one kept', async () => {
    await seed(JSON.stringify({ schemaVersion: 1, entries: [one()] }))
    const runs = [1, 2, 3].map((i) => ({ schemaVersion: 1 as const, at: iso(10 - i), results: { x: { result: 'passed' as const, detail: String(i) } } }))
    const done = await Promise.allSettled(runs.map((r) => writeGuardRun(vp.id, 'Marina VP', r, NOW)))
    expect(done.map((d) => d.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
    expect((await readGuardRun(vp.id))?.results.x.detail).toMatch(/^[123]$/)
    expect((await fs.readdir(path.dirname(painsFileOf(vp.id)))).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('a complaint found while the registry cannot be read', () => {
  it('waits, with no picture copied, and is filed by the first write once the file is fixed', async () => {
    const pic = path.join(IMAGES_DIR, '1795-wait.png')
    await fs.mkdir(IMAGES_DIR, { recursive: true })
    await fs.writeFile(pic, 'png')
    await fs.mkdir(path.dirname(painsFileOf(vp.id)), { recursive: true })
    await fs.writeFile(painsFileOf(vp.id), '{ broken')
    const first = { id: 'u1', at: iso(100), text: 'The reply under the card used to show.', images: [pic] }
    await reflectForNode(vp, 'Marina VP', [vp, worker], deps({ messages: [first], answers: [verdict({ same_as: '', title: 'Cards lose their reply', scope: 'all_users' })] }).d)
    expect((await readDayEntries(vp.id, localDate(NOW)))![0].pain).toEqual({ pending: true, title: 'Cards lose their reply' })
    expect(await fs.readFile(painsFileOf(vp.id), 'utf-8')).toBe('{ broken')
    expect(await fs.stat(path.join(path.dirname(painsFileOf(vp.id)), 'pains', 'images')).then(() => true, () => false)).toBe(false)
    expect((await fs.readFile(painsPendingOf(vp.id), 'utf-8')).trim().split('\n')).toHaveLength(1)

    // Fixed by hand; the next complaint files both.
    await fs.rm(painsFileOf(vp.id))
    const second = { id: 'u2', at: iso(50), text: 'It is broken again, the reply is gone.' }
    await reflectForNode(vp, 'Marina VP', [vp, worker], deps({ messages: [first, second], answers: [verdict({ same_as: '', title: 'Replies vanish', scope: 'all_users' }, { user_quote: 'broken again' })] }).d)
    const all = await readPains(vp.id)
    expect(all.map((e) => e.title).sort()).toEqual(['Cards lose their reply', 'Replies vanish'])
    expect(all.find((e) => e.title === 'Cards lose their reply')!.quotes[0].images![0]).toMatch(/^pains\/images\//)
    expect(await fs.stat(painsPendingOf(vp.id)).then(() => true, () => false)).toBe(false)
  })

  it('an import is refused before any picture is copied', async () => {
    await fs.mkdir(path.dirname(painsFileOf(vp.id)), { recursive: true })
    await fs.writeFile(painsFileOf(vp.id), '{ broken')
    const pic = path.join(IMAGES_DIR, '1795-imp.png')
    await fs.mkdir(IMAGES_DIR, { recursive: true })
    await fs.writeFile(pic, 'png')
    const entry = { ...addComplaint([], report()).entries[0], quotes: [{ at: iso(1), text: 'x', images: [pic] }] }
    await expect(importPains(vp.id, 'Marina VP', [entry], NOW)).rejects.toThrow(/not changed/)
    expect(await fs.stat(path.join(path.dirname(painsFileOf(vp.id)), 'pains', 'images')).then(() => true, () => false)).toBe(false)
  })
})

describe('his pictures', () => {
  const pain = (id: string, image: string): PainEntry => ({ ...addComplaint([], report()).entries[0], id, quotes: [{ at: iso(1), text: id, images: [image] }] })

  it('two pictures of the same name stay two, and a pain already there is not copied again', async () => {
    for (const [dir, body] of [['x1', 'AAA'], ['x2', 'BBB']]) {
      await fs.mkdir(path.join(IMAGES_DIR, dir), { recursive: true })
      await fs.writeFile(path.join(IMAGES_DIR, dir, 'screenshot.png'), body)
    }
    await importPains(vp.id, 'Marina VP', [pain('pn-i1', path.join(IMAGES_DIR, 'x1', 'screenshot.png')), pain('pn-i2', path.join(IMAGES_DIR, 'x2', 'screenshot.png'))], NOW)
    const [a, b] = await readPains(vp.id)
    expect(await fs.readFile(resolvePainPath(vp.id, a.quotes[0].images![0]), 'utf-8')).toBe('AAA')
    expect(await fs.readFile(resolvePainPath(vp.id, b.quotes[0].images![0]), 'utf-8')).toBe('BBB')
    await fs.writeFile(path.join(IMAGES_DIR, 'x1', 'screenshot.png'), 'CHANGED')
    expect(await importPains(vp.id, 'Marina VP', [pain('pn-i1', path.join(IMAGES_DIR, 'x1', 'screenshot.png'))], NOW)).toMatchObject({ kept: ['pn-i1'] })
    expect(await fs.readFile(resolvePainPath(vp.id, (await readPains(vp.id))[0].quotes[0].images![0]), 'utf-8')).toBe('AAA')
  })

  it('a picture outside Walnut\'s own places is not copied, only its path kept', async () => {
    const outside = path.join(WALNUT_HOME, '..', `elsewhere-${process.pid}.png`)
    await fs.writeFile(outside, 'x')
    await importPains(vp.id, 'Marina VP', [pain('pn-o', outside)], NOW)
    expect((await readPains(vp.id))[0].quotes[0].images).toEqual([outside])
    await fs.rm(outside, { force: true })
  })
})

describe('a thread card waiting on his decision', () => {
  const card = (over: Partial<ReflectionThread> = {}): ReflectionThread => ({
    id: 'th-pk01', title: 'Store passkeys in the password extension', state: 'needs', replyAt: iso(30), replySid: 'sess-vp', messages: [], ...over,
  })
  const cands = async (threads: ReflectionThread[], seen = new Set<string>()) =>
    (await collectCandidates(vp, [vp, worker], iso(600), seen, deps({ threads }).d)).candidates.filter((c) => c.key.startsWith('card:'))

  it('is judged with its summary and buttons as he reads them, and only once per version', async () => {
    const [c] = await cands([card({ reply: 'Build it this way? I recommend it.' })])
    expect(c).toMatchObject({ signal: 'needs_ask', sessionId: 'sess-vp', task: { id: vp.id } })
    expect(c.ask!.text).toContain('Buttons: none (he answers in his own words)')
    expect(await cands([card({ reply: 'Build it this way? I recommend it.' })], new Set([c.key]))).toHaveLength(0)
    expect(await cands([card({ reply: 'New summary.' })], new Set([c.key]))).toHaveLength(1)
  })

  it('a card with no summary says so; one not waiting on him, or closed, is not looked at', async () => {
    const [c] = await cands([card()])
    expect(c.ask!.text).toContain('(no summary')
    expect(await cands([card({ state: 'answered' })])).toHaveLength(0)
    expect(await cands([card({ closed: true })])).toHaveLength(0)
  })

  it('is judged once per decision: a summary rewritten for the same ask is not judged again', async () => {
    const [c] = await cands([card({ askId: 'ask-1', reply: 'First summary.' })])
    expect(c.key).toBe('card:th-pk01:ask-1')
    expect(await cands([card({ askId: 'ask-1', reply: 'Rewritten summary.' })], new Set([c.key]))).toHaveLength(0)
    expect(await cands([card({ askId: 'ask-2', reply: 'Rewritten summary.' })], new Set([c.key]))).toHaveLength(1)
  })

  it('a card that shows a task\'s own ask, a letter or a choice is left to those', async () => {
    expect(await cands([card({ reply: 'x', cardOfOther: true })])).toHaveLength(0)
    const [t] = threadsFromRecords([{ id: 'th-1', title: 'T', state: 'needs', messages: [], askOwner: { task: 'w-1', at: iso(1) } }])
    expect(t.cardOfOther).toBe(true)
  })

  it('a session\'s ask shows him its buttons, and keeps the key it had before', async () => {
    const asking = { ...worker, user_status: { state: 'needs', source: 'session', ask: 'Ship the pier page now?', at: iso(30), askSessionId: 'sess-1',
      askForm: { summary: 'Ship the pier page now?', kind: 'single', options: [{ id: 'a', label: 'Ship it', recommended: true }, { id: 'b', label: 'Wait' }] } } } as unknown as Task
    const { candidates } = await collectCandidates(vp, [vp, asking], iso(600), new Set(), deps().d)
    const ask = candidates.find((c) => c.signal === 'needs_ask' && c.task.id === worker.id)!
    expect(ask.ask!.text).toContain('Buttons: [Ship it (recommended)] [Wait]')
    const crypto = await import('node:crypto')
    expect(ask.key).toBe(`ask:${worker.id}:session:${crypto.createHash('sha256').update('Ship the pier page now?').digest('hex').slice(0, 12)}`)
  })

  it('its buttons show which one is recommended', () => {
    expect(cardText('', 'Pick one', [{ label: 'Build it', recommended: true }, { label: 'Skip' }])).toContain('Buttons: [Build it (recommended)] [Skip]')
  })

  it('reads state, summary, writer and buttons from the stored thread', () => {
    const [t] = threadsFromRecords([{ id: 'th-1', title: 'T', state: 'needs', reply: 'R', replyAt: iso(1), reply_sid: 'sess-vp', options: [{ id: 'a', label: 'A', recommended: true }, { id: 'b' }], messages: [{ id: 'tm-1', at: iso(2), text: 'x', images: ['/p/a.png', 3] }] }])
    expect(t).toMatchObject({ state: 'needs', reply: 'R', replySid: 'sess-vp', options: [{ label: 'A', recommended: true }] })
    expect(t.messages[0].images).toEqual(['/p/a.png'])
  })
})
