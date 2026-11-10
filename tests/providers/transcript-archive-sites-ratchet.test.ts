/**
 * Every place that finds, lists or opens a Claude Code transcript must still
 * work once old sessions are archived (`<sid>.jsonl.gz`, src/providers/transcript-archive.ts).
 * The files are found from the source (the name patterns and the path helpers
 * below); each is listed with how it copes. A new file that touches
 * transcripts fails here until it is listed, so the archive never silently
 * hides a session from a reader nobody thought of.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

/** How each file copes with an archived session. */
const SITES: Record<string, string> = {
  // Restore at the point of reading.
  'src/providers/daemon-standalone.ts': 'restores: fs.read/readRange/readBounded/stat/ls/find and a resume restore first (restoreForRead, plainFindResults, restoreSessionAnywhere)',
  'src/providers/daemon-source.ts': 'restores: the same, through the task-dir-core.cjs sidecar',
  'src/providers/transcript-archive.ts': 'the archive itself',
  'src/core/session-file-reader.ts': 'restores: findLocalJsonlPath restores a session archived on this machine; every other read goes through the daemon file commands',
  'src/providers/session-changes-core.ts': 'restores: resolveJsonlPathHostLocal restores on a miss (changes, rewind, path resolution)',
  'src/core/session-jsonl-migration.ts': 'restores before it moves a transcript to a new cwd',
  'src/core/stream-retention.ts': 'counts an archived transcript as the copy that makes a stream capture recoverable',
  'src/core/sessions/adopt-search-session.ts': 'counts an archived transcript as present (a resume restores it)',
  // Read through the daemon file commands, which restore.
  'src/core/daemon-file-reader.ts': 'daemon fs.* (restores)',
  'src/core/session-changes.ts': 'daemon fs.* (restores)',
  'src/core/history-anchor-reach.ts': 'daemon fs.* (restores)',
  'src/core/session-history.ts': 'daemon fs.* (restores)',
  'src/core/sessions/engine-switch-context.ts': 'daemon fs.* (restores)',
  'src/core/sessions/folder-gone.ts': 'findLocalJsonlPath / fs.find (both restore)',
  'src/core/sessions/session-extras.ts': 'findLocalJsonlPath (restores)',
  'src/core/sessions/session-lifecycle.ts': 'findLocalJsonlPath / fs.find (both restore)',
  'src/core/sessions/session-record-recovery.ts': 'daemon fs.* (restores)',
  'src/core/session-health-monitor.ts': 'findLocalJsonlPath (restores); reads live sessions only',
  'src/core/transfer/daemon-transfer-client.ts': 'fs.find (restores)',
  'src/core/transfer/transfer.ts': 'fs.find / fs.readRange (restore)',
  'src/providers/claude-code-session.ts': 'probeSessionPath is fs.stat / fs.find (restore); the rest reads live sessions',
  'src/utils/plan-message.ts': 'readSessionJsonlContent, daemon fs.* (restores)',
  'src/providers/path-resolve-core.ts': 'resolveJsonlPathHostLocal (restores)',
  'src/providers/transcript-rewind-core.ts': 'resolveJsonlPathHostLocal (restores)',
  'src/core/team-reader.ts': 'reads a session the history read already restored (the panel opens history first)',
  // Live sessions only: never older than the archive age.
  'src/providers/stream-fold-core.ts': 'live or resuming sessions; a resume restores before the fold reads the transcript',
  'src/providers/daemon-cron-host.ts': 'a session with an armed cron, which expires after 7 days',
  'src/providers/follower-reads-core.ts': 'a gate on the plain path; the read behind it restores',
  'src/utils/session-liveness.ts': 'stream captures of live sessions',
  // Usage and cost: the archive starts on a host only after its whole history was read once.
  'src/providers/usage-scan-core.ts': 'usage: archived sessions are older than every incremental window; the sweep waits for the first full read',
  'src/providers/usage-scan-index.ts': 'usage: as usage-scan-core',
  'src/providers/session-cost-core.ts': 'a session cost of an archived session reads after the history read restored it',
  'src/providers/claude-outside-core.ts': 'usage of sessions Walnut did not start: read in full before any archive',
  'src/providers/external-session-scan-core.ts': 'import lists only recent sessions; an archived one is older than its window',
  // Not Claude Code transcripts.
  'src/core/health-monitor/store.ts': 'not a transcript (health log)',
  'src/core/observability/bundle.ts': 'not a transcript (stream capture tail, debug log)',
  'src/core/session-reaper.ts': 'not a transcript (session archive log, stream captures)',
  'src/core/session-reconcile.ts': 'not a transcript (stream captures)',
  'src/core/time-tracking/calls-store.ts': 'not a transcript',
  'src/core/time-tracking/detail-store.ts': 'not a transcript',
  'src/core/time-tracking/outside-store.ts': 'not a transcript',
  'src/core/time-tracking/screentime-store.ts': 'not a transcript',
  'src/core/time-tracking/store.ts': 'not a transcript',
  'src/core/time-tracking/store-read.ts': 'not a transcript',
  'src/providers/transfer-core.ts': 'writes a transferred transcript into its own transfer folder; the sending side reads it through fs.find (restores)',
  'src/web/routes/time.ts': 'not a transcript',
  'src/providers/codex-outside-core.ts': 'Codex sessions, not Claude Code',
  'src/providers/ephemeral-session-gate.ts': 'argument gate, no file access',
  'src/providers/host-vitals-core.ts': 'not a transcript (vitals log)',
  'src/providers/session-io.ts': 'not a transcript (stream captures)',
  'src/providers/stream-compact-core.ts': 'not a transcript (stream captures)',
  'src/providers/usage-budget-store.ts': 'not a transcript (budget journals)',
}

