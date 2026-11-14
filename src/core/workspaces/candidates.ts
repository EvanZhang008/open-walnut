/**
 * Which providers can isolate a folder on a host: the host's verdict per provider
 * (`workspace.detect`), joined with the server's own catalog. One function for the
 * draft's provider pills (GET /api/workspaces/providers) and for the start that
 * makes a code task's workspace by default (default-isolation.ts), so both always
 * pick the same provider for the same folder.
 *
 * Never throws for a host that cannot answer: the answer degrades to the catalog
 * with every provider unclaimed and says why (`degraded`).
 */

import { WorkspaceError, workspaceRpc } from './daemon-client.js'
import { workspaceProviderCatalog } from './registry.js'
import type { WorkspaceCandidate } from './types.js'
import { role } from '../server-role.js'

export interface CandidatesAnswer {
  candidates: WorkspaceCandidate[]
  /** Why the host's verdicts are missing (no-folder, cloud, timeout, detect-failed, a WorkspaceError code). */
  degraded?: string
}

export const DETECT_BUDGET_MS = 15_000

class DetectDeadline extends Error {}

async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  work.catch(() => { /* answered by the deadline */ })
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DetectDeadline()), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The candidates, claimed ones first, then by priority (a plugin's marker beats
 * git's 10 by default). `budgetMs` is what the host may spend on plugin detect
 * steps; the whole call ends a few seconds after it.
 */
export async function workspaceCandidates(cwd: string, host: string, budgetMs = DETECT_BUDGET_MS): Promise<CandidatesAnswer> {
  const catalog = await workspaceProviderCatalog()
  const base = (reason: string): WorkspaceCandidate[] => catalog.providers.map((p) => ({
    provider: p.id, displayName: p.displayName, priority: p.priority, builtin: p.builtin,
    // A plugin provider stays pickable without the host's verdict; git needs a repository.
    claimed: false, reason, ...(p.inputSchema ? { inputSchema: p.inputSchema } : {}),
  }))
  if (!cwd || (!cwd.startsWith('/') && !cwd.startsWith('~/'))) return { candidates: base('Pick a folder first'), degraded: 'no-folder' }
  if (role() === 'replica') return { candidates: base('Isolated workspaces are made by the Walnut on your Mac'), degraded: 'cloud' }
  const deadline = budgetMs + 7_000
  let reply: Record<string, unknown>
  try {
    reply = await within(deadline, workspaceRpc(host, 'workspace.detect', { anchor: cwd, budgetMs }, deadline - 1_000))
  } catch (err) {
    const reason = err instanceof WorkspaceError ? err.message : err instanceof DetectDeadline ? 'The host took too long to look at this folder' : String(err)
    return { candidates: base(reason), degraded: err instanceof WorkspaceError ? err.code : 'timeout' }
  }
  if (!reply.ok) return { candidates: base(String(reply.error ?? 'The host could not look at this folder')), degraded: 'detect-failed' }
  const byId = new Map(catalog.providers.map((p) => [p.id, p]))
  const found = (Array.isArray(reply.candidates) ? reply.candidates : []) as Array<Record<string, unknown>>
  const candidates: WorkspaceCandidate[] = found
    .filter((c) => typeof c.provider === 'string' && byId.has(c.provider))
    .map((c) => {
      const info = byId.get(String(c.provider))!
      return {
        provider: info.id, displayName: info.displayName, priority: info.priority, builtin: info.builtin,
        claimed: c.claimed === true,
        ...(typeof c.root === 'string' ? { root: c.root } : {}),
        ...(typeof c.branch === 'string' ? { branch: c.branch } : {}),
        ...(typeof c.reason === 'string' ? { reason: c.reason } : {}),
        ...(c.inputs && typeof c.inputs === 'object' && !Array.isArray(c.inputs) ? { inputs: c.inputs as Record<string, unknown> } : {}),
        ...(info.inputSchema ? { inputSchema: info.inputSchema } : {}),
      }
    })
  // A provider the daemon did not report (an older allowlist) is still offered, unclaimed.
  for (const p of catalog.providers) {
    if (!candidates.some((c) => c.provider === p.id)) candidates.push(...base('Not checked on this host').filter((c) => c.provider === p.id))
  }
  candidates.sort((a, b) => Number(b.claimed) - Number(a.claimed) || b.priority - a.priority)
  return { candidates }
}
