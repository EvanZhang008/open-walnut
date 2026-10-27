/**
 * /api/v1/hints: the message-hint registry (src/core/hints/), the same for a person
 * in Settings and for an agent through the ops (hint_list, hint_set, hint_reset).
 *
 *   GET    /hints[?session=<sid>]  → { hints, triggers, roles[, session] }
 *                                    `session`: what that session was told, and which
 *                                    hints its next message would carry
 *   PUT    /hints/:kind            { enabled?, triggers?, every_turns?, placement?, audience?, text?, label? }
 *                                  → { hint } (merged into the stored override; a new kind with
 *                                    `text` is a custom hint)
 *   DELETE /hints/:kind            → { hint | null } (a built-in back to its default; a custom
 *                                    one removed)
 *
 * Stored in config.yaml `session.hints`. Replica: reads only (writes answer 501).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { sendError } from './cloud-send-words.js'
import { EventNames, bus } from '../../core/event-bus.js'
import { getConfig } from '../../core/config-manager.js'
import { modifyConfigDoc } from '../../core/config-store.js'
import {
  HINT_ROLES, HINT_TRIGGERS, HintSettingsError, describeHint, effectiveHints, findHint, isBuiltInHint, validateHintSettings,
} from '../../core/hints/hint-registry.js'
import { planHints, hintTargetOf } from '../../core/hints/hint-send.js'
import type { MessageHintSettings } from '../../core/types.js'

export const hintsV1Router = Router()


async function sessionView(sessionId: string) {
  const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
  const record = await getSessionByClaudeId(sessionId)
  if (!record) return null
  const config = await getConfig().catch(() => null)
  let task = null
  if (record.taskId) {
    const { listTasksByIds } = await import('../../core/task-manager.js')
    task = (await listTasksByIds([record.taskId]).catch(() => []))[0] ?? null
  }
  const plan = planHints({ hints: effectiveHints(config), target: hintTargetOf(sessionId, task), record, config })
  const state = record.hintState
  return {
    session_id: sessionId,
    sends: state?.sends ?? 0,
    told: state?.told ?? {},
    ...(state?.drift ? { drift: state.drift } : {}),
    ...(state?.lastSendBy ? { last_send_by: state.lastSendBy } : {}),
    ...(record.lastCompactUuid ? { compact_uuid: record.lastCompactUuid } : {}),
    next_message_carries: plan.carried.map((h) => h.kind),
  }
}

hintsV1Router.get('/hints', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig().catch(() => null)
    const sid = typeof req.query.session === 'string' ? req.query.session : undefined
    const session = sid ? await sessionView(sid) : undefined
    if (sid && !session) return sendError(res, 404, 'session_not_found', `No session ${sid}`)
    res.json({
      hints: effectiveHints(config).map(describeHint),
      triggers: HINT_TRIGGERS,
      roles: HINT_ROLES,
      ...(session ? { session } : {}),
    })
  } catch (err) {
    next(err)
  }
})

/** Read-modify-write `session.hints[kind]` under the config lock. */
async function writeOverride(kind: string, change: (cur: MessageHintSettings | undefined) => MessageHintSettings | undefined): Promise<void> {
  await modifyConfigDoc((doc) => {
    const session = (doc.session && typeof doc.session === 'object' ? { ...(doc.session as Record<string, unknown>) } : {})
    const hints = (session.hints && typeof session.hints === 'object' ? { ...(session.hints as Record<string, MessageHintSettings>) } : {})
    const nextValue = change(hints[kind])
    if (nextValue === undefined) {
      if (!(kind in hints)) return { write: false, result: undefined }
      delete hints[kind]
    } else hints[kind] = nextValue
    if (Object.keys(hints).length) session.hints = hints
    else delete session.hints
    doc.session = session
    return { write: true, result: undefined }
  })
  bus.emit(EventNames.CONFIG_CHANGED, { key: 'session' }, ['web-ui'], { source: 'api' })
}

hintsV1Router.put('/hints/:kind', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) return sendError(res, 501, 'not_supported_cloud', 'Message hints are changed on the primary box')
    const kind = String(req.params.kind ?? '')
    let patch: MessageHintSettings
    try {
      patch = validateHintSettings(kind, { ...(isBuiltInHint(kind) ? {} : { text: (await getConfig().catch(() => null))?.session?.hints?.[kind]?.text }), ...(req.body ?? {}) })
    } catch (err) {
      if (err instanceof HintSettingsError) return sendError(res, 400, 'bad_hint', err.message)
      throw err
    }
    await writeOverride(kind, (cur) => {
      const merged: MessageHintSettings = { ...(cur ?? {}), ...patch }
      if (patch.audience) merged.audience = patch.audience
      return merged
    })
    const hint = findHint(await getConfig(), kind)
    res.json({ hint: hint ? describeHint(hint) : null })
  } catch (err) {
    next(err)
  }
})

hintsV1Router.delete('/hints/:kind', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) return sendError(res, 501, 'not_supported_cloud', 'Message hints are changed on the primary box')
    const kind = String(req.params.kind ?? '')
    const before = findHint(await getConfig().catch(() => null), kind)
    if (!before) return sendError(res, 404, 'hint_not_found', `No message hint "${kind}"`)
    await writeOverride(kind, () => undefined)
    const hint = findHint(await getConfig(), kind)
    res.json({ hint: hint ? describeHint(hint) : null })
  } catch (err) {
    next(err)
  }
})
