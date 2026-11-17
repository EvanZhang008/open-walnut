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
import { pluginLinkPatterns } from './link-kinds.js'
import { droppedLinkTags, effectiveLinkPatterns, linkEntriesFromField, linkTagsInText, linkTargetOfTag, mergeLinkNames, newLinkTags, relabelLinkTags, type LinkPattern } from './link-tags.js'

/** Send sources a person typed (phase.ts REOPENING_SEND_SOURCES minus the peer and letter paths). */
const HUMAN_SEND_SOURCES: ReadonlySet<string> = new Set(['ui', 'mobile', 'cli', 'web-api', 'api-v1', 'chat'])
/** Launches a person made in the console (a draft, a Start). Retries, routines, forks and the
 *  Personal AI lanes are left out: their first message carries text Walnut wrote (a recap, a
 *  persona), which may quote other tasks' links. */
const HUMAN_START_SOURCES: ReadonlySet<string> = new Set(['quick-start', 'web-ui', 'web-api'])

async function linkPatterns(): Promise<LinkPattern[]> {
  const plugins = pluginLinkPatterns()
  try {
    const { getConfig } = await import('./config-manager.js')
    return effectiveLinkPatterns((await getConfig()).link_tags, plugins)
  } catch {
    return effectiveLinkPatterns(undefined, plugins)
  }
}

/** Add the candidates (`key:url` link tags) the task does not hold yet, and the names a session
 *  gave them (target to name). `whole`: the candidates are the session's whole list of the task's
 *  links, so the links Walnut added that it leaves out are dropped first (droppedLinkTags) and the
 *  list takes their places. Returns the tags added. */
export async function addLinkTags(taskId: string, candidates: readonly string[], source: string, names?: Record<string, string>, opts: { whole?: boolean } = {}): Promise<string[]> {
  if (candidates.length === 0) return []
  try {
    const { getTask, updateTask } = await import('./task-manager.js')
    // Checked before the write so a mention of a known link costs no task write.
    const current = await getTask(taskId)
    const dropped = opts.whole ? droppedLinkTags(current, candidates) : []
    const gone = new Set(dropped.map((tag) => linkTargetOfTag(tag)))
    const kept = {
      tags: (current.tags ?? []).filter((tag) => !dropped.includes(tag)),
      auto_links: (current.auto_links ?? []).filter((target) => !gone.has(target)),
    }
    const added = newLinkTags(kept, candidates)
    const named = names && Object.keys(names).length
      ? mergeLinkNames({ ...current, tags: [...kept.tags, ...added] }, names)
      : undefined
    if (added.length === 0 && dropped.length === 0 && relabelLinkTags(current, candidates).length === 0 && !named) return []
    const before = new Set(current.tags ?? [])
    const { task } = await updateTask(taskId, {
      ...(dropped.length ? { remove_link_tags: dropped } : {}),
      add_link_tags: [...candidates], ...(named ? { add_link_names: names } : {}),
    }, { source: 'link-tags' })
    const tagged = (task.tags ?? []).filter((tag) => !before.has(tag))
    if (dropped.length) log.task.info('link tags dropped', { taskId, source, dropped })
    if (named) log.task.info('link names set', { taskId, source, names: task.link_names })
    if (tagged.length === 0) return []
    log.task.info('link tags added', { taskId, source, added: tagged })
    return tagged
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
  const entries = linkEntriesFromField(text, await linkPatterns())
  const names: Record<string, string> = {}
  for (const { tag, name } of entries) if (name) names[linkTargetOfTag(tag)!] = name
  // The field is the task's whole list of links now (the prompt asks for it so): what it leaves
  // out, Walnut drops, if Walnut added it.
  return addLinkTags(taskId, entries.map((e) => e.tag), 'self-report', names, { whole: true })
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
