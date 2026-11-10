/**
 * Inbox sorting's rules WRITE routes: `PUT /rules`, `POST /rules/init`, `POST /rules/restore`, and
 * the server's mirror of the Grouped / All mail switch (`PUT /groups/pref`).
 *
 * Every one of them is a human's click (Settings, the correction card, the switch), never an
 * automatic write: a learned rule reaches the file only through `PUT /rules`.
 */
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import { PRIMARY_ONLY, errorReply } from './contract.js'
import { testRunPrefsWrite } from '../../core/test-run-prefs.js'
import { ambientTestRun } from '../../core/test-run.js'
import { TEST_RUN_MOVE } from './routes-sort-write.js'
import type { MailSortEngine } from './sort-engine.js'
import type { MailStore } from './store.js'

async function readJson(request: { json<T = unknown>(): Promise<T> }): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json<unknown>()
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

function touchOf(value: unknown): { accountId: string; messageId: string } | undefined {
  const raw = value as { accountId?: unknown; messageId?: unknown } | null
  if (!raw || typeof raw !== 'object') return undefined
  return typeof raw.accountId === 'string' && raw.accountId && typeof raw.messageId === 'string' && raw.messageId
    ? { accountId: raw.accountId, messageId: raw.messageId }
    : undefined
}


/** Does this rules list hold a filter that moves mail (moveTo, skipInbox) the saved file does not have as it is? */
function addsMove(rules: unknown[], sort: MailSortEngine): boolean {
  return rules.some((item) => {
    if (!item || typeof item !== 'object') return false
    const rule = item as { id?: unknown; moveTo?: unknown; skipInbox?: unknown }
    if (rule.skipInbox !== true && typeof rule.moveTo !== 'string') return false
    const current = typeof rule.id === 'string' ? sort.filterTarget(rule.id) : null
    if (!current) return true
    return (typeof rule.moveTo === 'string' ? rule.moveTo.trim() : undefined) !== current.folder
  })
}

export function registerMailSortRulesRoutes(
  walnut: WalnutServerPluginApi,
  deps: { store: MailStore; sort: MailSortEngine },
): void {
  const { sort } = deps

  walnut.http.route('put', '/rules', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const body = await readJson(request)
    if (!body) return { status: 400, json: { error: 'invalid', message: 'body must be JSON' } }
    if (typeof body.baseRev !== 'string' || !body.baseRev) {
      return { status: 400, json: { error: 'invalid', message: 'baseRev (the fileRev you last read) is required' } }
    }
    if (!Array.isArray(body.rules) || (body.groups !== undefined && !Array.isArray(body.groups))) {
      return { status: 400, json: { error: 'invalid', message: 'groups and rules must be lists' } }
    }
    try {
      await sort.ready()
      // A test run may not add or retarget a filter that moves mail out of the inbox (routes-sort-write.ts).
      if (ambientTestRun() && addsMove(body.rules, sort)) return TEST_RUN_MOVE
      const touch = touchOf(body.touch)
      const outcome = await sort.saveRules({ groups: body.groups ?? [], rules: body.rules }, body.baseRev, touch)
      if (!outcome.ok) return { status: outcome.status, json: outcome.json }
      return { json: { rulesRev: outcome.rulesRev ?? sort.rulesRev, fileRev: outcome.fileRev } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('post', '/rules/init', async () => {
    if (walnut.replica) return PRIMARY_ONLY
    try {
      await sort.ready()
      const outcome = await sort.initRules()
      if (!outcome.ok) return { status: outcome.status, json: outcome.json }
      return { status: 201, json: { rulesRev: sort.rulesRev, fileRev: outcome.fileRev, path: sort.rulesPath } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('post', '/rules/restore', async () => {
    if (walnut.replica) return PRIMARY_ONLY
    try {
      await sort.ready()
      const outcome = await sort.restoreRules()
      if (!outcome.ok) return { status: outcome.status, json: outcome.json }
      return { json: { rulesRev: sort.rulesRev, fileRev: outcome.fileRev } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('put', '/groups/pref', async (request) => {
    if (walnut.replica) return PRIMARY_ONLY
    const body = await readJson(request)
    if (!body || typeof body.on !== 'boolean') {
      return { status: 400, json: { error: 'invalid', message: 'on must be true or false' } }
    }
    try {
      // A test run's switch is its own copy, never the user's (core/test-run-prefs.ts).
      const own = testRunPrefsWrite<{ on: boolean }>('mail-grouped', () => ({ on: body.on as boolean }))
      if (own) { own.on = body.on; return { json: { on: own.on } } }
      await sort.ready()
      await sort.setGroupedOn(body.on)
      return { json: { on: sort.groupedOn() } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })
}
