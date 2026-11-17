/**
 * "Organize with Walnut": the person's AI reads an imported folder and proposes a plan (moves,
 * merges of duplicates, index pages); the person reads it; only then does the plugin carry it
 * out, itself, step by step, writing each change down first so Undo can reverse it.
 *
 * The AI only reads (an agent run with read access to the folder). Every step it proposes is
 * checked against the folder before it is shown (paths inside the folder, sources that exist,
 * targets that are free), and applying is plain file work the plugin does, with every link that
 * pointed at a moved or merged note rewritten to its new place.
 */
import fsp from 'node:fs/promises'
import nodePath from 'node:path'
import type { NotesService, WalnutServerApi } from '@open-walnut/plugin-api/server'
import { bodyIsAsWritten, bodyOf, changedMeanwhile, importedIdOf, withBody } from './note-file'
import type { JournalEntry } from './undo'
import { isAttachmentPath } from './attachments'
import { dirOf, stemOf } from './paths'
import type { Mapping } from './mapping'
import { rewriteLinks } from './links'

export type PlanStep =
  | { kind: 'move'; from: string; to: string; why: string }
  | { kind: 'merge'; sources: string[]; into: string; why: string }
  | { kind: 'index'; path: string; content: string; why: string }

export interface CheckedStep {
  step: PlanStep
  ok: boolean
  /** Why a step will be skipped. */
  problem?: string
  /** Something the person should know about a step that will be done. */
  note?: string
}

export interface OrganizePlan {
  folder: string
  summary: string
  steps: CheckedStep[]
  madeAt: string
}

const MAX_STEPS = 150

const PLAN_SCHEMA = {
  type: 'object',
  required: ['summary', 'steps'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences for the person: what the plan changes and why.' },
    steps: {
      type: 'array',
      maxItems: MAX_STEPS,
      items: {
        type: 'object',
        required: ['kind', 'why'],
        properties: {
          kind: { type: 'string', enum: ['move', 'merge', 'index'] },
          from: { type: 'string', description: 'move: a note (.md) or a folder, relative to the folder' },
          to: { type: 'string', description: 'move: the new path, relative to the folder' },
          sources: { type: 'array', items: { type: 'string' }, description: 'merge: duplicate notes to fold into `into`' },
          into: { type: 'string', description: 'merge: the note that stays' },
          path: { type: 'string', description: 'index: the new index note, relative to the folder' },
          content: { type: 'string', description: 'index: its Markdown, linking notes as [[relative/path|Title]]' },
          why: { type: 'string', description: 'One short sentence.' },
        },
      },
    },
  },
} as const

