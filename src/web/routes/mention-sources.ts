/**
 * The composer's "@" sources over HTTP (core/mention-sources/).
 *
 *   GET /api/mention-sources                       → { sources: [{ id, label, keyword, keywords, kinds, minChars, inAll }] }
 *   GET /api/mention-sources/:id/search?q=&limit=  → { items, error?, cached?, tookMs }
 *
 * A search never answers 5xx for a source's own trouble: a timeout or a throw comes back
 * 200 with `error`, so the picker shows that tab as unavailable and keeps the rest.
 */

import { Router, type Request, type Response } from 'express'
import { mentionSourcesNow, searchMentionSource } from '../../core/mention-sources/run.js'
import { SOURCE_ID_RE } from '../../core/mention-sources/registry.js'

export const mentionSourcesRouter = Router()

mentionSourcesRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    sources: mentionSourcesNow().map((s) => ({
      id: s.spec.id,
      label: s.spec.label,
      keyword: s.keywords[0] ?? null,
      keywords: s.keywords,
      kinds: Array.isArray(s.spec.kinds) ? s.spec.kinds.filter((k) => typeof k === 'string') : [],
      minChars: s.minChars,
      inAll: s.inAll,
    })),
  })
})

mentionSourcesRouter.get('/:id/search', async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '')
  if (!SOURCE_ID_RE.test(id)) { res.status(400).json({ error: 'bad_source_id' }); return }
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const limit = Number(req.query.limit) || 12
  const answer = await searchMentionSource(id, q, limit)
  if (answer.error === 'unknown_source') { res.status(404).json(answer); return }
  res.json(answer)
})
