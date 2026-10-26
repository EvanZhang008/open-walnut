/**
 * The turns of each `ai.run` conversation, per caller, on this machine (`local/ai/conversations/`).
 *
 * Kept for both routes: a direct call replays them, and an agent session that starts mid-way
 * (the conversation went from a plain question to one that needs tools, or its session was
 * archived) reads them once in its first message. The lane session keeps its own context after.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { HISTORY_MAX_CHARS, HISTORY_MAX_TURNS, type AiTurn } from './ai-prompt.js'
import { callerKey } from './ai-policy.js'
import type { AiCaller } from './ai-types.js'

/** Oldest conversations beyond this are forgotten. */
const MAX_CONVERSATIONS = 200

interface Conversation {
  turns: AiTurn[]
  updatedAt: string
  /** The agent lanes this conversation used (one per grant, ai-agent.ts grantedLane). */
  lanes?: string[]
}

/** One stored turn keeps at most this much, so a single huge answer never pushes out its question. */
const TURN_MAX_CHARS = Math.floor(HISTORY_MAX_CHARS / 2)
type CallerFile = Record<string, Conversation>

let dirOverride: string | null = null
const cache = new Map<string, CallerFile>()
const chains = new Map<string, Promise<unknown>>()

export function _setAiConversationsDirForTesting(dir: string | null): void {
  dirOverride = dir
  cache.clear()
}

function fileOf(caller: AiCaller): string {
  const dir = dirOverride ?? path.join(WALNUT_HOME, 'local', 'ai', 'conversations')
  return path.join(dir, `${encodeURIComponent(callerKey(caller))}.json`)
}

async function load(caller: AiCaller): Promise<CallerFile> {
  const file = fileOf(caller)
  const hit = cache.get(file)
  if (hit) return hit
  let parsed: CallerFile = {}
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) parsed = raw as CallerFile
  } catch { /* none yet */ }
  cache.set(file, parsed)
  return parsed
}

/** One writer per caller file, in order. */
function serialize<T>(caller: AiCaller, work: () => Promise<T>): Promise<T> {
  const file = fileOf(caller)
  const next = (chains.get(file) ?? Promise.resolve()).then(work, work)
  chains.set(file, next.catch(() => undefined))
  return next
}

async function persist(caller: AiCaller, data: CallerFile): Promise<void> {
  const file = fileOf(caller)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  await fs.writeFile(temp, JSON.stringify(data), 'utf-8')
  await fs.rename(temp, file)
}

export async function conversationTurns(caller: AiCaller, key: string): Promise<AiTurn[]> {
  return [...((await load(caller))[key]?.turns ?? [])]
}

export function appendTurns(caller: AiCaller, key: string, turns: AiTurn[]): Promise<void> {
  return serialize(caller, async () => {
    const data = await load(caller)
    const clipped = turns.map((turn) => turn.text.length > TURN_MAX_CHARS
      ? { ...turn, text: `${turn.text.slice(0, TURN_MAX_CHARS)}\n[cut: ${turn.text.length - TURN_MAX_CHARS} more characters]` }
      : turn)
    const all = [...(data[key]?.turns ?? []), ...clipped]
    // Stored a little past the replay bound, so a replay never runs short; never unbounded.
    let chars = 0
    let from = all.length
    while (from > 0 && all.length - from < HISTORY_MAX_TURNS * 2 && chars + all[from - 1].text.length <= HISTORY_MAX_CHARS * 2) {
      from -= 1
      chars += all[from].text.length
    }
    data[key] = { ...data[key], turns: all.slice(from), updatedAt: new Date().toISOString() }
    const keys = Object.keys(data)
    if (keys.length > MAX_CONVERSATIONS) {
      keys.sort((a, b) => data[a].updatedAt.localeCompare(data[b].updatedAt))
      for (const old of keys.slice(0, keys.length - MAX_CONVERSATIONS)) delete data[old]
    }
    await persist(caller, data)
  })
}

export function noteConversationLane(caller: AiCaller, key: string, lane: string): Promise<void> {
  return serialize(caller, async () => {
    const data = await load(caller)
    const entry = data[key] ?? { turns: [], updatedAt: new Date().toISOString() }
    if (entry.lanes?.includes(lane)) return
    data[key] = { ...entry, lanes: [...(entry.lanes ?? []), lane].slice(-20) }
    await persist(caller, data)
  })
}

export async function conversationLanes(caller: AiCaller, key: string): Promise<string[]> {
  return [...((await load(caller))[key]?.lanes ?? [])]
}

export function forgetConversation(caller: AiCaller, key: string): Promise<boolean> {
  return serialize(caller, async () => {
    const data = await load(caller)
    if (!(key in data)) return false
    delete data[key]
    await persist(caller, data)
    return true
  })
}

export async function listConversations(caller: AiCaller): Promise<Array<{ key: string; turns: number; updatedAt: string }>> {
  const data = await load(caller)
  return Object.entries(data).map(([key, c]) => ({ key, turns: c.turns.length, updatedAt: c.updatedAt }))
}