function clean(rel: string): string {
  return String(rel ?? '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '').trim()
}

function safeRel(rel: string): boolean {
  const c = clean(rel)
  return !!c && !c.split('/').some((part) => !part || part === '..' || part === '.' || part.startsWith('.')) && !/[[\]|]/.test(c)
}

const asNote = (p: string) => (p.endsWith('.md') ? p : `${p}.md`)

/**
 * Room for the folder picture in one plan request: ai.run takes at most 200,000 characters of
 * prompt and context together (src/core/ai/ai-run.ts), counted on the context as JSON.
 */
export const TREE_BUDGET = 150_000

/**
 * A compact picture of the folder for the AI: every folder first, then the notes with their
 * sizes, until TREE_BUDGET. A big import (thousands of notes with long names) lists what fits
 * and says how many more there are; the AI can still read anything in the folder.
 */
export async function describeFolder(notes: NotesService, folder: string): Promise<{ text: string; noteCount: number }> {
  const entries = await notes.list(folder)
  const folders: string[] = []
  const files: string[] = []
  for (const entry of entries) {
    const rel = entry.path.slice(folder.length + 1)
    if (rel.split('/').includes('_attachment')) continue
    if (entry.type === 'folder') folders.push(`${rel}/`)
    if (entry.type === 'note') files.push(`${rel}  (${entry.size ?? 0} bytes)`)
  }
  const lines = [...folders, ...files]
  const shown: string[] = []
  let used = 0
  for (const line of lines) {
    // Each line as it counts inside the JSON context: escapes and its newline.
    const cost = JSON.stringify(line).length
    if (used + cost > TREE_BUDGET - 200) break
    shown.push(line)
    used += cost
  }
  const more = lines.length - shown.length
  const text = more ? `${shown.join('\n')}\n… and ${more} more entries (list the folder to see them)` : shown.join('\n')
  return { text, noteCount: files.length }
}

export async function makePlan(walnut: WalnutServerApi, notes: NotesService, folder: string, signal: AbortSignal): Promise<OrganizePlan> {
  const { text, noteCount } = await describeFolder(notes, folder)
  if (noteCount === 0) throw Object.assign(new Error('There are no notes in this folder to organize yet.'), { code: 'empty' })
  const result = await walnut.ai.run({
    prompt: [
      'These are notes in one folder of a notes app (your working directory), many of them imported from Notion. Propose a plan to organize them. Do not change any file: you only read, and the person approves the plan before anything happens.',
      '',
      'Aim for a folder a person can find things in:',
      '- move: group related notes into a small number of clear folders (a note or a whole folder; keep a folder note `X/X.md` together with its folder by moving the folder). A move keeps the name: the person chose it, so never rename.',
      '- merge: fold notes that are duplicates (the same or nearly the same text) into the one that stays.',
      '- index: add an index note inside the folder it lists, named `Index.md` at the top of this folder and `<folder name> index.md` in a subfolder (`Journal/Journal index.md`), one line per note, linking each as [[path/from/the/top/of/this/folder|Title]]: every link path starts at the top of this working directory, also for an index inside a subfolder. A long index groups its lines under short `##` headings (by month for dated notes such as journal days, by topic otherwise). A folder whose folder note already lists its notes (a Notion database note has a table of its rows) needs no index of its own.',
      '',
      'When nothing would make the folder easier to use, propose no steps and say so in the summary.',
      '',
      'Rules: every path is relative to this folder and keeps `.md` for notes; never move, merge or link `_attachment` folders; a step must not depend on a later one; only strong steps, at most ' + MAX_STEPS + '; empty or near-empty pages can be left alone. Read notes you are unsure about before you propose a merge. Write the summary and every `why` in plain, short sentences, naming each note as the notes app shows it: its file name without `.md` and without its folders (a title inside the note may be out of date), never a path. Any number you write must match your steps exactly (count the lines of an index). Links never break here: a move or merge fixes every link to the notes it moves, so never give links as a reason against a step.',
    ].join('\n'),
    context: { folder, notes: noteCount, tree: text },
    format: { schema: PLAN_SCHEMA as unknown as Record<string, unknown> },
    needs: { files: 'read', cwd: `${notes.dir}/${folder}` },
    interactive: true,
    signal,
  })
  const raw = (result.json ?? {}) as { summary?: string; steps?: Array<Record<string, unknown>> }
  const steps = (raw.steps ?? []).slice(0, MAX_STEPS).map(toStep).filter((s): s is PlanStep => !!s)
  return { folder, summary: String(raw.summary ?? '').trim(), steps: await checkSteps(notes, folder, steps), madeAt: new Date().toISOString() }
}

function toStep(raw: Record<string, unknown>): PlanStep | null {
  const why = String(raw.why ?? '').trim()
  if (raw.kind === 'move' && raw.from && raw.to) return { kind: 'move', from: clean(String(raw.from)), to: clean(String(raw.to)), why }
  if (raw.kind === 'merge' && Array.isArray(raw.sources) && raw.into) return { kind: 'merge', sources: raw.sources.map((s) => clean(String(s))).filter(Boolean), into: clean(String(raw.into)), why }
  if (raw.kind === 'index' && raw.path && typeof raw.content === 'string') return { kind: 'index', path: asNote(clean(String(raw.path))), content: raw.content, why }
  return null
}

/** Each step against the folder as it will be when the earlier steps ran. */
export async function checkSteps(notes: NotesService, folder: string, steps: PlanStep[], planned?: Map<string, string>, leftOut?: Set<string>): Promise<CheckedStep[]> {
  const entries = await notes.list(folder)
  // An index may list another index the plan makes, before or after it; a line to one that fails
  // or is left out goes.
  const indexes = new Set(steps.flatMap((s) => (s.kind === 'index' && safeRel(s.path) ? [s.path] : [])))
  const dropped = new Set(leftOut ?? [])
  let out = checkPass(entries, folder, steps, planned, indexes, dropped)
  const failed = out.filter((c) => !c.ok && c.step.kind === 'index' && indexes.has(c.step.path)).map((c) => (c.step as { path: string }).path)
  if (failed.length) {
    for (const f of failed) { indexes.delete(f); dropped.add(f) }
    out = checkPass(entries, folder, steps, planned, indexes, dropped)
  }
  return out
}

function checkPass(entries: Array<{ path: string; type: string }>, folder: string, steps: PlanStep[], planned: Map<string, string> | undefined, indexes: Set<string>, dropped: Set<string>): CheckedStep[] {
  const files = new Set(entries.filter((e) => e.type !== 'folder').map((e) => e.path.slice(folder.length + 1)))
  // A file notes cannot hold (a .csv, a video) stays where it is, and so does the folder around it:
  // an undo could not put it back.
  const fixed = [...files].filter((f) => !f.endsWith('.md') && !isAttachmentPath(f))
  const folders = new Set(entries.filter((e) => e.type === 'folder').map((e) => e.path.slice(folder.length + 1)))
  const out: CheckedStep[] = []
  const bad = (step: PlanStep, problem: string) => out.push({ step, ok: false, problem })
  for (const step of steps) {
    if (step.kind === 'move') {
      if (!safeRel(step.from) || !safeRel(step.to)) { bad(step, 'A path is outside the folder'); continue }
      if (step.from.split('/').includes('_attachment') || step.to.split('/').includes('_attachment')) { bad(step, 'Attachment folders stay where they are'); continue }
      if (folders.has(step.from)) {
        if (folders.has(step.to) || files.has(asNote(step.to))) { bad(step, `${step.to} already exists`); continue }
        if (`${step.to}/`.startsWith(`${step.from}/`)) { bad(step, 'A folder cannot move into itself'); continue }
        if (stemOf(step.from) !== stemOf(step.to)) { bad(step, 'It would rename it; Organize keeps the names you chose'); continue }
        const kept = fixed.find((f) => f.startsWith(`${step.from}/`))
        if (kept) { bad(step, `It holds ${kept}, a kind of file Walnut does not move`); continue }
        for (const f of [...files]) if (f.startsWith(`${step.from}/`)) { files.delete(f); files.add(`${step.to}${f.slice(step.from.length)}`) }
        for (const d of [...folders]) if (d === step.from || d.startsWith(`${step.from}/`)) { folders.delete(d); folders.add(`${step.to}${d.slice(step.from.length)}`) }
        addParents(folders, step.to)
        out.push({ step, ok: true })
        continue
      }
      const from = asNote(step.from)
      const to = asNote(step.to)
      if (!files.has(from)) { bad(step, `${step.from} is not in the folder`); continue }
      if (files.has(to) || folders.has(to.replace(/\.md$/, ''))) { bad(step, `${step.to} already exists`); continue }
      if (stemOf(step.from) !== stemOf(step.to)) { bad(step, 'It would rename it; Organize keeps the names you chose'); continue }
      files.delete(from)
      files.add(to)
      addParents(folders, dirOf(to))
      out.push({ step: { ...step, from, to }, ok: true })
    } else if (step.kind === 'merge') {
      const into = asNote(step.into)
      const sources = step.sources.map(asNote).filter((s) => s !== into)
      if (!safeRel(into) || sources.some((s) => !safeRel(s))) { bad(step, 'A path is outside the folder'); continue }
      if (!files.has(into)) { bad(step, `${step.into} is not in the folder`); continue }
      const missing = sources.filter((s) => !files.has(s))
      if (!sources.length || missing.length) { bad(step, missing.length ? `${missing[0]} is not in the folder` : 'Nothing to merge'); continue }
      for (const s of sources) files.delete(s)
      out.push({ step: { ...step, into, sources }, ok: true })
    } else {
      if (!safeRel(step.path)) { bad(step, 'The path is outside the folder'); continue }
      if (files.has(step.path)) { bad(step, `${step.path} already exists`); continue }
      const { content, links, unmatched } = resolveIndexLinks(step.content, step.path, folder, new Set([...files, ...indexes]), planned, dropped)
      if (links && unmatched === links) { bad(step, 'None of its links match a note in the folder'); continue }
      files.add(step.path)
      out.push({ step: { ...step, content }, ok: true, ...(unmatched ? { note: `${unmatched} of its ${links} links matched no note, so they are plain text` } : {}) })
    }
  }
  return out
}

/**
 * An index's links, each to the note it means, as a path from the top of the organized folder: the
 * AI may write one from the top or from the index's own folder (an index in `Journal/` listing
 * `Day 1`), and a folder's name means its folder note. A link that matches no note becomes its
 * words. `planned` (top-relative, no `.md`) names where a note the plan moves came from, so a link
 * to a move left out still counts.
 */
const DROP = '\u0000drop\u0000'

function resolveIndexLinks(content: string, indexPath: string, folder: string, files: Set<string>, planned?: Map<string, string>, dropped?: Set<string>): { content: string; links: number; unmatched: number } {
  const at = (c: string): string | null => {
    if (files.has(`${c}.md`)) return c
    if (/\.[A-Za-z0-9]+$/.test(c) && files.has(c)) return c
    const folderNote = `${c}/${stemOf(c)}`
    if (files.has(`${folderNote}.md`)) return folderNote
    for (let up = c; up; up = dirOf(up)) {
      const from = planned?.get(up)
      if (from !== undefined && files.has(`${from + c.slice(up.length)}.md`)) return c
    }
    return null
  }
  const home = dirOf(indexPath)
  let links = 0
  let unmatched = 0
  const next = content.replace(/(!?)\[\[([^\]\n]+?)\]\]/g, (whole, bang: string, inner: string) => {
    const bar = inner.search(/\\?\|/)
    const rawTarget = bar < 0 ? inner : inner.slice(0, bar)
    const alias = bar < 0 ? null : inner.slice(bar).replace(/^\\?\|/, '')
    const hash = rawTarget.indexOf('#')
    const anchor = hash < 0 ? '' : rawTarget.slice(hash)
    let target = clean(hash < 0 ? rawTarget : rawTarget.slice(0, hash))
    if (target.startsWith(`${folder}/`)) target = target.slice(folder.length + 1)
    target = target.replace(/\.md$/, '')
    if (!target) return whole
    // A line listing an index the plan does not make goes with it.
    if (dropped?.size && (home ? [target, `${home}/${target}`] : [target]).some((c) => dropped.has(`${c}.md`))) return DROP
    links++
    for (const c of home ? [target, `${home}/${target}`] : [target]) {
      const found = at(c)
      if (found) return `${bang}[[${found}${anchor}${bar < 0 ? '' : inner.slice(bar)}]]`
    }
    unmatched++
    return alias ?? stemOf(target)
  })
  return { content: asList(next.split('\n').filter((line) => !line.includes(DROP)).join('\n')), links, unmatched }
}

