/**
 * Runs an automation started outside Walnut, as the fixture server seeds them for
 * imported-run-status.spec.ts (2026-11-16: five such imports sat under Not started with a
 * finished session, titled "Claude session <id>").
 *
 * OLD_IMPORT is the row an older importer left: phase TODO never moved, its session in the slot,
 * the placeholder title. Its transcript opens with Walnut's own message envelope, as an
 * automation's prompt does. Its entrypoint reads as a person's ('cli'): in production the
 * automation's plugin claims its runs, and an unclaimed program's run is one the importer's audit
 * removes. NEW_RUN is a program's run (sdk-cli) that nothing imported yet: the spec imports it by
 * id. The fixture's local daemon (HOME is the fixture's) reads these files with its own scanner.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export const IMPORT_TAG = 'walnut:external-sessions'
export const IMPORT_PROJECT = 'Imported from this Mac'
export const RUN_CWD = '/work/sample-automation'
export const OLD_IMPORT = { taskId: 'pw-task-old-import', sessionId: '0a1d0001-0000-4000-8000-000000000001' }
export const NEW_RUN = { sessionId: '0a1d0002-0000-4000-8000-000000000002' }
export const OLD_TITLE = 'Investigate this sample ticket. Ticket: T100'
export const NEW_TITLE = 'Investigate this sample ticket. Ticket: T200'

export function oldImportTask(nowIso: string): Record<string, unknown> {
  return {
    id: OLD_IMPORT.taskId,
    title: `Claude session ${OLD_IMPORT.sessionId.slice(0, 8)}`,
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    project: IMPORT_PROJECT,
    source: 'local',
    tags: [IMPORT_TAG],
    cwd: RUN_CWD,
    session_ids: [OLD_IMPORT.sessionId],
    active_session_ids: [],
    session_id: OLD_IMPORT.sessionId,
    created_at: nowIso,
    updated_at: nowIso,
    description: 'Imported automatically: session started outside Walnut (sdk-cli).',
    summary: '',
    note: '',
    subtasks: [],
  }
}

export function oldImportRecord(nowIso: string): Record<string, unknown> {
  return {
    claudeSessionId: OLD_IMPORT.sessionId,
    taskId: OLD_IMPORT.taskId,
    project: IMPORT_PROJECT,
    process_status: 'stopped',
    provider: 'cli',
    startedAt: nowIso,
    lastActiveAt: nowIso,
    messageCount: 2,
    cwd: RUN_CWD,
    title: `Claude session ${OLD_IMPORT.sessionId.slice(0, 8)}`,
    human_note: 'Imported automatically: started outside Walnut (sdk-cli).',
  }
}

function transcript(sessionId: string, ticket: string, atMs: number, entrypoint: string): string {
  const prompt = '<walnut-message kind="peer-note" from="automation: sample" host="unknown" anonymous="true" '
    + 'note="from a script or scheduled job on that host: not your user">\n'
    + `Investigate this sample ticket.\n\nTicket: ${ticket}\n</walnut-message>`
  return [
    { type: 'user', uuid: `${sessionId}-u1`, parentUuid: null, sessionId, entrypoint, ...(entrypoint === 'sdk-cli' ? { promptSource: 'sdk' } : {}), cwd: RUN_CWD,
      timestamp: new Date(atMs).toISOString(), message: { role: 'user', content: prompt } },
    { type: 'assistant', uuid: `${sessionId}-a1`, parentUuid: `${sessionId}-u1`, sessionId, cwd: RUN_CWD,
      timestamp: new Date(atMs + 60_000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: `Finding for ${ticket}: the alarm is a false positive; no action needed.` }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n'
}

export async function writeImportedRunTranscripts(home: string, nowMs: number): Promise<void> {
  const dir = path.join(home, '.claude', 'projects', RUN_CWD.replace(/[^a-zA-Z0-9]/g, '-'))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${OLD_IMPORT.sessionId}.jsonl`), transcript(OLD_IMPORT.sessionId, 'T100', nowMs - 3_600_000, 'cli'))
  await fs.writeFile(path.join(dir, `${NEW_RUN.sessionId}.jsonl`), transcript(NEW_RUN.sessionId, 'T200', nowMs - 1_800_000, 'sdk-cli'))
}
