/**
 * The mail bridge's own bookkeeping, one JSON file beside the topics (never inside `topics/`,
 * whose every file is a topic): the inbound mails already posted (so a reply is never posted
 * twice, across restarts too), the Message-IDs it sent (so a reply that only carries
 * In-Reply-To finds its topic), a send still waiting per person, failure counts, and which
 * one-time `walnut` lines were already said, and the mails each person got this round.
 *
 * Loaded once, then held in memory; every change is written atomically (tmp + rename) on one chain.
 * Kept small: the inbound keys and sent ids are capped, and what belongs to a topic that is gone or
 * closed over a week is dropped (prunedState, at each pass).
 */
import fs from 'node:fs/promises'
import { writeJsonFile } from '../../utils/fs.js'

/** Inbound mail keys kept for the duplicate check. */
export const SEEN_CAP = 5_000
/** Sent Message-IDs kept for In-Reply-To matching. */
export const SENT_CAP = 2_000
/** One-time line keys kept (a backstop: pruning by topic keeps far fewer). */
export const LINES_CAP = 5_000
/** A closed topic's bookkeeping is kept this long after it closed. */
export const CLOSED_KEEP_MS = 7 * 24 * 3600_000

export interface TopicMailMemberState {
  /** A send that has not settled yet (a letter waits for the user, or the attempt runs). */
  pending?: { draftId: string; upto: string; at: string }
  /** Failed attempts in a row; reset by a send that goes out. */
  failures?: number
  /** The 3-failure line was posted for this streak. */
  failureLine?: boolean
  /** The topic round `roundMails` counts in (topics-model.ts TopicRound.n). */
  round?: number
  /** Mails this person got in that round that carried none of the user's own lines. */
  roundMails?: number
  /** The round whose "no more mail this round" line was already posted. */
  budgetTold?: number
}

export interface TopicMailStateFile {
  version: 1
  seen: string[]
  sent: Array<{ id: string; topicId: string; memberId: string }>
  members: Record<string, TopicMailMemberState>
  lines: string[]
}

const empty = (): TopicMailStateFile => ({ version: 1, seen: [], sent: [], members: {}, lines: [] })

export function memberKey(topicId: string, memberId: string): string {
  return `${topicId}/${memberId}`
}

/** A one-time line's key: it starts with its topic's id, so a topic's lines go with the topic. */
export function lineKey(topicId: string, what: string): string {
  return `${topicId}|${what}`
}

const topicOfKey = (key: string): string => key.split(/[/|]/, 1)[0] ?? ''

/**
 * Drop what belongs to topics that are gone (not in `topics`) or closed over CLOSED_KEEP_MS ago:
 * their members' entries and their one-time lines. Mutates; returns whether anything was dropped.
 * `topics`: every topic listed now, with when it closed. A topic Walnut could not read is listed
 * (never dropped for a read that failed).
 */
export function pruneState(state: TopicMailStateFile, topics: ReadonlyMap<string, { closedAt?: string }>, now: number): boolean {
  const keep = (topicId: string): boolean => {
    const t = topics.get(topicId)
    if (!t) return false
    const closed = Date.parse(t.closedAt ?? '')
    return !(Number.isFinite(closed) && now - closed > CLOSED_KEEP_MS)
  }
  let dropped = false
  for (const key of Object.keys(state.members)) {
    if (keep(topicOfKey(key))) continue
    delete state.members[key]
    dropped = true
  }
  const lines = state.lines.filter((key) => keep(topicOfKey(key)))
  if (lines.length !== state.lines.length) { state.lines = lines; dropped = true }
  return dropped
}

export interface TopicMailState {
  read(): Promise<TopicMailStateFile>
  /** Change the state and write it; changes run one after another. */
  update<T>(change: (state: TopicMailStateFile) => T): Promise<T>
}

export function createTopicMailState(file: string): TopicMailState {
  let loaded: Promise<TopicMailStateFile> | null = null
  let chain: Promise<unknown> = Promise.resolve()

  const load = (): Promise<TopicMailStateFile> => {
    loaded ??= fs.readFile(file, 'utf-8').then((raw) => {
      const parsed = JSON.parse(raw) as Partial<TopicMailStateFile>
      return {
        version: 1 as const,
        seen: Array.isArray(parsed.seen) ? parsed.seen.filter((one) => typeof one === 'string') : [],
        sent: Array.isArray(parsed.sent) ? parsed.sent.filter((one) => one && typeof one.id === 'string') : [],
        members: parsed.members && typeof parsed.members === 'object' ? parsed.members : {},
        lines: Array.isArray(parsed.lines) ? parsed.lines.filter((one) => typeof one === 'string') : [],
      }
    }).catch(() => empty())
    return loaded
  }

  return {
    read: load,
    update<T>(change: (state: TopicMailStateFile) => T): Promise<T> {
      const run = chain.then(async () => {
        const state = await load()
        const result = change(state)
        if (state.seen.length > SEEN_CAP) state.seen.splice(0, state.seen.length - SEEN_CAP)
        if (state.sent.length > SENT_CAP) state.sent.splice(0, state.sent.length - SENT_CAP)
        if (state.lines.length > LINES_CAP) state.lines.splice(0, state.lines.length - LINES_CAP)
        await writeJsonFile(file, state)
        return result
      })
      chain = run.catch(() => undefined)
      return run
    },
  }
}
