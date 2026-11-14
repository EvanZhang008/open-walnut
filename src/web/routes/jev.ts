/**
 * Jev decision-model management: credential storage and a connectivity test.
 *
 * The API key NEVER lands in config.yaml (it rides git-sync between machines).
 * POST /key writes the literal to ~/.open-walnut/secrets/jev-api.key (0600;
 * secrets/ is git-sync-excluded) and stores only a `${file:...}` reference in
 * config. Responses never echo the key.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { getJevClient } from '../../core/decision/jev-client.js'
import { log } from '../../logging/index.js'

export const jevRouter = Router()

const KEY_FILE = path.join(WALNUT_HOME, 'secrets', 'jev-api.key')
/** The SHARED OpenRouter credential file — provider-level, not Jev's own. */
const OPENROUTER_KEY_FILE = path.join(WALNUT_HOME, 'secrets', 'openrouter.key')
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

function isOpenRouter(endpoint: string | undefined): boolean {
  return /^https:\/\/openrouter\.ai\//.test(endpoint ?? DEFAULT_ENDPOINT)
}

jevRouter.post('/key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : ''
    if (!key) {
      res.status(400).json({ error: 'key is required' })
      return
    }
    if (/\s/.test(key) || key.length < 8 || key.length > 512) {
      res.status(400).json({ error: 'that does not look like an API key' })
      return
    }
    const config = await getConfig()
    // An OpenRouter key is a PROVIDER credential: one key, configured once,
    // serves chat models and Jev alike. Only a first-party/other-gateway key
    // is Jev-specific. Which one this is follows from the effective endpoint.
    const shared = isOpenRouter(config.jev?.endpoint)
    const file = shared ? OPENROUTER_KEY_FILE : KEY_FILE
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await fs.writeFile(file, key + '\n', { mode: 0o600 })
    const ref = `\${file:${file}}`
    if (shared) {
      const providers = { ...(config.providers as Record<string, object> | undefined) }
      providers.openrouter = { ...(providers.openrouter as object | undefined), api_key: ref }
      await updateConfig({ providers: providers as never })
    } else {
      await updateConfig({ jev: { ...config.jev, api_key: ref } })
    }
    log.web.info('jev key stored', { file, shared })
    res.json({ ok: true, ref, shared })
  } catch (err) {
    next(err)
  }
})

jevRouter.delete('/key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    const jev = { ...config.jev }
    delete jev.api_key
    await updateConfig({ jev })
    // Remove the secret file only when config pointed at OUR managed Jev file —
    // a user-managed ${file:} path is theirs to keep, and the SHARED OpenRouter
    // provider credential is never touched here: chat models may be riding it,
    // and this endpoint's contract is "disconnect Jev", not "revoke the key".
    if (config.jev?.api_key === `\${file:${KEY_FILE}}`) {
      await fs.rm(KEY_FILE, { force: true })
    }
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

/**
 * Turn a gateway's error body into one readable line for the settings page.
 * jev-client throws `Jev <status>: <first 200 chars of body>`; gateways put
 * the useful sentence inside JSON, so a raw paste reads as noise. The STATUS
 * is always kept — it is what distinguishes "wrong key" (401) from "out of
 * credits" (402), and a prettier message must never cost that.
 */
function readableJevError(message: string): string {
  const match = message.match(/^(Jev \d+): ([\s\S]+)$/)
  if (!match) return message
  const [, prefix, body] = match
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
    const inner = typeof parsed.error === 'object' && parsed.error ? parsed.error.message : parsed.error
    const text = typeof inner === 'string' ? inner : typeof parsed.message === 'string' ? parsed.message : ''
    return text ? `${prefix}: ${text}` : message
  } catch {
    return message
  }
}

/** Real round-trip: one tiny decide() against the configured endpoint.
 *  Hard 6s deadline — a settings page must answer, never hang. */
jevRouter.post('/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    const jev = getJevClient(config)
    if (!jev) {
      res.json({ ok: false, error: 'not configured (missing or unresolvable api_key)' })
      return
    }
    const t0 = Date.now()
    try {
      const answers = await jev.decide(
        'Connectivity check from the Walnut settings page.',
        { check: { type: 'choice', instructions: 'Is this a connectivity check?', criteria: { yes: 'It is.', no: 'It is not.' } } },
        { timeoutMs: 6_000 },
      )
      res.json({ ok: true, ms: Date.now() - t0, model: jev.model, answered: Boolean(answers.check) })
    } catch (err) {
      // Bounded by jev-client (status + first 200 chars), then unwrapped for display.
      res.json({ ok: false, ms: Date.now() - t0, error: readableJevError(err instanceof Error ? err.message : String(err)) })
    }
  } catch (err) {
    next(err)
  }
})
