/**
 * The send gate: a session's words the user reads (lib/user-text-ops.ts) that are not in the language
 * his Reply language setting names are not sent; the op answers with a refusal saying so, and the
 * session writes them again (lib/reply-language.ts judges). Only a session's own call (the executor
 * passes its id), never a person's, a plugin's or a script's; only while the setting names a language
 * and the `reply_language_gate` experiment is on, which the server says (GET /me/reply-language).
 * A send that went out is never noted and a chat reply is never judged: the user removed those on
 * 2026-11-20 (tests/core/hints/no-reply-language-reminder.test.ts).
 *
 * WALNUT_REPLY_LANGUAGE_GATE=0 in the caller's env turns it off. Fails open: a server that is away, too old for the route, or slow lets the send go.
 */
import { GATE_MIN_WORDS, gateRefusal, measureScript, readsOffScript, type Script } from '../lib/reply-language.js'
import { USER_TEXT_OPS, opUserText } from '../lib/user-text-ops.js'
import { listOps } from './registry.js'

export interface GateSetting { rule: string; script: Script }

/** What the server says about the gate, from GET /me/reply-language's body; null: no gate. */
export function gateSettingOf(body: unknown): GateSetting | null {
  const b = body as { rule?: unknown; script?: unknown } | null
  return b && typeof b.rule === 'string' && b.rule.trim() && typeof b.script === 'string' ? { rule: b.rule, script: b.script as Script } : null
}

/** The code a held send answers with (usage-watch counts it apart from bad arguments). */
export const REPLY_LANGUAGE_CODE = 'reply_language'

/** The route the gate reads, relative to the op API base. */
export const GATE_SETTING_PATH = '/me/reply-language'

const CACHE_MS = 30_000
/** One server's answer: a process talks to one Walnut. */
let kept: { base: string; at: number; value: GateSetting | null } | null = null

/**
 * The setting for the server at `base`, kept 30 s (a session's MCP server makes many
 * calls). `get` answers the route's body, or undefined when no server answered (not kept, so the
 * next call asks again).
 */
export async function gateSettingFor(base: string, get: () => Promise<{ answered: boolean; body?: unknown }>): Promise<GateSetting | null> {
  if (kept && kept.base === base && Date.now() - kept.at < CACHE_MS) return kept.value
  const r = await get().catch(() => ({ answered: false } as { answered: boolean; body?: unknown }))
  const value = r.answered ? gateSettingOf(r.body) : null
  if (r.answered) kept = { base, at: Date.now(), value }
  return value
}

/** Tests: forget what was read. */
export function _resetGateSettingCache(): void { kept = null }

/** A route template (`/tasks/:id/report`) as a pattern, with its parameter names. */
function routePattern(template: string): { re: RegExp; names: string[] } {
  const names: string[] = []
  const source = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z_]\w*)/g, (_m, n: string) => { names.push(n); return '([^/]+)' })
  return { re: new RegExp(`^${source}$`), names }
}

/**
 * The op an `api` passthrough call is, with its arguments (path parameters and the body): an op
 * bound to that route, or a handler op that declares it among its routes. A handler op reached by a
 * route it does not declare is not known here.
 */
function boundCall(method: unknown, path: unknown, body: unknown): { op: string; args: Record<string, unknown> } | null {
  if (typeof method !== 'string' || typeof path !== 'string') return null
  const verb = method.toUpperCase()
  const tail = path.split('?')[0].replace(/^\/api(?:\/v1)?(?=\/)/, '')
  for (const op of listOps({ includeDeprecated: true })) {
    if (!USER_TEXT_OPS[op.name]) continue
    for (const route of [...(op.bind ? [op.bind] : []), ...(op.routes ?? [])]) {
      if (route.method !== verb) continue
      const { re, names } = routePattern(route.path.replace(/^\/api(?:\/v1)?(?=\/)/, ''))
      const m = re.exec(tail)
      if (!m) continue
      const args: Record<string, unknown> = body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {}
      names.forEach((n, i) => { args[n] = decodeURIComponent(m[i + 1]) })
      return { op: op.name, args }
    }
  }
  return null
}

/**
 * The refusal for a session's call of `name` whose words for the user are in another language, or
 * null to let it run. `read` is asked only when there are words enough to judge.
 */
export async function replyLanguageRefusal(name: string, args: Record<string, unknown>, read: () => Promise<GateSetting | null>): Promise<string | null> {
  if (process.env.WALNUT_REPLY_LANGUAGE_GATE === '0') return null
  let op = name
  let opArgs: unknown = args
  if (name === 'api') {
    const call = boundCall(args.method, args.path, args.body)
    if (!call) return null
    op = call.op
    opArgs = call.args
  }
  const t = opUserText(op, opArgs)
  if (!t || measureScript(t.text, 'latin').words < GATE_MIN_WORDS) return null
  const setting = await read().catch(() => null)
  if (!setting) return null
  // Each field with words enough is judged on its own (a Chinese title never carries an English
  // body), then all of them together (many short English labels).
  for (const f of t.byField) {
    const m = readsOffScript(f.text, setting.script)
    if (m) return gateRefusal(`${t.spec.what}, its ${f.field},`, setting.rule, m, `Write it again in that language and call ${op} again.`)
  }
  const m = readsOffScript(t.text, setting.script)
  return m ? gateRefusal(t.spec.what, setting.rule, m, `Write it again in that language and call ${op} again.`) : null
}
