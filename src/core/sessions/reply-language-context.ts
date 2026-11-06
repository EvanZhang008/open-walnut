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
import { replyLanguageText } from './output-mode.js'

const SYNC_STALE_MS = 5_000

let cached: string | null = null
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
      cached = replyLanguageText(await getConfig())
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
  const tagged = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `[${version}] ${l}`).join('\n')
  return `Reply language, the user's setting (${version}): it covers every line the user reads, the short progress `
    + `lines between tool calls included. Each line of this version starts with [${version}]:\n${tagged}\n\n`
}

/** Tests: forget the copy. */
export function _resetReplyLanguageForTesting(value: string | null = null): void {
  cached = value
  checkedAt = value === null ? 0 : Date.now()
  inflight = null
}
