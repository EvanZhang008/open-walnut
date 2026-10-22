/**
 * The `personas` copy kind (docs/plan/walnut-replica-servers-impl.md, section 4 and
 * WP12): the Ask persona of each console agent as this Mac renders it
 * (personal-ai-lane.ts buildLaneProfile), WITHOUT the walnut MCP mount (the host's
 * daemon composes its own from the host-server spec), with the lane effort and the
 * model and effort the user last picked for an ask (ask-walnut-launch.ts). On each
 * host replica in `cache/replica/personas.json` (file-copy.ts, one file at 0600 in a
 * 0700 dir; the plan's per-agent files follow the file-copy pattern instead). The
 * replica reads it to start a new ask on the host while the Mac is away; a missing row
 * answers `needs_leader {why:'persona_not_copied'}`.
 *
 * A prompt carries standing memory and the skills index: the host checks every text
 * for a secret shape before it writes the row (admit), as the config copy does, and a
 * refused row is not stored (the ask then needs the Mac). Unordered, no digest, floor 0.
 */

import { log } from '../../../logging/index.js'
import { secretShapedValue } from '../config-allowlist.js'
import { sha12 } from '../kind.js'
import type { CopyKind } from './copy-kind.js'
import { createFileCopy } from './file-copy.js'

export const PERSONAS_SCHEMA_VERSION = 1
export const PERSONAS_REMOVAL_FLOOR = 0
/** A persona over this is not copied: the host's argv path caps the whole string at 120 KB. */
const MAX_PROMPT_BYTES = 120 * 1024
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const TOOL_RE = /^[A-Za-z0-9_.:*()/ -]{1,200}$/

export interface PersonaRow {
  key: string
  agentId: string
  name: string
  systemPrompt: string
  systemPromptMode: 'append' | 'replace'
  allowedTools?: string[]
  tools?: string[]
  /** The lane effort (config agent.session_effort, else medium). */
  effort?: string
  /** What the user last picked for an ask (ask-walnut-launch.ts). */
  launchModel?: string
  launchEffort?: string
}

function tools(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.length > 0 && v.every((t) => typeof t === 'string' && TOOL_RE.test(t)) ? [...v] as string[] : undefined
}

async function leaderRows(): Promise<PersonaRow[]> {
  const [{ getConsoleAgents }, { buildLaneProfile }, { getConfig }, { getAskWalnutLaunchPrefs }] = await Promise.all([
    import('../../agent-registry.js'), import('../../sessions/personal-ai-lane.js'), import('../../config-manager.js'),
    import('../../sessions/ask-walnut-launch.js'),
  ])
  const config = await getConfig()
  const launch = await getAskWalnutLaunchPrefs().catch(() => ({} as { model?: string; effort?: string }))
  const agents = [{ id: 'general', name: 'Walnut' }, ...(await getConsoleAgents()).filter((a) => a.id !== 'general').map((a) => ({ id: a.id, name: a.name }))]
  const rows: PersonaRow[] = []
  for (const a of agents) {
    if (!ID_RE.test(a.id)) continue
    try {
      const { profile, effort } = await buildLaneProfile(config, a.id)
      const prompt = profile.systemPrompt ?? ''
      if (!prompt || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) continue
      rows.push({
        key: a.id, agentId: a.id, name: String(a.name ?? a.id).slice(0, 120),
        systemPrompt: prompt, systemPromptMode: profile.systemPromptMode === 'replace' ? 'replace' : 'append',
        ...(tools(profile.allowedTools) ? { allowedTools: tools(profile.allowedTools) } : {}),
        ...(tools(profile.tools) ? { tools: tools(profile.tools) } : {}),
        ...(effort ? { effort } : {}),
        ...(launch.model ? { launchModel: launch.model } : {}), ...(launch.effort ? { launchEffort: launch.effort } : {}),
      })
    } catch (err) {
      log.session.warn('copies: an agent persona was not rendered for the host', { agentId: a.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return rows
}

const hashes = new WeakMap<object, string>()
function hashOf(row: PersonaRow): string {
  let h = hashes.get(row)
  if (h === undefined) {
    h = sha12(JSON.stringify(row))
    hashes.set(row, h)
  }
  return h
}

export const PERSONAS_KIND: CopyKind<PersonaRow> = {
  kind: 'personas',
  schemaVersion: PERSONAS_SCHEMA_VERSION,
  key: (r) => r.key,
  hash: hashOf,
  ordered: false,
  digest: false,
  choice: 'personas',
  rows: leaderRows,
  watch: (soon) => {
    const stops: Array<() => void> = []
    let stopped = false
    // The config renders the personas; the Ask Walnut launch memory rides on every row.
    void Promise.all([import('../../config-manager.js'), import('../../sessions/ask-walnut-launch.js')]).then(([cm, launch]) => {
      if (!stopped) stops.push(cm.onConfigWritten(soon), launch.onAskWalnutLaunchWritten(soon))
    })
    return () => { stopped = true; for (const s of stops) s() }
  },
}

// --- Follower ---

const ROW_KEYS = new Set(['key', 'agentId', 'name', 'systemPrompt', 'systemPromptMode', 'allowedTools', 'tools', 'effort', 'launchModel', 'launchEffort'])

function isRow(v: unknown): v is PersonaRow {
  const r = v as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false
  if (Object.keys(r).some((k) => !ROW_KEYS.has(k))) return false
  if (typeof r.key !== 'string' || r.key !== r.agentId || !ID_RE.test(r.key) || typeof r.name !== 'string') return false
  if (typeof r.systemPrompt !== 'string' || !r.systemPrompt || Buffer.byteLength(r.systemPrompt, 'utf8') > MAX_PROMPT_BYTES) return false
  if (r.systemPromptMode !== 'append' && r.systemPromptMode !== 'replace') return false
  for (const k of ['allowedTools', 'tools']) if (r[k] !== undefined && !tools(r[k])) return false
  for (const k of ['effort', 'launchModel', 'launchEffort']) if (r[k] !== undefined && (typeof r[k] !== 'string' || !/^[A-Za-z0-9._:[\]/-]{1,128}$/.test(r[k] as string))) return false
  return true
}

/** The host's own check: a persona whose text looks like it holds a secret is not stored. */
function admit(r: PersonaRow): boolean {
  return secretShapedValue(r.systemPrompt) === null && secretShapedValue(r.name) === null
}

const copy = createFileCopy<PersonaRow>({
  kind: 'personas',
  schemaVersion: PERSONAS_SCHEMA_VERSION,
  label: 'personas copy',
  removalFloor: PERSONAS_REMOVAL_FLOOR,
  isRow,
  key: (r) => r.key,
  admit,
})

export const personasFollower = copy.follower

/** The copied persona of an agent, or null (never copied, turned off, or refused). */
export async function readPersonaCopy(agentId: string): Promise<PersonaRow | null> {
  const rows = await copy.read()
  return rows?.[agentId] ?? null
}

/** Tests only. */
export function _resetPersonasCopyForTesting(): void {
  copy.reset()
}
