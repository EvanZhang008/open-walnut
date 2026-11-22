/**
 * The user's Reply language setting as a line of every session's system prompt (2026-11-06, the
 * user: "just remove reply language"; it rode messages as a hint, every message for a while, with
 * a correction line in a language of Walnut's own). It is a standing rule, so it lives where rules
 * live: the prompt, and a change reaches a running session as a changed default instruction
 * (instruction-notice.ts). Empty setting, no line, so a fresh install says nothing about language.
 *
 * The prompt builders are sync, so the setting is read here and kept; every async path that builds
 * or compares a prompt calls refreshReplyLanguage first, as it does for USER.md.
 */

import { createHash } from 'node:crypto'
import { versionedBlock } from './instruction-diff.js'
import { STILL_THE_USERS } from '../approval-kinds.js'
import { replyLanguageText } from './output-mode.js'

const SYNC_STALE_MS = 5_000

let cached: string | null = null
/** The Approvals switch (approvals/ask-me.ts), read with the language: both are the user's settings in the prompt. */
let askMe = true
/** The real-use watch experiment (core/usage-watch/gate.ts), read with them: its rule is in the prompt only while on. */
let realUse = false
let checkedAt = 0
let inflight: Promise<string | null> | null = null

/** Read the setting again; what a session's prompt says now. Never throws. */
export function refreshReplyLanguage(): Promise<string | null> {
  if (inflight) return inflight
  const read = (async () => {
    try {
      const { getConfig } = await import('../config-manager.js')
      // The setting alone decides (empty = no line). An old reply-language hint override is not
      // read: Settings no longer shows it, so nobody could see or undo what it did.
      const config = await getConfig()
      cached = replyLanguageText(config)
      const { askMeOf } = await import('../approvals/ask-me.js')
      askMe = askMeOf(config)
      const { experimentalEnabled } = await import('../experimental.js')
      realUse = experimentalEnabled(config.experimental, 'real_use_watch')
    } catch { /* keep the last copy */ }
    checkedAt = Date.now()
    return cached
  })().finally(() => { inflight = null })
  inflight = read
  return read
}

/** The last copy read, for the sync prompt builders; an old copy starts a refresh for the next caller. */
export function currentReplyLanguage(): string | null {
  if (Date.now() - checkedAt > SYNC_STALE_MS) void refreshReplyLanguage()
  return cached
}

/**
 * The prompt's block, or '' while the setting is empty. A versioned block (instruction-diff.ts), not
 * a plain line: a running session hears a new language, one set back to an earlier one, and a
 * cleared setting ("gone"), and a block skips the notice's 3-hour gap. A plain line was told only
 * when new, so a cleared or restored setting never reached it.
 */
export function replyLanguageLine(text: string | null): string {
  if (!text?.trim()) return ''
  const version = `v${createHash('sha1').update(text).digest('hex').slice(0, 8)}`
  return versionedBlock(`Reply language, the user's setting (${version}): it covers every line the user reads, the short progress `
    + 'lines between tool calls and what you send to other tasks (task_send, org_send, a reply) included: the user reads those chats too.',
  version, text.split('\n').map((l) => l.trim()).join('\n'))
}

/** The last Approvals switch read, for the sync prompt builders (true until one is read: ask). */
export function currentApprovalsAsk(): boolean {
  if (Date.now() - checkedAt > SYNC_STALE_MS) void refreshReplyLanguage()
  return askMe
}

/**
 * The prompt's line while approvals are off (2026-11-12, the user: "somehow AI need my approval for
 * post etc ... I want it to be off by default don't need my approval for anything"). The switch
 * changes what Walnut stops, never whose decision a step is (2026-11-17, approval-kinds.ts: a VP
 * read the old "an outward message is not the user's decision now" and signed him up for a
 * colleague's office hour in his name). On: no line, the charter as it is.
 */
export function approvalsLine(ask: boolean): string {
  if (ask) return ''
  const still = Object.values(STILL_THE_USERS)
  return 'Approvals are off (the user\'s setting, Settings \u203a General): Walnut no longer stops a post, a mail, '
    + 'a browser step or a command on another host for the user\'s yes; it records each (a `walnut approve` in a '
    + 'script still asks the user). The switch changes only what Walnut stops, never whose decision a step is: '
    + `still get the user's own explicit yes before ${still.slice(0, -1).join(', ')}, or ${still[still.length - 1]}, `
    + 'and settle a teammate\'s ask of those kinds (task_send answers_ask) only with user_words quoting them.\n\n'
}

/** The last real-use experiment read, for the sync prompt builders (false until one is read). */
export function currentRealUseWatch(): boolean {
  if (Date.now() - checkedAt > SYNC_STALE_MS) void refreshReplyLanguage()
  return realUse
}

/**
 * The prompt's rule while the real-use watch is on (2026-11-21, the user, after a tool's answer was
 * cut three times in one day: "it need to not just complete the task, need to have some monitoring
 * to gather real world feedback ... for each task taht change these kind of thing"). Off: no line.
 */
export function realUseLine(on: boolean): string {
  if (!on) return ''
  return 'Real use: a change you ship (a land, deploy or publish) is watched in real use after it ships. Before you '
    + 'complete a task that shipped, arm a watch on what you changed: usage_watch {"action":"set","targets":["op:<tool>", '
    + '"route:GET /api/...", "page:<part>"],"who":"this task","check_after":"24h"}; task_complete refuses without one. '
    + 'Only copy, colour, docs or tests, a ship that did not happen, or one watched outside Walnut (a pipeline alarm): usage_watch {"action":"exempt","kind":...,"reason":...}. '
    + 'An alarm on your targets comes to this task until the check time: fix it there.\n\n'
}

/** Tests: forget the copy. */
export function _resetReplyLanguageForTesting(value: string | null = null): void {
  cached = value
  askMe = true
  realUse = false
  checkedAt = value === null ? 0 : Date.now()
  inflight = null
}
