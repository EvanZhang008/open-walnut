/**
 * `walnut.notifications`: the plugin's side of the notification center.
 *
 * Four things live here, each stamped host-side with the plugin's identity so a
 * plugin can never act on anything that is not its own:
 *   - notify / error / recover: feed records under `plugin:<id>:<key>`.
 *   - reminders (`kind: 'reminder'`): a re-fire REPLACES the previous record, so a
 *     recurring prompt under a stable key alerts again even when nobody touched
 *     the last one, and `dismiss` retires it once it no longer applies.
 *   - buttons (`actions`): the plugin names its OWN op or dialog by its local name.
 *     The host stamps `pluginId` and prefixes ops (pluginOpName). The console route runs
 *     whatever op name it is handed, so the namespace is the only thing that keeps
 *     one plugin's notice from firing another plugin's op on a human's click.
 *   - quiet: one hold per plugin (`plugin:<id>`), cleared when the generation that
 *     set it is disposed (disable or reload), so a crashed focus timer cannot
 *     leave Walnut silent.
 */
import { bus, EventNames } from '../event-bus.js'
import { clearQuiet, getQuiet, setQuiet, type QuietState } from '../quiet/quiet-state.js'
import { experimentCache } from '../experimental-cache.js'
import { log } from '../../logging/index.js'

const focusSpacesOn = experimentCache('focus_workspace')
import { toDisposable, type Disposable } from './disposable.js'
import { pluginOpName, validatePluginId } from './ids.js'
import type { NotificationButton } from '../notifications/store.js'

/** Buttons one notice may carry; the console renders at most this many. */
export const MAX_NOTICE_ACTIONS = 3
const MAX_ACTION_LABEL = 40

export interface PluginNoticeInput {
  title: string
  body?: string
  severity?: 'info' | 'success' | 'warning' | 'error'
  dedupKey: string
  taskId?: string
  sessionId?: string
  /** error() only: the person must act (PluginNotice.needsYou). */
  needsYou?: boolean
  kind?: 'skill' | 'reminder'
  actions?: Array<{ label: string; args?: Record<string, unknown> } & (
    | { op: string; dialog?: never }
    | { dialog: string; op?: never }
  )>
}

export function namespacedDedup(pluginId: string, key: string): string {
  if (typeof key !== 'string' || !key.trim() || key.length > 160) {
    throw new Error('Plugin notification dedupKey must be 1-160 characters')
  }
  return `plugin:${pluginId}:${key}`
}

/** A plugin's local button list becomes host buttons bound to its own ops or dialogs. */
export function pluginNoticeActions(
  pluginId: string,
  actions: PluginNoticeInput['actions'],
): NotificationButton[] | undefined {
  if (actions === undefined) return undefined
  if (!Array.isArray(actions)) throw new Error('Plugin notification actions must be an array')
  if (actions.length > MAX_NOTICE_ACTIONS) {
    throw new Error(`A plugin notification carries at most ${MAX_NOTICE_ACTIONS} actions (got ${actions.length})`)
  }
  if (actions.length === 0) return undefined
  return actions.map((action) => {
    const label = typeof action?.label === 'string' ? action.label.trim() : ''
    if (!label || label.length > MAX_ACTION_LABEL) {
      throw new Error(`Plugin notification action label must be 1-${MAX_ACTION_LABEL} characters`)
    }
    const args = action.args
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      throw new Error('Plugin notification action args must be a plain object')
    }
    const hasOp = action.op !== undefined
    const hasDialog = action.dialog !== undefined
    if (hasOp === hasDialog) {
      throw new Error('Plugin notification action requires exactly one of op or dialog')
    }
    const shared = { label, pluginId, ...(args !== undefined ? { args: structuredClone(args) } : {}) }
    if (hasDialog) {
      // Same local id rule as the web slot API. The caller cannot supply an owner prefix.
      if (typeof action.dialog !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(action.dialog)) {
        throw new Error('Plugin notification dialog must be a local slot id')
      }
      validatePluginId(pluginId)
      return { ...shared, kind: 'dialog' as const, slot: action.dialog }
    }
    return { ...shared, kind: 'op' as const, op: pluginOpName(pluginId, action.op!) }
  })
}

let generationSeq = 0

