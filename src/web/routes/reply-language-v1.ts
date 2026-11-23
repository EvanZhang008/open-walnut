/**
 * GET /api/v1/me/reply-language: what the send gate holds a session's words for the user to
 * (ops/reply-language-gate.ts). `rule` is the user's Reply language setting, `script` the script
 * it asks for, null while the setting names none or the `reply_language_gate` experiment is off.
 * Reads config only; a replica answers from its copy.
 */
import { Router, type Request, type Response } from 'express'
import { getConfig } from '../../core/config-manager.js'
import { experimentalEnabled } from '../../core/experimental.js'
import { replyLanguageText } from '../../core/sessions/output-mode.js'
import { gateScript } from '../../lib/reply-language.js'

export const replyLanguageV1Router = Router()

replyLanguageV1Router.get('/me/reply-language', async (_req: Request, res: Response) => {
  const config = await getConfig().catch(() => null)
  const rule = replyLanguageText(config)
  const on = experimentalEnabled(config?.experimental, 'reply_language_gate')
  res.json({ rule, script: on ? gateScript(rule) : null, on })
})
