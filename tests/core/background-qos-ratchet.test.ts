/**
 * Background children start through the utility QoS clamp
 * (src/lib/background-qos.ts), which is a no-op unless the deploy raised the
 * server to Interactive and asked for it. When it did, every child below would
 * otherwise inherit priority 31 and compete with the server it was meant to
 * leave room for: the local daemon (and every agent session under it), the
 * embedding model workers, the git backups and gc, and the history compaction.
 *
 * Left in the server's band on purpose (user-facing or too short to matter):
 * the terminal PTY, voice input, the editor server, the files and git routes,
 * the Personal AI's own CLI turns and subagents (the user waits on those), the
 * warm search-agent CLI (micro-claude-warm.ts, same reason), the
 * outside-activity sampler (a few ms per 5 s, and its macOS permission grant
 * is tied to how it is launched), and one-shot probes and setup (ps, sysctl,
 * lsof, the data repo's init and remote reads at boot).
 *
 * Not yet clamped, and not on purpose: the model adapter's `claude -p` turns
 * (src/model/providers/adapter-claude-cli.ts) also carry background callers
 * (titles, triage, summaries), but the call carries no purpose, so a clamp
 * there would slow the Personal AI chat too.
 *
 * A source ratchet like the other spawn rules (signal-call-ratchet): a site
 * that drops the clamp fails here; tests/providers/local-daemon-qos-spawn.test.ts
 * and tests/lib/hybrid-search-embed-launcher.test.ts run two of them for real.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

const SITES: Array<{ file: string; what: string; pattern: RegExp; count?: number }> = [
  { file: 'src/providers/local-daemon.ts', what: 'the local daemon, direct spawn and its retry', pattern: /withUtilityQosClamp\(cmd, args\)/g, count: 2 },
  { file: 'src/providers/local-daemon.ts', what: 'the local daemon under the session host', pattern: /withUtilityQosClamp\(host\.argv\[0\]!, host\.argv\.slice\(1\)\)/g },
  { file: 'src/integrations/git-sync.ts', what: 'git backups through a shell (gc, repack, push)', pattern: /withUtilityQosClamp\('\/bin\/sh', \['-c', command\]\)/g },
  { file: 'src/integrations/git-sync.ts', what: 'git backups by argv', pattern: /withUtilityQosClamp\('git', args, /g },
  { file: 'src/web/server.ts', what: 'the history compaction worker', pattern: /fork\(workerPath, \[\], \{ stdio: 'ignore', \.\.\.utilityQosForkExec\(process\.execArgv\) \}\)/g },
  { file: 'src/core/search/wiring.ts', what: 'the embedding model workers', pattern: /workerLauncher: \{ execPath: launch\.execPath, execArgv: launch\.execArgv \}/g },
]

describe('background children go through the QoS clamp', () => {
  it.each(SITES.map((s) => [s.what, s] as const))('%s', (_what, site) => {
    const hits = read(site.file).match(site.pattern) ?? []
    expect(hits.length).toBe(site.count ?? 1)
  })

  it('every spawn in those files that starts one of them takes the clamped command', () => {
    // The clamp returns [cmd, args]; a spawn that still names the raw program
    // would bypass it.
    expect(read('src/integrations/git-sync.ts')).not.toMatch(/spawn\('(?:\/bin\/sh|git)'/)
    expect(read('src/providers/local-daemon.ts')).toMatch(/spawn\(spawnCmd, spawnArgs, \{/)
    expect(read('src/providers/local-daemon.ts')).toMatch(/spawn\(retryCmd, retryArgs, \{/)
  })
})
