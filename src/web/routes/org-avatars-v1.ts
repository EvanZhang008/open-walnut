/**
 * /api/v1/org/avatars: the Org page's avatars (src/core/org/avatars/).
 *
 *   PUT  /org/avatars/:taskId { preset | svg | image | reset: true } → { task: { id, org_avatar } }
 *        set (or reset to the default) one task's avatar; the user and agents alike (org_avatar_set)
 *   POST /org/avatars/draw { prompt?, name?, taskId? } → { svgs: [svg, ...] }
 *        three avatars the user's own model draws for a description; nothing is written
 *   GET  /org/avatars/:taskId.png[?size=96] → image/png
 *        the avatar the Org page shows for the task, as a PNG for the phone
 *
 * The writes run on the primary only (501 on a replica), as every org write does.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { OrgError } from '../../core/org/org-store.js'
import { nodeCaller, primaryOnly, sendError } from './org-v1.js'

export const orgAvatarsV1Router = Router()

orgAvatarsV1Router.put('/org/avatars/:taskId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    primaryOnly('An avatar is set')
    const { writer } = await nodeCaller(req)
    const { setOrgAvatar } = await import('../../core/org/avatars/avatar-store.js')
    const b = req.body ?? {}
    const task = await setOrgAvatar(String(req.params.taskId), { preset: b.preset, svg: b.svg, image: b.image, reset: b.reset }, writer)
    res.json({ task: { id: task.id, title: task.title, org_avatar: task.org_avatar ?? null } })
  } catch (err) {
    sendError(res, next, err)
  }
})

orgAvatarsV1Router.post('/org/avatars/draw', async (req: Request, res: Response, next: NextFunction) => {
  const gone = new AbortController()
  res.on('close', () => { if (!res.writableEnded) gone.abort() })
  try {
    primaryOnly('An avatar is drawn')
    const { drawOrgAvatars } = await import('../../core/org/avatars/avatar-store.js')
    const b = req.body ?? {}
    const svgs = await drawOrgAvatars({ prompt: b.prompt, name: b.name, taskId: b.taskId }, { signal: gone.signal })
    res.json({ svgs })
  } catch (err) {
    sendError(res, next, err)
  }
})

/** Rendered PNGs, by the picture and size they show (a changed avatar is a new key). */
const pngCache = new Map<string, Buffer>()
const PNG_CACHE_MAX = 200

orgAvatarsV1Router.get('/org/avatars/:file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const m = /^(.+)\.png$/.exec(String(req.params.file))
    if (!m) throw new OrgError('not_found', 404, 'Ask for <task id>.png.')
    const tm = await import('../../core/task-manager.js')
    const { isPluginOnlyTask } = await import('../../core/org/org-tree.js')
    // The tasks the Org page has (a plugin's own tasks never reach it), so both pick the same.
    const tasks = (await tm.listTasks()).filter((t) => !isPluginOnlyTask(t))
    const task = tasks.find((t) => t.id === m[1])
    if (!task) throw new OrgError('not_found', 404, `No task "${m[1]}".`)
    const { orgAvatars } = await import('../../core/org/avatars/index.js')
    const pick = orgAvatars(tasks).of(task)
    const size = Math.max(16, Math.min(512, Number(req.query.size) || 96))
    const key = `${size}:${pick.src}`
    let png = pngCache.get(key)
    if (!png) {
      const { loadSharp } = await import('../../utils/image-compress.js')
      const sharp = await loadSharp()
      if (!sharp) throw new OrgError('no_renderer', 503, 'This server cannot draw PNGs (sharp is missing).')
      const comma = pick.src.indexOf(',')
      const head = pick.src.slice(0, comma)
      const body = pick.src.slice(comma + 1)
      const input = head.includes(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body))
      // Only the pictures a check let in: an SVG of ours, or a PNG, JPEG or WebP by its own bytes.
      const format = (await sharp(input).metadata()).format
      if (!['svg', 'png', 'jpeg', 'webp'].includes(String(format)) || (format === 'svg') !== head.startsWith('data:image/svg+xml')) {
        throw new OrgError('not_found', 404, 'This task\'s picture is not one a phone can be shown.')
      }
      png = await sharp(input, { density: 72 * Math.max(1, size / 100) }).resize({ width: size, height: size, fit: 'cover' }).png().toBuffer()
      if (pngCache.size >= PNG_CACHE_MAX) pngCache.delete(pngCache.keys().next().value!)
      pngCache.set(key, png)
    }
    res.set('Cache-Control', 'private, max-age=60').type('png').send(png)
  } catch (err) {
    sendError(res, next, err)
  }
})