export function createPluginNotifications(options: {
  pluginId: string
  own: <T extends Disposable>(registration: T) => T
  assertLive: (registration: string) => void
}) {
  const { pluginId } = options
  const source = `plugin:${pluginId}`
  const emitSource = { source: `plugin/${pluginId}` }
  // Which api generation set the hold: a replaced generation disposing late must
  // not clear the hold its successor just set.
  const owner = `${pluginId}#${++generationSeq}`
  let holdCleanup: Disposable | null = null

  const removed = (id: string, dedupKey: string): void => {
    bus.emit(EventNames.NOTIFICATION_REMOVED, { id, dedupKey }, ['web-ui'], emitSource)
  }

  return {
    async notify(notice: PluginNoticeInput): Promise<void> {
      const kind = notice.kind ?? 'skill'
      if (kind !== 'skill' && kind !== 'reminder') {
        throw new Error(`Plugin notification kind must be 'skill' or 'reminder' (got ${JSON.stringify(kind)})`)
      }
      const actions = pluginNoticeActions(pluginId, notice.actions)
      const input = {
        kind,
        severity: notice.severity ?? 'info',
        title: notice.title,
        body: notice.body,
        dedupKey: namespacedDedup(pluginId, notice.dedupKey),
        taskId: notice.taskId,
        sessionId: notice.sessionId,
        ...(actions ? { actions } : {}),
      } as const
      if (kind === 'reminder') {
        const { replaceNotification } = await import('../notifications/store.js')
        const { record, replaced } = await replaceNotification(input)
        // Removal FIRST: the client only toasts a key it is not already showing.
        if (replaced) removed(replaced.id, replaced.dedupKey)
        bus.emit('notification:new', record, ['web-ui'], emitSource)
        return
      }
      const { addNotification } = await import('../notifications/store.js')
      const record = await addNotification(input)
      bus.emit('notification:new', record, ['web-ui'], emitSource)
    },

    async error(notice: Omit<PluginNoticeInput, 'kind' | 'actions'>): Promise<void> {
      const { upsertNotification } = await import('../notifications/store.js')
      const { record, outcome } = await upsertNotification({
        kind: 'operation-error',
        severity: notice.severity ?? 'error',
        title: notice.title,
        body: notice.body,
        dedupKey: namespacedDedup(pluginId, notice.dedupKey),
        recoveryKey: `plugin:${pluginId}`,
        taskId: notice.taskId,
        sessionId: notice.sessionId,
        // Who sees it is decided in one place (notifications/audience.ts): the plugin says only
        // whether its person must act; everything else is Walnut Health's.
        ...(notice.needsYou === true ? { needsYou: 'plugin-asks' as const } : {}),
      })
      if (outcome !== 'suppressed') bus.emit(outcome === 'inserted' ? 'notification:new' : 'notification:updated', record, ['web-ui'], emitSource)
    },

    async recover(): Promise<void> {
      const { recoverNotifications } = await import('../notifications/store.js')
      const { recovered } = await recoverNotifications([`plugin:${pluginId}`])
      for (const record of recovered) bus.emit('notification:updated', record, ['web-ui'], emitSource)
    },

    async dismiss(dedupKey: string): Promise<void> {
      const key = namespacedDedup(pluginId, dedupKey)
      const { removeNotification } = await import('../notifications/store.js')
      const record = await removeNotification(key)
      // Announced even when the record was already gone: another tab may still be
      // showing the toast of a record the human dismissed somewhere else. `id` is
      // informational (empty then); clients match on dedupKey.
      removed(record?.id ?? '', key)
    },

    quiet: {
      async get(): Promise<QuietState> {
        return getQuiet()
      },
      async set(input: { until?: number; reason?: string; allowPermissions?: boolean; allowTasks?: string[]; showOnly?: boolean } = {}): Promise<void> {
        options.assertLive('notifications.quiet.set')
        holdCleanup ??= options.own(toDisposable(async () => {
          await clearQuiet(source, { owner })
          await leaveBlockFocus()
        }))
        const tasks = Array.isArray(input.allowTasks) ? input.allowTasks.filter((t) => typeof t === 'string' && t) : []
        const scoped = tasks.length > 0 && await focusSpacesOn.on()
        await setQuiet({
          source,
          owner,
          ...(input.until !== undefined ? { until: input.until } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.allowPermissions !== undefined ? { allowPermissions: input.allowPermissions } : {}),
          // A hold that lets its tasks through exists only while focus spaces are on.
          ...(scoped ? { scope: { tasks } } : {}),
        })
        if (scoped && input.showOnly) await enterBlockFocus(tasks, input.until)
        else await leaveBlockFocus()
      },
      async clear(): Promise<void> {
        await clearQuiet(source)
        await leaveBlockFocus()
      },
    },
  }
}

/**
 * A focus block on tasks also shows only them (a focus space of its own, `by: 'block'`), and
 * never takes the place of a focus the person chose: it enters only when there is none or the
 * one there is a block's, and its end leaves only a block's.
 */
async function enterBlockFocus(tasks: string[], until: number | undefined): Promise<void> {
  try {
    const { enterFocus, getActiveFocus } = await import('../focus-spaces/active.js')
    const now = await getActiveFocus()
    if (now && now.by !== 'block') return
    const { getTask } = await import('../task-manager.js')
    const title = tasks.length === 1 ? (await getTask(tasks[0]).catch(() => null))?.title : undefined
    const live = until !== undefined && until > Date.now() && until <= Date.now() + 24 * 3600_000
    await enterFocus({ scope: { tasks }, name: title || 'Focus block', by: 'block', ...(live ? { until } : {}) })
  } catch (err) {
    log.notif.warn('focus block could not enter its focus space', { error: String(err) })
  }
}

async function leaveBlockFocus(): Promise<void> {
  try {
    const { leaveFocus } = await import('../focus-spaces/active.js')
    await leaveFocus({ onlyBy: 'block' })
  } catch (err) {
    log.notif.warn('focus block could not leave its focus space', { error: String(err) })
  }
}
