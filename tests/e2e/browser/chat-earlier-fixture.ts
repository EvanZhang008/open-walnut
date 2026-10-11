/**
 * Fixture for ask-chat-earlier.spec.ts: two phone chats whose history began before
 * the lane session an ask opens on (GET /api/v1/sessions/:id/chat-earlier).
 *
 *  - OLD chat: its whole history is in chat history, and its only lane session is
 *    a warm one opened weeks later, with no transcript. The Mac showed a blank page.
 *  - CONTINUED chat: chat history first, then a lane session with one turn of its
 *    own. The earlier part goes above that turn, never after it.
 *
 * Lane sessions are not listed anywhere (isListableSession) and no ask task is
 * seeded (the spec adds the asks to its own page), so no other spec sees these.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export const EARLIER_OLD_SESSION = 'pw-chat-earlier-old'
export const EARLIER_OLD_CONV = 'conv-pw-chat-earlier-old'
export const EARLIER_CONT_SESSION = 'pw-chat-earlier-cont'
export const EARLIER_CONT_CONV = 'conv-pw-chat-earlier-cont'
/** Long enough that the block pages ("Show N earlier messages"). */
export const EARLIER_OLD_TURNS = 30

const DAY = 24 * 60 * 60 * 1000

export function earlierOldQuestion(i: number): string { return `Old phone question ${i}` }
export function earlierOldAnswer(i: number): string { return `Old phone answer ${i}, with **bold** text` }

/** The two lane session records, in sessions.json shape. */
export function chatEarlierSessionRecords(now: number, cwd: string): Array<Record<string, unknown>> {
  const base = { taskId: '', project: '', process_status: 'stopped', mode: 'bypass', messageCount: 2, cwd }
  return [
    {
      ...base, claudeSessionId: EARLIER_OLD_SESSION, lane: `chat:general:${EARLIER_OLD_CONV}`,
      title: 'Chat earlier: old chat', startedAt: new Date(now - DAY).toISOString(),
      lastActiveAt: new Date(now - DAY).toISOString(), last_status_change: new Date(now - DAY).toISOString(),
    },
    {
      ...base, claudeSessionId: EARLIER_CONT_SESSION, lane: `chat:general:${EARLIER_CONT_CONV}`,
      title: 'Chat earlier: continued chat', startedAt: new Date(now - 2 * DAY).toISOString(),
      lastActiveAt: new Date(now - 2 * DAY).toISOString(), last_status_change: new Date(now - 2 * DAY).toISOString(),
    },
  ]
}

/** Chat-history files, and the continued chat's one-turn transcript. */
export async function writeChatEarlierFiles(home: string, now: number, cwd: string): Promise<void> {
  const dir = path.join(home, 'conversations', 'general')
  await fs.mkdir(dir, { recursive: true })
  const store = (entries: unknown[]) => JSON.stringify({
    version: 2, lastUpdated: new Date(now).toISOString(), compactionCount: 0, compactionSummary: null, entries,
  })
  const user = (text: string, at: number) => ({ tag: 'ai', role: 'user', content: text, displayText: text, timestamp: new Date(at).toISOString() })
  const asst = (text: string, at: number) => ({ tag: 'ai', role: 'assistant', content: [{ type: 'text', text }], timestamp: new Date(at).toISOString() })

  const oldStart = now - 30 * DAY
  const old: unknown[] = []
  for (let i = 1; i <= EARLIER_OLD_TURNS; i++) {
    old.push(user(earlierOldQuestion(i), oldStart + i * 60_000))
    old.push(asst(earlierOldAnswer(i), oldStart + i * 60_000 + 20_000))
  }
  await fs.writeFile(path.join(dir, `${EARLIER_OLD_CONV}.json`), store(old))

  const contStart = now - 10 * DAY
  await fs.writeFile(path.join(dir, `${EARLIER_CONT_CONV}.json`), store([
    user('Which plants like shade?', contStart),
    asst('Ferns, hostas and hellebores.', contStart + 30_000),
  ]))

  const projectDir = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  await fs.mkdir(projectDir, { recursive: true })
  const turnAt = now - 2 * DAY + 5_000
  await fs.writeFile(path.join(projectDir, `${EARLIER_CONT_SESSION}.jsonl`), [
    { type: 'user', uuid: '6f1d1c52-0000-4000-8000-000000000001', timestamp: new Date(turnAt).toISOString(), message: { role: 'user', content: 'And which of them flower?' } },
    { type: 'assistant', uuid: '6f1d1c52-0000-4000-8000-000000000002', timestamp: new Date(turnAt + 8_000).toISOString(), message: { role: 'assistant', id: 'msg-pw-chat-earlier-1', content: [{ type: 'text', text: 'Hellebores flower in late winter.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
}
