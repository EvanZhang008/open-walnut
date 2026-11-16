/**
 * Drawing routes: editable `.excalidraw` scenes in the Notes vault (core/drawings/store.ts).
 *
 *   GET  /api/drawings?taskId&sessionId   {drawings:[{path,title,revision,updatedAt,taskId?}]}
 *   POST /api/drawings {title?,taskId?,sessionId?}          a new empty drawing
 *   GET  /api/drawings/file?path          the drawing; ETag "<revision>", If-None-Match -> 304
 *   PUT  /api/drawings/file {path,revision,scene}            replace (the editor's save)
 *   POST /api/drawings/append {path,revision,elements}       add elements (an agent's edit)
 *   POST /api/drawings/update {path,revision,update?,remove?,add?}  change, remove and add in one step
 *   GET  /api/drawings/render?path&format=png|svg            {path,revision,format,pngPath|svgPath,width,height,note?}
 *
 * Every drawing answer is {path,title,revision,scene,taskId?,indexWarning?,idMap?}. A stale revision is
 * 409 {error, current:{path,title,revision,scene}}; a task or session that does not exist is 404.
 * The Drawing plugin's ops (plugin-store/walnut-drawing) call exactly these routes.
 *
 * The scenes live in the leader's Notes vault: a replica forwards these routes to the leader
 * (route-table.ts) and, when one reaches this router anyway, it answers needs_leader rather than a copy.
 */

import { Router, type NextFunction, type Request, type Response } from 'express'
import { isFollower } from '../../core/server-role.js'
import { NeedsLeaderError } from '../../core/replication/needs-leader.js'
import {
  appendToDrawing, createDrawing, DrawingConflictError, editDrawing, listDrawings, readDrawing, renderDrawing, sceneBytesOf,
  writeDrawing, writeDrawingBody, type DrawingDoc,
} from '../../core/drawings/store.js'
import { DrawingInputError } from '../../core/drawings/scene.js'
import { ensureIndexBootstrap } from './notes-v2.js'

export const drawingsRouter = Router()

drawingsRouter.use((_req: Request, _res: Response, next: NextFunction) => {
  if (isFollower()) {
    next(new NeedsLeaderError('drawings_need_leader', 'Drawings are kept in the Notes of your main Walnut server, which is not answering right now.'))
    return
  }
  // The companion notes reach the Notes index through its NOTES_UPDATED subscription.
  ensureIndexBootstrap()
  next()
})

/** `If-None-Match` names this revision: a list of quoted (or bare) tags, weak or strong, or `*`. */
export function ifNoneMatchNames(header: string | undefined, revision: string): boolean {
  if (!header) return false
  return header.split(',').some((raw) => {
    const tag = raw.trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1')
    return tag === '*' || tag === revision
  })
}

function etag(revision: string): string {
  return `"${revision}"`
}

/**
 * A document as JSON with its scene bytes spliced in as they are on disk: a multi-MB scene is
 * never parsed or re-stringified on the way out.
 */
function docJson(doc: DrawingDoc, fields: ReadonlyArray<keyof DrawingDoc>): string {
  const meta: Record<string, unknown> = {}
  for (const f of fields) if (doc[f] !== undefined) meta[f] = doc[f]
  return `${JSON.stringify(meta).slice(0, -1)},"scene":${sceneBytesOf(doc).trimEnd()}}`
}

function sendDoc(res: Response, doc: DrawingDoc): void {
  res.setHeader('ETag', etag(doc.revision))
  res.setHeader('Cache-Control', 'no-cache')
  res.type('application/json').send(docJson(doc, ['path', 'title', 'revision', 'taskId', 'indexWarning', 'idMap']))
}

/** The body as an object: the drawing routes take their bodies as text (server.ts), tests as JSON. */
function bodyOf(req: Request): Record<string, unknown> {
  if (typeof req.body !== 'string') return (req.body ?? {}) as Record<string, unknown>
  if (!req.body.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(req.body)
  } catch {
    throw new DrawingInputError('The request body is not JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DrawingInputError('The request body must be an object')
  return parsed as Record<string, unknown>
}

function fail(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof DrawingConflictError) {
    res.setHeader('ETag', etag(err.current.revision))
    res.status(409).type('application/json')
      .send(`{"error":${JSON.stringify(err.message)},"current":${docJson(err.current, ['path', 'title', 'revision'])}}`)
    return
  }
  if (err instanceof DrawingInputError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  next(err)
}

drawingsRouter.get('/', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-cache')
    res.json({ drawings: await listDrawings({ taskId: req.query.taskId, sessionId: req.query.sessionId }) })
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.post('/', async (req, res, next) => {
  try {
    const { title, taskId, sessionId } = bodyOf(req)
    sendDoc(res, await createDrawing({ title, taskId, sessionId }))
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.get('/file', async (req, res, next) => {
  try {
    const header = req.headers['if-none-match']
    const result = await readDrawing(req.query.path, { notModified: (revision) => ifNoneMatchNames(header, revision) })
    if ('notModified' in result) {
      res.setHeader('ETag', etag(result.revision))
      res.setHeader('Cache-Control', 'no-cache')
      if (result.indexWarning) res.setHeader('X-Walnut-Index-Warning', encodeURIComponent(result.indexWarning))
      res.status(304).end()
      return
    }
    sendDoc(res, result)
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.put('/file', async (req, res, next) => {
  try {
    if (typeof req.body === 'string') {
      // The editor's save: parsed, checked and encoded once (off the event loop when large).
      sendDoc(res, await writeDrawingBody(req.body))
      return
    }
    const { path, revision, scene } = bodyOf(req)
    sendDoc(res, await writeDrawing(path, revision, scene))
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.post('/append', async (req, res, next) => {
  try {
    const { path, revision, elements } = bodyOf(req)
    sendDoc(res, await appendToDrawing(path, revision, elements))
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.post('/update', async (req, res, next) => {
  try {
    const { path, revision, update, remove, add } = bodyOf(req)
    sendDoc(res, await editDrawing(path, revision, { update, remove, add }))
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.get('/render', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-cache')
    res.json(await renderDrawing(req.query.path, req.query.format))
  } catch (err) {
    fail(res, next, err)
  }
})