/**
 * An index lists one note per line: a line of links that is not a list item, a heading, a quote or
 * a table row becomes one (the AI sometimes writes bare lines, which Markdown runs together into
 * one paragraph), and a line holding several links becomes one item per link.
 */
function asList(content: string): string {
  return content.split('\n').flatMap((line) => {
    const t = line.trim()
    if (!t.includes('[[') || /^([-*+]\s|\d+[.)]\s|#|>|\|)/.test(t)) return [line]
    const links = t.match(/!?\[\[[^\]\n]+?\]\]/g) ?? []
    const rest = t.replace(/!?\[\[[^\]\n]+?\]\]/g, '').replace(/[\s,;·•|-]+/g, '')
    if (links.length > 1 && !rest) return links.map((l) => `- ${l}`)
    return [`- ${t}`]
  }).join('\n')
}

function addParents(folders: Set<string>, dir: string): void {
  for (let d = dir; d; d = dirOf(d)) folders.add(d)
}

export interface JournalSink {
  add(entry: JournalEntry): Promise<void>
}

export async function applyPlan(input: {
  notes: NotesService
  mapping: Mapping
  sourceId: string
  plan: OrganizePlan
  /** Where every change is written down before it is made, so Undo can reverse exactly those. */
  journal: JournalSink
  onStep(done: number, total: number): void
  /** The plugin stopping: the run stops between changes, and Undo reverses what it did. */
  signal?: AbortSignal
  /** Every step of the plan the person saw, the ones left out too (default: the plan's). */
  allSteps?: PlanStep[]
}): Promise<{ applied: number; done: { moved: number; merged: number; indexes: number }; skipped: Array<{ why: string; problem: string }>; openPath: string | null; moves: Array<[string, string]> }> {
  const { notes, mapping, plan, sourceId } = input
  // A change Undo would not know of is never made: a journal that cannot be written stops the run.
  const journal = {
    add: async (entry: JournalEntry) => {
      try { await input.journal.add(entry) } catch (error) {
        throw Object.assign(new Error(`Could not write down the change, so the run stopped: ${error instanceof Error ? error.message : String(error)}`), { stopRun: true })
      }
    },
  }
  const folder = plan.folder
  const abs = (rel: string) => `${folder}/${rel}`
  // Where each place the plan moves a note to was before, for every move it holds (left out or
  // not): an index step links where the plan would put a note, and one not moved is still there.
  const plannedRel = new Map<string, string>()
  for (const step of input.allSteps ?? plan.steps.map((s) => s.step)) if (step.kind === 'move') plannedRel.set(step.to.replace(/\.md$/, ''), step.from.replace(/\.md$/, ''))
  // Re-check against the folder now: it may have changed since the plan was shown.
  // Index pages of the plan that are left out: other indexes drop their lines to them.
  const chosenIndexes = new Set(plan.steps.filter((s) => s.ok && s.step.kind === 'index').map((s) => (s.step as { path: string }).path))
  const leftOut = new Set((input.allSteps ?? []).flatMap((s) => (s.kind === 'index' && !chosenIndexes.has(s.path) ? [s.path] : [])))
  const checked = await checkSteps(notes, folder, plan.steps.filter((s) => s.ok).map((s) => s.step), plannedRel, leftOut)
  const moves = new Map<string, string>() // vault path → vault path
  const mergedTargets = new Set<string>()
  const skipped: Array<{ why: string; problem: string }> = []
  let applied = 0
  const done = { moved: 0, merged: 0, indexes: 0 }
  let openPath: string | null = null
  let firstMoved: string | null = null
  const total = checked.length
  const record = (from: string, to: string) => {
    for (const [k, v] of moves) if (v === from) moves.set(k, to)
    moves.set(from, to)
  }
  const moveOne = async (from: string, to: string) => {
    await journal.add({ kind: 'move', from, to, newDirs: await missingDirs(notes, dirOf(to)) })
    await notes.move(from, to)
    await journal.add({ kind: 'moved', from, to })
    record(from, to)
    if (to.endsWith('.md')) done.moved++
  }
  /** Rewrite a note, journaled: its text before, then the hash it got. */
  const rewrite = async (at: string, before: { content: string; hash: string }, next: string, rec?: { itemId: string; folder: string }) => {
    await journal.add({ kind: 'rewrite', path: at, before: before.content, beforeHash: before.hash, ...(rec ? { record: { source: sourceId, ...rec } } : {}) })
    const written = await notes.write(at, next, { expectedHash: before.hash })
    await journal.add({ kind: 'written', path: at, hash: written.hash })
    return written
  }
  const stopped = () => {
    if (input.signal?.aborted) throw Object.assign(new Error('Walnut stopped the plugin part way, so the run stopped; Undo reverses what it did.'), { stopRun: true })
  }
  const planned = new Map([...plannedRel].map(([to, from]) => [abs(to), abs(from)]))
  for (const [index, { step, ok, problem }] of checked.entries()) {
    stopped()
    input.onStep(index, total)
    if (!ok) { skipped.push({ why: step.why, problem: problem ?? 'Not possible any more' }); continue }
    try {
      if (step.kind === 'move') {
        const all = await notes.list(abs(step.from)).catch(() => [])
        if (all.length) {
          for (const entry of all) {
            if (entry.type === 'folder') continue
            await moveOne(entry.path, abs(step.to) + entry.path.slice(abs(step.from).length))
          }
          // The old folder goes only when nothing is left in it (a hidden file stays, and its folder too).
          if (await isEmptyFolder(notes, abs(step.from))) await notes.remove(abs(step.from)).catch(() => undefined)
        } else {
          await moveOne(abs(step.from), abs(step.to))
          firstMoved ??= abs(step.to)
        }
      } else if (step.kind === 'merge') {
        const into = await notes.read(abs(step.into))
        if (!into) throw new Error(`${step.into} is gone`)
        let content = into.content.replace(/\s+$/, '')
        const removed: Array<{ at: string; content: string; item?: { itemId: string; folder: string } }> = []
        for (const source of step.sources) {
          const note = await notes.read(abs(source))
          if (!note) continue
          const title = /^title:\s*"?(.*?)"?\s*$/m.exec(note.content)?.[1] || stemOf(source)
          const body = bodyOf(note.content).trim()
          // A copy whose words the note already holds adds nothing but its links.
          const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
          if (body && !flat(bodyOf(content)).includes(flat(body))) content += `\n\n## ${title}\n\n${body}`
          const itemId = importedIdOf(note.content, sourceId)
          const rec = itemId ? await mapping.recordAt(sourceId, abs(source)) : null
          const item = itemId ? { itemId, folder: rec && rec.itemId === itemId ? rec.folder : folder } : undefined
          removed.push({ at: abs(source), content: note.content, item })
        }
        if (`${content}\n` !== into.content) await rewrite(abs(step.into), into, `${content}\n`)
        for (const { at, content: was, item } of removed) {
          // A source edited since it was read stays: its newer words are not in the merged note.
          // One deleted meanwhile is gone already; links to it go to the merged note.
          const now = await notes.read(at)
          if (now && now.content !== was) {
            skipped.push({ why: step.why, problem: `${at} changed while organizing, so it was kept beside the merged note` })
            continue
          }
          if (now) {
            // Written down right before it goes, so Undo brings back only what this run removed.
            await journal.add({ kind: 'remove', path: at, content: was, ...(item ? { merged: { source: sourceId, ...item } } : {}) })
            if (item) await mapping.markMerged(item.folder, sourceId, item.itemId, abs(step.into))
            await notes.remove(at)
          }
          record(at, abs(step.into))
        }
        mergedTargets.add(abs(step.into))
      } else {
        const named = step.content.replace(/\[\[([^\]|]+)/g, (whole, target: string) => {
          const rel = clean(target)
          return rel && !rel.startsWith(`${folder}/`) ? `[[${folder}/${rel.replace(/\.md$/, '')}` : whole
        })
        const content = await linkWhereNotesAre(notes, named, planned)
        await journal.add({ kind: 'create', path: abs(step.path) })
        const written = await notes.write(abs(step.path), content.endsWith('\n') ? content : `${content}\n`, { createOnly: true })
        await journal.add({ kind: 'written', path: abs(step.path), hash: written.hash })
        // The top-most index is the one to open after the run.
        if (!openPath || abs(step.path).split('/').length < openPath.split('/').length) openPath = abs(step.path)
      }
      applied++
      if (step.kind === 'merge') done.merged++
      else if (step.kind === 'index') done.indexes++
    } catch (error) {
      if ((error as { stopRun?: boolean })?.stopRun) throw error
      const code = (error as { code?: string })?.code
      const message = code === 'note_exists' ? 'A note was made there meanwhile'
        : code === 'note_deleted' ? 'The note was deleted meanwhile'
        : error instanceof Error ? error.message : String(error)
      skipped.push({ why: step.why, problem: message })
    }
  }
  input.onStep(total, total)
  // Every link in the vault that pointed at a moved or merged note, to its new place.
  if (moves.size) {
    for (const [from, to] of moves) await mapping.movePathAnywhere(from, to)
    for (const entry of await notes.list()) {
      if (entry.type !== 'note') continue
      stopped()
      const note = await notes.read(entry.path)
      // Any link form: one saved escaped (`\[\[…`) names the folder escaped too.
      if (!note || (!note.content.includes('[[') && !note.content.includes('\\[\\['))) continue
      // A note still exactly as the import wrote it stays that way: only its links change, its stamp
      // follows, and a later import may refresh it. One the person edited (or one that took in merged
      // notes) has its links fixed and stays theirs. The record is the one of the item the note says
      // it came from, in whichever import folder records it, and only while it records this note.
      const itemId = importedIdOf(note.content, sourceId)
      const rec = itemId ? await mapping.recordAt(sourceId, entry.path) : null
      const recorded = !!rec && rec.itemId === itemId
      const pristine = !mergedTargets.has(entry.path) && (recorded ? rec!.row.hash === note.hash : !!itemId && !(await mapping.knows(sourceId, itemId)) && bodyIsAsWritten(note.content, sourceId))
      const next = pristine ? withBody(note.content, sourceId, rewriteLinks(bodyOf(note.content), moves)) : rewriteLinks(note.content, moves)
      if (next === note.content) continue
      try {
        const written = await rewrite(entry.path, note, next, pristine && recorded ? { itemId: itemId!, folder: rec!.folder } : undefined)
        if (pristine && recorded) await mapping.put(rec!.folder, sourceId, itemId!, { ...rec!.row, hash: written.hash })
      } catch (error) {
        if (!changedMeanwhile(error)) throw error
        skipped.push({ why: 'Fix links', problem: (error as { code?: string }).code === 'note_deleted'
          ? `${entry.path} was deleted while organizing; it was left deleted`
          : `${entry.path} changed while organizing; its links were left as they were` })
      }
    }
  }
  return { applied, done, skipped, openPath: openPath ?? firstMoved, moves: [...moves] }
}

/**
 * An index note's links, each to where its note is now: a link to a place the plan meant to move a
 * note to, whose move was left out or could not be made, goes to the note's place before (moves
 * made later fix it again with every other link).
 */
async function linkWhereNotesAre(notes: NotesService, content: string, planned: Map<string, string>): Promise<string> {
  const there = new Map<string, boolean>()
  const exists = async (target: string) => {
    if (!there.has(target)) there.set(target, !!(await notes.read(`${target}.md`)) || !!(await notes.read(target)))
    return there.get(target)!
  }
  const origin = (target: string): string | null => {
    for (let at = target; at; at = dirOf(at)) {
      const from = planned.get(at)
      if (from !== undefined) return from + target.slice(at.length)
    }
    return null
  }
  const out: string[] = []
  let last = 0
  for (const m of content.matchAll(/\[\[([^\]|\n]+)/g)) {
    const target = m[1].trim().replace(/\\$/, '').replace(/#.*$/, '').replace(/\.md$/, '')
    out.push(content.slice(last, m.index! + 2))
    last = m.index! + 2 + m[1].length
    const from = !(await exists(target)) ? origin(target) : null
    out.push(from && await exists(from) ? m[1].replace(target, () => from) : m[1])
  }
  out.push(content.slice(last))
  return out.join('')
}

/** The folders along `dir` (vault path) that do not exist yet, deepest last. */
async function missingDirs(notes: NotesService, dir: string): Promise<string[] | undefined> {
  const missing: string[] = []
  for (let at = dir; at; at = dirOf(at)) {
    try { await fsp.stat(nodePath.join(notes.dir, at)); break } catch { missing.unshift(at) }
  }
  return missing.length ? missing : undefined
}

/** Nothing in it but empty folders, hidden files included (which `notes.list` leaves out). */
export async function isEmptyFolder(notes: NotesService, folder: string): Promise<boolean> {
  if ((await notes.list(folder)).some((entry) => entry.type !== 'folder')) return false
  return isEmptyDir(nodePath.join(notes.dir, folder))
}

async function isEmptyDir(dir: string): Promise<boolean> {
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch (error) {
    return (error as { code?: string })?.code === 'ENOENT'
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !(await isEmptyDir(nodePath.join(dir, entry.name)))) return false
  }
  return true
}
