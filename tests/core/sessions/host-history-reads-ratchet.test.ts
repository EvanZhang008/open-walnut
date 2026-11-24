/**
 * Every place the server reads and parses a session's transcript is accounted for, so a session
 * its host runs and judges is parsed on its host only (src/core/sessions/host-history-reads.ts;
 * docs/plan/one-service-every-host.md, phase 2, Done-when 2).
 *
 *   1. Each `history` member of HOST_CALL_ALLOWLIST (past its paging and cancel) is a reader that starts with viaJudgingHost
 *      under its own name, in the file named here.
 *   2. Each exported reader of session-history.ts that takes a host is one of those members, or is
 *      listed below with why it parses nothing of another host here.
 *   3. Each file of src/ that fetches a transcript's text or parses its lines (the primitives
 *      below) is listed with its class. A new one fails until it is routed or classified.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { HOST_CALL_ALLOWLIST, HOST_HISTORY_WIRE, type HostHistoryRead } from '../../../src/core/session-channel/host-calls.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Where each routed reader lives. */
const MEMBER_FILES: Record<HostHistoryRead, string> = {
  readSessionHistory: 'src/core/session-history.ts',
  readSessionHistoryTail: 'src/core/session-history.ts',
  readSessionHistoryTailWindow: 'src/core/session-history.ts',
  readSessionHistoryRange: 'src/core/session-history.ts',
  readSessionRowToolResult: 'src/core/session-history.ts',
  extractPlanContent: 'src/core/session-history.ts',
  readSingleSubagentHistory: 'src/core/session-history.ts',
  reconstructWorkflowProgress: 'src/core/session-history.ts',
  readHistoryReachingAnchor: 'src/core/history-anchor-reach.ts',
  readAcpSessionHistoryState: 'src/providers/acp-session-history.ts',
  readSessionBody: 'src/core/search/build.ts',
  readPlanFromSession: 'src/utils/plan-message.ts',
  readActiveContext: 'src/core/sessions/engine-switch-context.ts',
}

/** Exported functions of session-history.ts that take a host and are not routed, with why. */
const NOT_READERS: Record<string, string> = {
  invalidateSessionHistoryCaches: 'drops this server\'s caches; reads nothing',
  getCachedSessionHistory: 'this server\'s in-memory copy; reads nothing',
  _historyCacheSetForTesting: 'test seam',
  _historyCacheGetForTesting: 'test seam',
  recoverStateFromJsonl: 'no caller in src/ (checked below): only tests read through it',
  readSessionHistoryPaginated: 'composes readSessionHistory, which is routed',
  rewriteHistoryRemoteImages: 'mirrors image files a row names (daemon file reads); parses no transcript line',
}

type Cls =
  | 'routed'        // the parse runs inside a routed reader (a member above) or its helpers only
  | 'host-side'     // runs on the session's host: its daemon or its own service, never the leader
  | 'old-daemon'    // a fallback for a daemon without its host-local command; a judging host's daemon has it
  | 'daemon-first'  // the daemon computes it on the host first; the leader's reader is the fallback for a daemon without the capability
  | 'definition'    // where the primitive is defined
  | 'legacy-only'   // runs only for sessions this server runs itself (judged here)

