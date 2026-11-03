/**
 * Words for a git plugin source's automatic updates (server: core/plugins/source-auto-update.ts).
 *
 * Framework-free like plugin-update-view.ts: the root vitest tier pins every sentence, and
 * the React row only draws what this returns.
 *
 *   - `updatedLine`: "Updated to b19f830 5 min ago, by itself", the help line under the switch.
 *   - `autoUpdateNote`: why the last automatic round did NOT update (local changes, own
 *     commits) or what it undid (a version that did not load). Null when there is nothing
 *     to explain.
 */
import { timeAgo } from '@/utils/time'
import { capReason, scrubReason } from './plugin-update-view'

/** Mirror of the server's SourceAutoState (core/plugin-sources.ts). */
export interface SourceAutoState {
  lastUpdate?: { from?: string; to: string; at: string; by: 'auto' | 'manual' }
  rolledBack?: { sha: string; to: string; at: string; error: string; by: 'auto' | 'manual' }
  skipped?: { reason: 'dirty' | 'diverged'; at: string; behind?: number; ahead?: number }
}

export interface AutoUpdateSource {
  autoUpdate?: boolean
  auto?: SourceAutoState
}

export interface AutoUpdateNote {
  title: string
  text: string
  tone: 'warn' | 'neutral'
}

const sha7 = (sha: string): string => sha.slice(0, 7)
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** An older server sends no `autoUpdate`; it never updated by itself, so the switch is not offered. */
export function supportsAutoUpdate(source: AutoUpdateSource | undefined): boolean {
  return typeof source?.autoUpdate === 'boolean'
}

export function updatedLine(source: AutoUpdateSource | undefined, now?: number): string | undefined {
  const last = source?.auto?.lastUpdate
  if (!last) return undefined
  const when = timeAgo(last.at, { long: true, now })
  return `Updated to ${sha7(last.to)} ${when}${last.by === 'auto' ? ', by itself' : ''}`
}

const later = (a: string | undefined, b: string | undefined): boolean => !!a && (!b || a > b)

export function autoUpdateNote(source: AutoUpdateSource | undefined): AutoUpdateNote | null {
  const auto = source?.auto
  if (!auto || source?.autoUpdate === false) return null
  const skipped = auto.skipped
  if (skipped) {
    const behind = skipped.behind ? ` It is ${plural(skipped.behind, 'commit')} behind.` : ''
    if (skipped.reason === 'dirty') {
      return {
        tone: 'warn',
        title: 'Not updated automatically',
        text: `Its folder has changes of its own, and Walnut never overwrites them.${behind} Undo them, or turn automatic updates off while you work in it.`,
      }
    }
    return {
      tone: 'warn',
      title: 'Not updated automatically',
      text: `Its folder has ${plural(skipped.ahead ?? 1, 'commit')} the source does not have, and Walnut never drops them.${behind} Push or remove them, or turn automatic updates off while you work in it.`,
    }
  }
  const back = auto.rolledBack
  if (back && later(back.at, auto.lastUpdate?.at)) {
    const why = back.error ? ` (${capReason(scrubReason(back.error), 90)})` : ''
    return {
      tone: 'warn',
      title: `Went back to ${sha7(back.to)}`,
      text: `${sha7(back.sha)} did not load${why}, so Walnut put back the version that ran. It will not pull ${sha7(back.sha)} again by itself; the next commit is pulled as usual.`,
    }
  }
  return null
}
