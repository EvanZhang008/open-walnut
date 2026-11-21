/**
 * /api/v1/org/nodes/:id/pains: a reflecting node's pain registry (src/core/org/reflection/pains.ts).
 *
 *   GET   /org/nodes/:id/pains           → { file, markdown, entries, guardRun }   entries carry `shown`, the status as read
 *   POST  /org/nodes/:id/pains { entries } → { added, kept, refused }   pains written elsewhere added; an id already there is kept
 *   PATCH /org/nodes/:id/pains/:painId { title?, rootCause?, rule?, test?, owner?, status?, scope?, note? } → { entry }
 *                                          (409 registry_unreadable: pains.json does not parse; it is never written over)
 *                                          the task that fixes a pain writes its rule, its guard test and itself here;
 *                                          rule/test/owner null clears it
 *   PUT   /org/nodes/:id/pains-tests { at, commit?, results } → { results }   a guard run's results (scripts/pain-guards.mjs)
 *
 * Writes run on the primary only, like every other org write, and record who made them.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { OrgError } from '../../core/org/org-store.js'
import { nodeCaller, primaryOnly, sendError } from './org-v1.js'

export const orgPainsV1Router = Router()

async function nodeOf(id: string): Promise<{ id: string; title: string }> {
  const { getTask } = await import('../../core/task-manager.js')
  const t = await getTask(id).catch(() => null)
  if (!t || (t.org_role !== 'main' && t.org_role !== 'lead')) throw new OrgError('not_found', 404, `No Main or lead task ${id}: only they keep a pain registry.`)
  return { id: t.id, title: t.title }
}

/** A registry it cannot read is a conflict to fix by hand (409), never written over. */
function fail(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof Error && err.name === 'PainsUnwritable') { res.status(409).json({ error: err.message, code: 'registry_unreadable' }); return }
  sendError(res, next, err)
}

const textOr = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

orgPainsV1Router.get('/org/nodes/:id/pains', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const node = await nodeOf(String(req.params.id))
    const p = await import('../../core/org/reflection/pains.js')
    const store = await import('../../core/org/reflection/pains-store.js')
    const read = await store.readPainsFile(node.id)
    const entries = read.state === 'ok' ? read.entries : []
    res.json({
      file: p.painsFileOf(node.id), markdown: p.painsMarkdownOf(node.id), state: read.state, ...(read.state === 'bad' ? { why: read.why } : {}),
      entries: entries.map((e) => ({ ...e, shown: p.statusOf(e) })), guardRun: await store.readGuardRun(node.id),
    })
  } catch (err) {
    fail(res, next, err)
  }
})

orgPainsV1Router.post('/org/nodes/:id/pains', async (req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('Pains are added')
    const node = await nodeOf(String(req.params.id))
    await nodeCaller(req)
    const entries = (req.body ?? {}).entries
    if (!Array.isArray(entries)) throw new OrgError('bad_input', 400, 'entries is a list of pains (pains.ts PainEntry).')
    const { importPains } = await import('../../core/org/reflection/pain-record.js')
    res.json(await importPains(node.id, node.title, entries, Date.now()))
  } catch (err) {
    fail(res, next, err)
  }
})

orgPainsV1Router.patch('/org/nodes/:id/pains/:painId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('A pain is changed')
    const node = await nodeOf(String(req.params.id))
    const { writer } = await nodeCaller(req)
    const p = await import('../../core/org/reflection/pains.js')
    const store = await import('../../core/org/reflection/pains-store.js')
    const b = (req.body ?? {}) as Record<string, unknown>
    const painId = String(req.params.painId)
    let found: import('../../core/org/reflection/pains.js').PainEntry | undefined
    await store.updatePains(node.id, node.title, (entries) => entries.map((e) => {
      if (e.id !== painId) return e
      const next = { ...e }
      const title = textOr(b.title, 160); if (title) next.title = title
      const rootCause = textOr(b.rootCause, 2000); if (rootCause) next.rootCause = rootCause; else if (b.rootCause === null) delete next.rootCause
      const note = textOr(b.note, 2000); if (note) next.note = note; else if (b.note === null) delete next.note
      if (b.scope === 'all_users' || b.scope === 'only_him') next.scope = b.scope
      if (typeof b.status === 'string') {
        if (!(p.PAIN_STATUSES as readonly string[]).includes(b.status)) throw new OrgError('bad_input', 400, `status is one of ${p.PAIN_STATUSES.join(', ')}`)
        next.status = b.status as typeof e.status
      }
      const set = <K extends 'rule' | 'test' | 'owner'>(key: K, v: unknown, read: (o: Record<string, unknown>) => NonNullable<typeof e[K]> | undefined) => {
        if (v === null) { delete next[key]; return }
        if (v === undefined) return
        const r = v && typeof v === 'object' ? read(v as Record<string, unknown>) : undefined
        if (!r) throw new OrgError('bad_input', 400, `${key} needs ${key === 'rule' ? '{ where, text }' : key === 'test' ? '{ file, name }' : '{ taskId, title }'}`)
        next[key] = r
      }
      set('rule', b.rule, (o) => (textOr(o.where, 400) ? { where: textOr(o.where, 400)!, text: textOr(o.text, 1000) ?? '' } : undefined))
      set('test', b.test, (o) => (textOr(o.file, 300) && textOr(o.name, 300) ? { file: textOr(o.file, 300)!, name: textOr(o.name, 300)! } : undefined))
      set('owner', b.owner, (o) => (textOr(o.taskId, 128) ? { taskId: textOr(o.taskId, 128)!, title: textOr(o.title, 200) ?? '' } : undefined))
      next.changedBy = writer.by
      found = next
      return next
    }), Date.now())
    if (!found) throw new OrgError('not_found', 404, `No pain ${painId} in ${node.title}'s registry.`)
    res.json({ entry: { ...found, shown: p.statusOf(found) } })
  } catch (err) {
    fail(res, next, err)
  }
})

orgPainsV1Router.put('/org/nodes/:id/pains-tests', async (req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('A guard run is recorded')
    const node = await nodeOf(String(req.params.id))
    await nodeCaller(req)
    const p = await import('../../core/org/reflection/pains.js')
    const store = await import('../../core/org/reflection/pains-store.js')
    const run = p.guardRunOf(req.body)
    if (!run) throw new OrgError('bad_input', 400, 'A guard run is { at, commit?, results: { <pain id>: { result, detail? } } }.')
    await store.writeGuardRun(node.id, node.title, run, Date.now())
    res.json({ results: Object.keys(run.results).length })
  } catch (err) {
    fail(res, next, err)
  }
})
