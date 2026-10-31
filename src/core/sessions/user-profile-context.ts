/**
 * The user's profile and standing rules (memory/USER.md) in the Walnut context of
 * every task session: Main, every lead, every worker and every ask.
 *
 * 2026-10-28 (org reflection): Main is told to keep the user's lasting rules in
 * USER.md (session-context.ts MAIN_TRACKING_LINE), and only the Personal AI's
 * persona read it, frozen at spawn. Leads and workers never saw it, a running
 * session never heard a change, and the user had to repeat a rule ("didn't I
 * already tell you?").
 *
 * The block rides the default instructions (session-context.ts), so a running
 * session hears a change through the instruction notice like any rule. Every line
 * carries a version of the words and of when they were saved, as the org
 * instructions do (orgInstructionsLine), which marks the lines as one versioned
 * block: the notice compares a new version with the one the session holds by its
 * words (instruction-diff.ts) and tells only the new or reworded lines and the
 * removed ones, so a rule the user removed never reads as still in force and a
 * one-line save costs one line (2026-10-30: it had re-sent the whole 4.9 KB block to
 * about 25 sessions). A file emptied of its rules says so in one line.
 *
 * The prompt builders are sync (defaultInstructions, the host slice), so the text
 * is read here and kept: every async path calls refreshUserProfile first (a stat,
 * and a read only when the file changed), and a sync read of a copy older than a
 * few seconds starts a refresh in the background. Never throws: a missing or
 * unreadable file is no block.
 */

import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { USER_FILE } from '../../constants.js'
import { parseMemoryContent, preambleProse, USER_CHAR_BUDGET } from '../bounded-memory.js'
import { screenEntriesForPrompt } from '../memory-safety.js'

/**
 * What a session reads of USER.md: its words, when they were saved, and whether the file exists
 * at all. `cut`: the lines past the character budget, still in the file but not in the prompt;
 * a line the budget cuts is never told as removed (2026-10-30: a save over the budget told every
 * session two rules that were still in the file were no longer in force).
 */
export interface UserProfile { text: string; savedAt: string; exists: boolean; cut?: string[] }

const NONE: UserProfile = { text: '', savedAt: '', exists: false }
/** A hand-edited file can be any size: only its head is parsed and screened. */
const READ_MAX = 64 * 1024
/** In place of an entry the safety screen held back: the Personal AI's marker asks it to act, a task session must not. */
const WITHHELD = '(Walnut held back one entry of USER.md: it reads like an instruction to act on outside text. The user can review it under Memory.)'

/** The words a session reads: the file's sections (and any prose above them), screened and capped. */
export function userProfileText(raw: string): string {
  return userProfileFit(raw).text
}