/** Every file of src/ that calls a primitive, and why that is no leader parse of a host-judged session. */
const FILES: Record<string, { cls: Cls; why: string }> = {
  'src/core/session-history.ts': { cls: 'routed', why: 'every reader that takes a host is routed or listed in NOT_READERS' },
  'src/core/history-parse.ts': { cls: 'definition', why: 'the parser; counts every parse through its noteLinesParsed hook' },
  'src/core/session-file-reader.ts': { cls: 'definition', why: 'the transcript fetches; called by the readers classified here' },
  'src/core/history-anchor-reach.ts': { cls: 'routed', why: 'readHistoryReachingAnchor is a member' },
  'src/core/sessions/engine-switch-context.ts': { cls: 'routed', why: 'readActiveContext is a member; readClaudeChain runs only inside it' },
  'src/providers/acp-session-history.ts': { cls: 'routed', why: 'readAcpSessionHistoryState is a member; the journal parses run inside it' },
  'src/utils/plan-message.ts': { cls: 'routed', why: 'readPlanFromSession is a member' },
  'src/providers/history-ready-core.ts': { cls: 'host-side', why: 'the daemon\'s history.readyView: parsed on the host, rows sent' },
  'src/replica/host-history.ts': { cls: 'host-side', why: 'a host replica reading its own stream file while the Mac is away' },
  'src/core/session-changes.ts': { cls: 'daemon-first', why: 'changes.compute runs on the host\'s daemon (changes-v1); the reader path is its fallback (file changes: phase 3 scope)' },
  'src/core/sessions/session-rewind.ts': { cls: 'old-daemon', why: 'the raw read only when transcript.rewindProbe is missing; a rewind of a host-judged session is a lifecycle control (Done-when 1, gap b10)' },
  'src/providers/claude-code-session.ts': { cls: 'legacy-only', why: 'the runner of a session this server runs; a host-judged session has no ClaudeCodeSession here' },
}

/** Fetch a transcript's text, or parse its lines. */
const PRIMITIVE = /\b(parseSessionMessages|parseHistoryWindowText|parseAcpJournal|parseJournalLine|readSessionJsonlContent|readSubagentContents|readSingleSubagentContent|readWorkflowSubagentContent|readWorkflowManifest|readTranscriptBytes)\(/

function srcFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...srcFiles(rel))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

/** The source with comments taken out, so a mention in a comment is no call. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

describe('every transcript read of a host-judged session runs on its host', () => {
  it('each history member is a reader that starts with viaJudgingHost under its own name', () => {
    const readers = HOST_CALL_ALLOWLIST.history.filter((m) => !(HOST_HISTORY_WIRE as readonly string[]).includes(m))
    expect(Object.keys(MEMBER_FILES).sort()).toEqual([...readers].sort())
    for (const [member, file] of Object.entries(MEMBER_FILES)) {
      const text = code(read(file))
      expect(text, `${file} defines ${member}`).toMatch(new RegExp(`export (async )?function ${member}\\b`))
      expect(text, `${member} in ${file} goes through viaJudgingHost`).toMatch(new RegExp(`viaJudgingHost\\([^;]*?'${member}'`))
    }
  })

  it('each exported reader of session-history.ts that takes a host is routed or says why not', () => {
    const text = read('src/core/session-history.ts')
    const takesHost: string[] = []
    for (const m of text.matchAll(/export (?:async )?function (\w+)\s*(?:<[^>]*>)?\(([\s\S]*?)\)\s*:/g)) {
      if (/\bhost\b/.test(m[2]!)) takesHost.push(m[1]!)
    }
    const routed = new Set(Object.entries(MEMBER_FILES).filter(([, f]) => f === 'src/core/session-history.ts').map(([m]) => m))
    const unclassified = takesHost.filter((n) => !routed.has(n) && !Object.hasOwn(NOT_READERS, n))
    expect(unclassified, 'a new reader of a host\'s transcript: route it (host-history-reads.ts) or list it in NOT_READERS').toEqual([])
    for (const n of Object.keys(NOT_READERS)) expect(takesHost, `${n} is still exported and takes a host`).toContain(n)
  })

  it('recoverStateFromJsonl has no caller in src/', () => {
    const callers = srcFiles('src').filter((f) => f !== 'src/core/session-history.ts' && /\brecoverStateFromJsonl\(/.test(code(read(f))))
    expect(callers).toEqual([])
  })

  it('each file that fetches or parses a transcript is classified', () => {
    const hits = srcFiles('src').filter((f) => PRIMITIVE.test(code(read(f)))).sort()
    const unclassified = hits.filter((f) => !Object.hasOwn(FILES, f))
    expect(unclassified, 'a new transcript reader: route it through viaJudgingHost (host-history-reads.ts) or classify it here').toEqual([])
    const stale = Object.keys(FILES).filter((f) => !hits.includes(f))
    expect(stale, 'classified files that no longer read a transcript: take them out').toEqual([])
  })
})
