/**
 * `walnut.notifications`: the plugin's side of the notification center.
 *
 * Four things live here, each stamped host-side with the plugin's identity so a
 * plugin can never act on anything that is not its own:
 *   - notify / error / recover: feed records under `plugin:<id>:<key>`.
 *   - reminders (`kind: 'reminder'`): a re-fire REPLACES the previous record, so a
 *     recurring prompt under a stable key alerts again even when nobody touched
 *     the last one, and `dismiss` retires it once it no longer applies.
 *   - buttons (`actions`): the plugin names its OWN op by its local name and the
 *     host prefixes it (pluginOpName) and stamps `pluginId`. The console route runs
 *     whatever op name it is handed, so the namespace is the only thing that keeps
 *     one plugin's notice from firing another plugin's op on a human's click.
 *   - quiet: one hold per plugin (`plugin:<id>`), cleared when the generation that
 *     set it is disposed (disable or reload), so a crashed focus timer cannot
 *     leave Walnut silent.
 */
import { bus, EventNames } from '../event-bus.js'
import { clearQuiet, getQuiet, setQuiet, type QuietState } from '../quiet/quiet-state.js'
import { toDisposable, type Disposable } from './disposable.js'
import { pluginOpName } from './ids.js'
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
  kind?: 'skill' | 'reminder'
  actions?: Array<{ label: string; op: string; args?: Record<string, unknown> }>
}

export function namespacedDedup(pluginId: string, key: string): string {
  if (typeof key !== 'string' || !key.trim() || key.length > 160) {
    throw new Error('Plugin notification dedupKey must be 1-160 characters')
  }
  return `plugin:${pluginId}:${key}`
}

/** A plugin's local button list → host buttons bound to that plugin's ops. Throws on a bad list. */
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
    return {
      kind: 'op' as const,
      label,
      pluginId,
      op: pluginOpName(pluginId, action.op),
      ...(args !== undefined ? { args: structuredClone(args) } : {}),
    }
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
      })
      bus.emit(outcome === 'inserted' ? 'notification:new' : 'notification:updated', record, ['web-ui'], emitSource)
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
      async set(input: { until?: number; reason?: string; allowPermissions?: boolean } = {}): Promise<void> {
        options.assertLive('notifications.quiet.set')
        holdCleanup ??= options.own(toDisposable(async () => { await clearQuiet(source, { owner }) }))
        await setQuiet({
          source,
          owner,
          ...(input.until !== undefined ? { until: input.until } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.allowPermissions !== undefined ? { allowPermissions: input.allowPermissions } : {}),
        })
      },
      async clear(): Promise<void> {
        await clearQuiet(source)
      },
    },
  }
}