/** The capped words, and the lines the budget left out (`cut`), with how long the whole would be. */
export function userProfileFit(raw: string): { text: string; cut: string[]; size: number } {
  const { preamble, entries } = parseMemoryContent(raw.slice(0, READ_MAX).replace(/\r\n/g, '\n'))
  // The preamble holds the frontmatter and the "# USER.md" title; prose a person wrote there stays.
  const prose = preambleProse(preamble).split('\n').filter((l) => !/^#\s+USER\.md\b/i.test(l.trim())).join('\n').trim()
  const parts = [prose, ...entries].filter((p) => p.trim())
  const screened = screenEntriesForPrompt(parts, 'USER.md').map((p, i) => (p === parts[i] ? p : WITHHELD))
  const kept: string[] = []
  const cut: string[] = []
  let used = 0
  for (const [i, part] of screened.entries()) {
    const room = USER_CHAR_BUDGET - used - (kept.length ? 2 : 0)
    if (part.length <= room) { kept.push(part); used += part.length + (kept.length > 1 ? 2 : 0); continue }
    // Over the budget: whole lines of this section while they fit, then a note.
    const lines: string[] = []
    let n = 0
    const all = part.split('\n')
    for (const line of all) {
      if (n + line.length + 1 > room) break
      lines.push(line)
      n += line.length + 1
    }
    if (lines.length) kept.push(lines.join('\n'))
    kept.push(`(USER.md runs past ${USER_CHAR_BUDGET} characters here; memory_read doc "user" has the rest.)`)
    for (const rest of [...all.slice(lines.length), ...screened.slice(i + 1).flatMap((p) => p.split('\n'))]) {
      if (rest.trim()) cut.push(rest.trimEnd().trim())
    }
    break
  }
  return { text: kept.join('\n\n'), cut, size: screened.join('\n\n').length }
}

/**
 * The block for the prompt, under its own heading (so the instruction notice shows its lines
 * there): an intro naming the version, then every line tagged with it. '' when there is no file.
 */
export function userProfileLine(p: UserProfile): string {
  if (!p.exists) return ''
  const version = `v${createHash('sha1').update(`${p.savedAt}\n${p.text}`).digest('hex').slice(0, 8)}`
  const saved = p.savedAt ? `, saved ${p.savedAt.slice(0, 16).replace('T', ' ')} UTC` : ''
  const head = '## Your user\n\n'
  if (!p.text.trim()) {
    return `${head}Your user's profile and standing rules, from memory/USER.md (${version}${saved}): none are recorded `
      + 'now, so no earlier version of them applies.\n\n'
  }
  const tagged = p.text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).map((l) => `[${version}] ${l}`).join('\n')
  return `${head}Your user's profile and standing rules, from memory/USER.md (${version}${saved}): who they are and `
    + 'how they want the work done. Follow them in every task; a newer word from the user wins. They replace every '
    + `earlier version. Each line of this version starts with [${version}]:\n${tagged}\n\n`
}

function profileOf(raw: string, savedAt: string): UserProfile {
  const { text, cut } = userProfileFit(raw)
  return { text, savedAt, exists: true, ...(cut.length ? { cut } : {}) }
}

let cached: { key: string; profile: UserProfile } = { key: '', profile: NONE }
let checkedAt = 0
let inflight: Promise<UserProfile> | null = null
const SYNC_STALE_MS = 5_000

/**
 * The companion's USER.md is the Mac's copy (companion-memory.ts), not its disk, which git
 * sync no longer writes: the doc it shows, 'keep' when the copy could not be read (the last
 * one stays), or null when this is not the companion.
 */
async function companionUserDoc(): Promise<{ key: string; profile: () => UserProfile } | 'keep' | null> {
  const { followerKind } = await import('../server-role.js')
  if (followerKind() !== 'companion') return null
  try {
    const { companionMemoryDoc } = await import('../companion-memory.js')
    const doc = companionMemoryDoc('user')
    if (!doc) return { key: 'copy:none', profile: () => NONE }
    return {
      key: `copy:${doc.contentHash}:${doc.updatedAt}`,
      profile: () => profileOf(doc.content, doc.updatedAt),
    }
  } catch {
    return 'keep'
  }
}

/** Read USER.md again when it changed since the last read; what a session reads now. Never throws. */
export function refreshUserProfile(): Promise<UserProfile> {
  if (inflight) return inflight
  const read = (async () => {
    try {
      const copy = await companionUserDoc()
      if (copy === 'keep') {
        // The copy is the truth here: never the box's stale disk in its place.
      } else if (copy) {
        if (copy.key !== cached.key) cached = { key: copy.key, profile: copy.profile() }
      } else {
        const st = await fsp.stat(USER_FILE).catch(() => null)
        const key = st ? `${USER_FILE}:${st.ino}:${st.size}:${st.mtimeMs}` : `${USER_FILE}:none`
        if (key !== cached.key) {
          const raw = st ? await fsp.readFile(USER_FILE, 'utf-8').catch(() => null) : null
          cached = { key, profile: raw === null || !st ? NONE : profileOf(raw, st.mtime.toISOString()) }
        }
      }
    } catch { /* keep the last copy */ }
    checkedAt = Date.now()
    return cached.profile
  })().finally(() => { inflight = null })
  inflight = read
  return read
}

/** The last copy read, for the sync prompt builders; an old copy starts a refresh for the next caller. */
export function currentUserProfile(): UserProfile {
  if (Date.now() - checkedAt > SYNC_STALE_MS) void refreshUserProfile()
  return cached.profile
}