const NAME_PATTERN = /endsWith\(['"]\.jsonl['"]\)|\}\.jsonl`|\.jsonl\$\/|'\.jsonl'/
const HELPER_PATTERN = /canonicalJsonlPath\(|findLocalJsonlPath\(|findSessionJsonlPath\(|resolveJsonlPathHostLocal\(|findSessionPath\(|remoteJsonlPath\(|probeSessionPath\(|findTranscript\(/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

describe('transcript archive: every transcript site is listed', () => {
  const found = sourceFiles(path.join(ROOT, 'src'))
    .filter((p) => { const s = fs.readFileSync(p, 'utf8'); return NAME_PATTERN.test(s) || HELPER_PATTERN.test(s) })
    .map((p) => path.relative(ROOT, p).split(path.sep).join('/'))

  it('a file that touches transcripts says how it copes with an archived session', () => {
    expect(found.filter((f) => !(f in SITES))).toEqual([])
  })

  it('every listed file still exists and still touches transcripts', () => {
    expect(Object.keys(SITES).filter((f) => !found.includes(f))).toEqual([])
  })

  it('the restoring sites really call the archive', () => {
    const calls: Record<string, RegExp> = {
      'src/providers/daemon-standalone.ts': /restoreForRead\(filePath, CLAUDE_PROJECTS_DIRS\)[\s\S]*plainFindResults\(found, name\)[\s\S]*restoreSessionAnywhere\(CLAUDE_PROJECTS_DIRS, ownedSid\)|restoreSessionAnywhere\(CLAUDE_PROJECTS_DIRS, ownedSid\)[\s\S]*restoreForRead\(filePath, CLAUDE_PROJECTS_DIRS\)/,
      'src/providers/daemon-source.ts': /transcriptRestoreForRead\(filePath\)[\s\S]*transcriptPlainFind\(found, name\)/,
      'src/core/session-file-reader.ts': /restoreArchivedAt\(/,
      'src/providers/session-changes-core.ts': /restoreArchivedAt\(/,
      'src/core/session-jsonl-migration.ts': /restoreArchivedAt\(/,
      'src/core/stream-retention.ts': /transcriptSessionId\(/,
    }
    for (const [file, re] of Object.entries(calls)) expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).toMatch(re)
    // Both twins restore in each file command.
    for (const fn of ['cmdFsRead', 'cmdFsStat', 'cmdFsReadRange', 'cmdFsLs', 'cmdFsReadBounded']) {
      const sa = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')
      const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf8')
      const body = (s: string) => s.slice(s.indexOf(`async function ${fn}(`), s.indexOf('\n}\n', s.indexOf(`async function ${fn}(`)))
      expect(body(sa), `standalone ${fn}`).toMatch(/await restoreForRead\(/)
      expect(body(src), `source ${fn}`).toMatch(/await transcriptRestoreForRead\(/)
    }
  })
})
