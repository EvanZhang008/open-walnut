/**
 * The mail bridge's own bookkeeping, one JSON file beside the topics (never inside `topics/`,
 * whose every file is a topic): the inbound mails already posted (so a reply is never posted
 * twice, across restarts too), the Message-IDs it sent (so a reply that only carries
 * In-Reply-To finds its topic), a send still waiting per person, failure counts, and which
 * one-time `walnut` lines were already said.
 *
 * Loaded once, then held in memory; every change is written atomically (tmp + rename) on one chain.
 */
import fs from 'node:fs/promises'
import { writeJsonFile } from '../../utils/fs.js'

/** Inbound mail keys kept for the duplicate check. */
export const SEEN_CAP = 5_000
/** Sent Message-IDs kept for In-Reply-To matching. */
export const SENT_CAP = 2_000

export interface TopicMailMemberState {
  /** A send that has not settled yet (a letter waits for the user, or the attempt runs). */
  pending?: { draftId: string; upto: string; at: string }
  /** Failed attempts in a row; reset by a send that goes out. */
  failures?: number
  /** The 3-failure line was posted for this streak. */
  failureLine?: boolean
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
        await writeJsonFile(file, state)
        return result
      })
      chain = run.catch(() => undefined)
      return run
    },
  }
}
