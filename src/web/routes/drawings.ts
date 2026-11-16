/**
 * Drawing routes: editable `.excalidraw` scenes in the Notes vault (core/drawings/store.ts).
 *
 *   GET  /api/drawings?taskId&sessionId   {drawings:[{path,title,revision,updatedAt,taskId?}]}
 *   POST /api/drawings {title?,taskId?,sessionId?,firstText?,clientId?}   a new empty drawing; with no
 *        title Walnut names it from firstText's first line, else the task's title, else the date; a
 *        repeat of the same clientId (a retry whose answer was lost) answers the file the first made
 *   POST /api/drawings/rename {path,revision,title}          the drawing at its new path (same folder)
 *   GET  /api/drawings/file?path          the drawing; ETag "<revision>", If-None-Match -> 304
 *   PUT  /api/drawings/file {path,revision,scene}            replace (the editor's save)
 *   POST /api/drawings/append {path,revision,elements}       add elements (an agent's edit)
 *   POST /api/drawings/update {path,revision,update?,remove?,add?}  change, remove and add in one step
 *   GET  /api/drawings/render?path&format=png|svg            {path,revision,format,pngPath|svgPath,width,height,note?}
 *   POST /api/drawings/diagram {mode,elements?,files?,prompt?,taskId?,sessionId?}   {elements,note?}
 *        skeleton shapes from one model call (core/drawings/diagram.ts); nothing is written
 *
 * The shared library (core/drawings/library.ts) and the public catalog (library-catalog.ts):
 *   GET  /api/drawings/library                      {revision,libraryItems}
 *   PUT  /api/drawings/library {revision,libraryItems}   409 {error,current:{revision,libraryItems}}, 413
 *   GET  /api/drawings/library/catalog              {items:[...],stale?}; 503 when the site is down
 *   GET  /api/drawings/library/fetch?source         the .excalidrawlib JSON of one catalog entry
 *   GET  /api/drawings/library/preview?source       its preview image
 *
 * Every drawing answer is {path,title,revision,scene,taskId?,indexWarning?,idMap?}. A stale revision is
 * 409 {error, current:{path,title,revision,scene}}; a task or session that does not exist is 404.
 * The Drawing plugin's ops (plugin-store/walnut-drawing) call exactly these routes.
 *
 * The scenes live in the leader's Notes vault: a replica forwards these routes to the leader
 * (route-table.ts) and, when one reaches this router anyway, it answers needs_leader rather than a copy.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { isFollower } from '../../core/server-role.js'
import { isNeedsLeaderError, NeedsLeaderError } from '../../core/replication/needs-leader.js'
import {
  appendToDrawing, createDrawing, DrawingConflictError, editDrawing, listDrawings, readDrawing, renameDrawing, renderDrawing,
  sceneBytesOf, writeDrawing, writeDrawingBody, type DrawingDoc,
} from '../../core/drawings/store.js'
import { DrawingInputError, DrawingServiceError } from '../../core/drawings/scene.js'
import { isLargeScene, runCodec } from '../../core/drawings/scene-codec.js'
import { LibraryConflictError, readLibrary, writeLibrary, type DrawingLibrary } from '../../core/drawings/library.js'
import { fetchLibraryFile, fetchLibraryPreview, getCatalog } from '../../core/drawings/library-catalog.js'
import { makeDiagram, MAX_DIAGRAM_BODY_BYTES } from '../../core/drawings/diagram.js'
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

/** Every drawing body is at most this (a scene, with room for the request around it). */
const MAX_DRAWING_BODY = '15mb'

/**
 * The drawing routes' body parsers, mounted on /api/drawings before the app's JSON parser
 * (server.ts): a body is taken as TEXT, so a multi-MB one is parsed once, off the event loop
 * (bodyOf). Each counts the bytes as they arrive, a chunked body too, and answers 413 past its cap.
 */
