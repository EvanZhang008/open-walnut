/**
 * Writes link tags (link-tags.ts) onto tasks, from two sources:
 *   - what a person sends into a session (its launch prompt, the composer, the phone, the CLI):
 *     every URL a link pattern recognises is tagged at once;
 *   - the LINKS field of the session's turn-end self-report (session-hooks/builtins.ts), which
 *     names the kind of links no pattern knows.
 * Automated sends and launches (triggers, notices, other tasks, retries, Personal AI lanes) are
 * never read: a notice quoting another task's link is not this task's link. Never throws; a failed write waits for the next mention.
 */

import { bus, eventData, EventNames } from './event-bus.js'
import { log } from '../logging/index.js'
import { effectiveLinkPatterns, linkTagsFromField, linkTagsInText, newLinkTags, type LinkPattern } from './link-tags.js'

/** Send sources a person typed (phase.ts REOPENING_SEND_SOURCES minus the peer and letter paths). */
const HUMAN_SEND_SOURCES: ReadonlySet<string> = new Set(['ui', 'mobile', 'cli', 'web-api', 'api-v1', 'chat'])
/** Launches a person made in the console (a draft, a Start). Retries, routines, forks and the
 *  Personal AI lanes are left out: their first message carries text Walnut wrote (a recap, a
 *  persona), which may quote other tasks' links. */
const HUMAN_START_SOURCES: ReadonlySet<string> = new Set(['quick-start', 'web-ui', 'web-api'])

async function linkPatterns(): Promise<LinkPattern[]> {
  try {
    const { getConfig } = await import('./config-manager.js')
    return effectiveLinkPatterns((await getConfig()).link_tags)
  } catch {
    return effectiveLinkPatterns(undefined)
  }
}

/** Add the candidates the task does not hold yet. Returns the tags added. */
export async function addLinkTags(taskId: string, candidates: readonly string[], source: string): Promise<string[]> {
  if (candidates.length === 0) return []
  try {
    const { getTask, updateTask } = await import('./task-manager.js')
    // Checked before the write so a mention of a known link costs no task write.
    const current = await getTask(taskId)
    if (newLinkTags(current, candidates).length === 0) return []
    const before = new Set(current.tags ?? [])
    const { task } = await updateTask(taskId, { add_link_tags: [...candidates] }, { source: 'link-tags' })
    const added = (task.tags ?? []).filter((tag) => !before.has(tag))
    if (added.length === 0) return []
    log.task.info('link tags added', { taskId, source, added })
    return added
  } catch (err) {
    log.task.debug('link tags skipped', { taskId, source, error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

export async function tagLinksInText(taskId: string, text: string, source: string): Promise<string[]> {
  if (!text || !/https?:\/\//i.test(text)) return []
  return addLinkTags(taskId, linkTagsInText(text, await linkPatterns()), source)
}

export async function tagLinksFromReportField(taskId: string, field: string): Promise<string[]> {
  const text = field.trim()
  if (!text || /^(?:unchanged|none)\b/i.test(text)) return []
  return addLinkTags(taskId, linkTagsFromField(text, await linkPatterns()), 'self-report')
}

async function taskOfSession(sessionId: string): Promise<string | undefined> {
  const { getSessionByClaudeId } = await import('./session-tracker.js')
  return (await getSessionByClaudeId(sessionId))?.taskId ?? undefined
}

/** Subscribe to session launches and human sends. Idempotent (the bus keys subscribers by name). */
export function startLinkTagWatcher(): () => void {
  bus.subscribe('link-tags', (event) => {
    if (event.name === EventNames.SESSION_START) {
      if (!HUMAN_START_SOURCES.has(event.source)) return
      const data = eventData<'session:start'>(event)
      if (data.forkedFromSessionId) return
      if (data.taskId && data.message) void tagLinksInText(data.taskId, data.message, `start:${event.source}`)
      return
    }
    if (event.name === EventNames.SESSION_SEND && HUMAN_SEND_SOURCES.has(event.source)) {
      const data = eventData<'session:send'>(event)
      if (!data.message || !/https?:\/\//i.test(data.message)) return
      void (async () => {
        const taskId = data.taskId ?? await taskOfSession(data.sessionId).catch(() => undefined)
        if (taskId) await tagLinksInText(taskId, data.message, `send:${event.source}`)
      })()
    }
  }, { global: true, interest: [EventNames.SESSION_START, EventNames.SESSION_SEND] })
  return () => bus.unsubscribe('link-tags')
}
