/**
 * Fixture for session-history-archive.spec.ts: a stopped session from August
 * whose history the archive already compressed (transcript-archive.ts), so the
 * server boots with only `<sid>.jsonl.gz`, its subagent archive and the
 * manifest on disk. Opening the session must bring it back plain.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { archiveTranscripts } from '../../../src/providers/transcript-archive'

export const ARCHIVED_SESSION = 'pw-archived-session'
export const ARCHIVED_TASK = 'pw-task-archived-history'
export const ARCHIVED_TITLE = 'Archived history fixture task'
export const ARCHIVED_LAST_ANSWER = 'The header row is unchanged: order id, date, sku, quantity, unit price, total.'

export function archivedHistoryCwd(tmpBase: string): string {
  return path.join(tmpBase, 'projects', 'archived-history')
}

const TURNS: Array<[string, string]> = [
  ['The invoice export drops the last line item when an order has more than 50 items. Can you find why?',
    'The export pages through items 50 at a time and stops when a page comes back full instead of short, so the 51st item starts a page that is never read.'],
  ['Fix it and add a test for 51 and 100 items.', 'Done. The loop now stops on a short page, and the new test covers 50, 51, 100 and 101 items.'],
  ['Does the CSV header still match what finance imports?', ARCHIVED_LAST_ANSWER],
]

export async function writeArchivedHistory(tmpBase: string): Promise<void> {
  const cwd = archivedHistoryCwd(tmpBase)
  await fs.mkdir(cwd, { recursive: true })
  const dir = path.join(tmpBase, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  await fs.mkdir(path.join(dir, ARCHIVED_SESSION, 'subagents'), { recursive: true })
  const start = Date.parse('2026-08-28T17:02:00.000Z')
  let n = 0
  const rows: Record<string, unknown>[] = []
  for (const [q, a] of TURNS) {
    rows.push({ type: 'user', sessionId: ARCHIVED_SESSION, uuid: `pw-arch-${n}`, timestamp: new Date(start + (n++) * 9000).toISOString(), cwd, message: { role: 'user', content: q } })
    rows.push({ type: 'assistant', sessionId: ARCHIVED_SESSION, uuid: `pw-arch-${n}`, timestamp: new Date(start + (n++) * 9000).toISOString(), cwd,
      message: { id: `msg_pw_arch_${n}`, role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: a }], stop_reason: 'end_turn' } })
  }
  // Bulk the archive can save on: a long table in a tool result.
  rows.splice(2, 0, { type: 'user', sessionId: ARCHIVED_SESSION, uuid: 'pw-arch-tool', timestamp: new Date(start + 4000).toISOString(), cwd,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_pw_arch', content: Array.from({ length: 300 }, (_, i) => `| ${i + 1} | SKU-${10000 + i * 7} | ${1 + (i % 5)} |`).join('\n') }] } })
  const main = path.join(dir, `${ARCHIVED_SESSION}.jsonl`)
  await fs.writeFile(main, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  await fs.writeFile(path.join(dir, ARCHIVED_SESSION, 'subagents', 'agent-pw1.jsonl'),
    Array.from({ length: 120 }, (_, i) => JSON.stringify({ type: 'assistant', sessionId: ARCHIVED_SESSION, uuid: `pw-sub-${i}`, message: { role: 'assistant', content: [{ type: 'text', text: `checked page ${i} ${'.'.repeat(80)}` }] } })).join('\n') + '\n')
  const old = start / 1000 + 60
  await fs.utimes(main, old, old)
  // A file's ctime cannot be set back, so the archive runs "61 days from now".
  const r = await archiveTranscripts([path.join(tmpBase, '.claude', 'projects')], { olderThanMs: 60 * 86_400_000, now: Date.now() + 61 * 86_400_000, isLive: (sid) => sid !== ARCHIVED_SESSION })
  if (r.sessions !== 1) throw new Error(`archived history fixture: expected one archived session, got ${JSON.stringify(r)}`)
}

export function archivedHistoryTask(nowIso: string): Record<string, unknown> {
  return {
    id: ARCHIVED_TASK, title: ARCHIVED_TITLE, status: 'in_progress', phase: 'IN_PROGRESS', priority: 'none', project: 'Walnut', source: 'local',
    session_ids: [ARCHIVED_SESSION], active_session_ids: [], session_id: ARCHIVED_SESSION,
    session_status: { process_status: 'stopped', mode: 'bypass' },
    created_at: nowIso, updated_at: nowIso, description: '', summary: '', note: '', subtasks: [],
  }
}

export function archivedHistoryRecord(tmpBase: string): Record<string, unknown> {
  return {
    claudeSessionId: ARCHIVED_SESSION, taskId: ARCHIVED_TASK, project: 'Walnut', process_status: 'stopped', mode: 'bypass',
    last_status_change: '2026-08-28T17:03:00.000Z', startedAt: '2026-08-28T17:02:00.000Z', lastActiveAt: '2026-08-28T17:03:00.000Z',
    messageCount: 6, cwd: archivedHistoryCwd(tmpBase), title: 'Archived history fixture session',
  }
}
