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
import { ENGINE_REGISTRY } from '../../../src/core/agents/engine-registry.js'

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

/**
 * ACP engines keep their history in a journal (historySource 'acp-journal'), not a transcript:
 * the same rule holds for it. Every branch of src/ for those engines either reads the history
 * through the routed reader (readAcpSessionHistoryState, a member above, so a host-judged session
 * is read by its host) or reads nothing; and the journal's own primitives run only inside that
 * reader. The host's side of the read (its follower link) must let the journal through:
 * tests/providers/follower-reads-core.test.ts gates the names this reader derives.
 *
 * A direct read needs the journal's name: the `.acp.jsonl` suffix or the record's acpJournalPath
 * (or a primitive below). Each file that names it is classified with its count, so a new direct
 * read, in a new file or a classified one, fails here. A branch on an ACP engine by its id
 * (`engine === 'codex'`) or by `case 'acp-journal'` counts as an ACP branch too. isAcpEngine()
 * is left out: about 50 files ask it for process and routing work, and none of them can read a
 * journal without its name, which the count catches.
 */
const ACP_ROUTED = /\b(readAcpSessionHistory|readAcpSessionHistoryState|readProviderSessionHistory)\(/
const ACP_PRIMITIVE = /\b(parseAcpJournal|projectAcpJournalHistory|shownAcpMessages|getAcpJournalPath|getAcpJournalPathCandidates)\(|\bnew AcpHistoryFold\(/
/** The engines whose history is an ACP journal, from the registry itself. */
const ACP_ENGINE_IDS = [...ENGINE_REGISTRY.values()].filter((c) => c.historySource === 'acp-journal').map((c) => c.id)
const ACP_ID = `['"](?:${ACP_ENGINE_IDS.join('|')})['"]`
const ACP_BRANCH = new RegExp(`historySource\\s*[!=]==\\s*'acp-journal'|case\\s+'acp-journal'|\\bengine\\)?\\s*[!=]==?\\s*${ACP_ID}|${ACP_ID}\\s*[!=]==?\\s*[\\w.]*\\bengine\\b`)
const ACP_JOURNAL_NAME = /acp\.jsonl|\bacpJournalPath\b/g

type AcpNameCls =
  | 'routed'   // the routed reader itself
  | 'worker'   // the daemon that runs the worker on its host: it writes and repairs the journal there
  | 'gate'     // the follower check that lets a host read its own journal
  | 'skips'    // lists the streams dir and leaves the journals alone (retention, compaction)
  | 'field'    // carries the recorded path (the row, its replication, its owner, the live session); opens nothing

/** Every file of src/ that names the journal, how many times (comments taken out), and why that is no unrouted read. */
const ACP_NAME_FILES: Record<string, { cls: AcpNameCls; count: number; why: string }> = {
  'src/providers/acp-session-history.ts': { cls: 'routed', count: 3, why: 'readAcpSessionHistoryState, a member' },
  'src/providers/acp-daemon.ts': { cls: 'worker', count: 3, why: 'the worker\'s journal path and its tail repair at a daemon restart, on the host' },
  'src/providers/follower-reads-core.ts': { cls: 'gate', count: 1, why: 'a session\'s own journal passes the owner check' },
  'src/providers/stream-compact-core.ts': { cls: 'skips', count: 1, why: 'compaction leaves the journals out' },
  'src/providers/acp-session.ts': { cls: 'field', count: 6, why: 'the live session keeps and reports the path the worker answered' },
  'src/core/session-tracker.ts': { cls: 'field', count: 4, why: 'stores the path on the row' },
  'src/core/types.ts': { cls: 'field', count: 1, why: 'the row\'s field' },
  'src/core/sessions/session-row-owner.ts': { cls: 'field', count: 1, why: 'the field is the host\'s to write' },
  'src/core/replication/kinds/sessions.ts': { cls: 'field', count: 1, why: 'the field replicates with the row' },
}

/** Every file of src/ that branches on an ACP journal engine: it reads through the routed reader, or reads nothing (why). */
const ACP_BRANCH_FILES: Record<string, { reads: true } | { reads: false; why: string }> = {
  'src/core/activity-detail.ts': { reads: true },
  'src/core/session-hooks/builtins.ts': { reads: true },
  'src/core/session-projection.ts': { reads: true },
  'src/core/session-title-reconciler.ts': { reads: true },
  'src/core/sessions/engine-switch-context.ts': { reads: true },
  'src/core/sessions/session-lifecycle.ts': { reads: true },
  'src/web/routes/sessions.ts': { reads: true },
  'src/core/history-ready-refresh.ts': { reads: false, why: 'keeps ACP sessions out of the daemon\'s view refresh' },
  'src/core/sessions/history-not-written.ts': { reads: false, why: 'an ACP session is never "not written yet"; answers false before any read' },
  'src/core/sessions/session-find.ts': { reads: false, why: 'an ACP journal has no older pages; the history it searches came from the routed reader' },
  'src/core/sessions/history-unavailable.ts': { reads: false, why: 'the wording of an unavailable history' },
  'src/providers/claude-code-session.ts': { reads: false, why: 'a Codex draft model at a start; reads no history' },
  'src/providers/engine-model-probe.ts': { reads: false, why: 'which binary lists an engine\'s models' },
  'src/providers/engine-turn-watch.ts': { reads: false, why: 'which processes a turn watch expects' },
  'src/providers/session-cost-core.ts': { reads: false, why: 'the price of a Codex turn from its usage' },
}

/** Where the journal's primitives may be called: the routed reader, and the projector that defines them. */
const ACP_PRIMITIVE_FILES = ['src/providers/acp-journal-projector.ts', 'src/providers/acp-session-history.ts']

describe('every ACP journal read of a host-judged session runs on its host', () => {
  it('readAcpSessionHistory goes through readAcpSessionHistoryState, which goes through viaJudgingHost', () => {
    const text = code(read('src/providers/acp-session-history.ts'))
    expect(text).toMatch(/export async function readAcpSessionHistory\([\s\S]*?\{\s*return \(await readAcpSessionHistoryState\(/)
    expect(text).toMatch(/export function readAcpSessionHistoryState\([\s\S]*?viaJudgingHost\([^;]*'readAcpSessionHistoryState'/)
  })

  it('readProviderSessionHistory reads an ACP journal through readAcpSessionHistoryState', () => {
    const text = code(read('src/core/sessions/session-lifecycle.ts'))
    const body = text.slice(text.indexOf('export async function readProviderSessionHistory('))
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/historySource === 'acp-journal'\) \{[\s\S]*?readAcpSessionHistoryState\(/)
  })

  it('each file that branches on an ACP journal engine reads through the routed reader or reads nothing', () => {
    const hits = srcFiles('src').filter((f) => ACP_BRANCH.test(code(read(f)))).sort()
    const unclassified = hits.filter((f) => !Object.hasOwn(ACP_BRANCH_FILES, f))
    expect(unclassified, 'a new ACP journal history path: read through readAcpSessionHistoryState (routed to the host) and classify it here').toEqual([])
    const stale = Object.keys(ACP_BRANCH_FILES).filter((f) => !hits.includes(f))
    expect(stale, 'classified files that no longer branch on an ACP journal engine: take them out').toEqual([])
    for (const [f, c] of Object.entries(ACP_BRANCH_FILES)) {
      if (c.reads) expect(code(read(f)), `${f} reads an ACP history through the routed reader`).toMatch(ACP_ROUTED)
    }
  })

  it('each file that names the journal is classified, by how many times it names it', () => {
    const counts: Record<string, number> = {}
    for (const f of srcFiles('src')) {
      const n = code(read(f)).match(ACP_JOURNAL_NAME)?.length ?? 0
      if (n > 0) counts[f] = n
    }
    const want = Object.fromEntries(Object.entries(ACP_NAME_FILES).map(([f, c]) => [f, c.count]))
    expect(counts, 'a new use of the journal\'s name: read it through readAcpSessionHistoryState (routed to the host), or classify it here with why').toEqual(want)
  })

  it('the journal\'s primitives run only inside the routed reader', () => {
    const hits = srcFiles('src').filter((f) => ACP_PRIMITIVE.test(code(read(f)))).sort()
    expect(hits, 'a journal read outside readAcpSessionHistoryState is not routed to the session\'s host').toEqual(ACP_PRIMITIVE_FILES)
  })
})