export const drawingBodyParsers = Router()
drawingBodyParsers.use('/diagram', express.text({ type: 'application/json', limit: MAX_DIAGRAM_BODY_BYTES }))
drawingBodyParsers.use(express.text({ type: 'application/json', limit: MAX_DRAWING_BODY }))
drawingBodyParsers.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (isNeedsLeaderError(err)) { next(err); return }
  if ((err as { type?: string }).type !== 'entity.too.large') { next(err); return }
  res.status(413).json({
    error: _req.path.startsWith('/diagram')
      ? `The selection is larger than ${MAX_DIAGRAM_BODY_BYTES} bytes; select less or smaller pictures`
      : `The request is larger than ${MAX_DRAWING_BODY}`,
  })
})

/** The body as an object, parsed in the codec worker when it is large (scene-codec.ts). Tests may send it parsed. */
async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  if (typeof req.body !== 'string') return (req.body ?? {}) as Record<string, unknown>
  if (!req.body.trim()) return {}
  return runCodec<Record<string, unknown>>('object', req.body, isLargeScene(req.body.length))
}

function libraryJson(lib: DrawingLibrary): string {
  return `{"revision":${JSON.stringify(lib.revision)},"libraryItems":${lib.items}}`
}

function fail(res: Response, next: NextFunction, err: unknown): void {
  if (err instanceof LibraryConflictError) {
    res.status(409).type('application/json').send(`{"error":${JSON.stringify(err.message)},"current":${libraryJson(err.current)}}`)
    return
  }
  if (err instanceof DrawingServiceError) {
    if (!res.headersSent) res.status(err.status).json({ error: err.message })
    return
  }
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
    const { title, taskId, sessionId, firstText, clientId } = await bodyOf(req)
    sendDoc(res, await createDrawing({ title, taskId, sessionId, firstText, clientId }))
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
    const { path, revision, scene } = await bodyOf(req)
    sendDoc(res, await writeDrawing(path, revision, scene))
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.post('/append', async (req, res, next) => {
  try {
    const { path, revision, elements } = await bodyOf(req)
    sendDoc(res, await appendToDrawing(path, revision, elements))
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.post('/update', async (req, res, next) => {
  try {
    const { path, revision, update, remove, add } = await bodyOf(req)
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

drawingsRouter.post('/rename', async (req, res, next) => {
  try {
    const { path, revision, title } = await bodyOf(req)
    sendDoc(res, await renameDrawing(path, revision, title))
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.post('/diagram', async (req, res, next) => {
  try {
    // The person closing the editor (or pressing Cancel) stops the model call.
    const gone = new AbortController()
    res.on('close', () => { if (!res.writableFinished) gone.abort() })
    const result = await makeDiagram(await bodyOf(req), { signal: gone.signal })
    if (!gone.signal.aborted) res.json(result)
  } catch (err) {
    fail(res, next, err)
  }
})

// ── Library ─────────────────────────────────────────────────────────────────

drawingsRouter.get('/library', async (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-cache')
    res.type('application/json').send(libraryJson(await readLibrary()))
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.put('/library', async (req, res, next) => {
  try {
    const body = typeof req.body === 'string' ? req.body : await bodyOf(req)
    res.type('application/json').send(libraryJson(await writeLibrary(body)))
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.get('/library/catalog', async (_req, res, next) => {
  try {
    const catalog = await getCatalog()
    res.setHeader('Cache-Control', 'no-cache')
    res.json({ items: catalog.items, ...(catalog.stale ? { stale: true } : {}) })
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.get('/library/fetch', async (req, res, next) => {
  try {
    const bytes = await fetchLibraryFile(req.query.source)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.type('application/json').send(bytes)
  } catch (err) {
    fail(res, next, err)
  }
})

drawingsRouter.get('/library/preview', async (req, res, next) => {
  try {
    const { bytes, contentType } = await fetchLibraryPreview(req.query.source)
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.type(contentType).send(bytes)
  } catch (err) {
    fail(res, next, err)
  }
})
