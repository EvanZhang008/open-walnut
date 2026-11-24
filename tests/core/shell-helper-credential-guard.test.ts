/**
 * Ratchet: every model helper the server itself spawns with a shell reaches its own Walnut with
 * a credential that server takes, on the leader and on a replica (2026-11-24: the AI search child
 * curled a host replica with none, was refused 401, and AI search found nothing there while the
 * Mac was away; tests/replica/search-helper-credential.test.ts).
 *
 * The class has two halves, and each fails here when a new member skips it:
 *
 *  1. The spawn. Every source file that starts or resolves the Claude CLI is named below with what
 *     it does: it resolves the binary (resolveClaudeCliExecutable, claudeFallbackCommand), spawns
 *     `claude` by name, builds a stream-json argv, or passes a `--tools` list. A CLI started with
 *     no `--tools` has the default set, Bash included, so resolving it is the signal, not the flag.
 *     A helper's spawn layer must build the child's env with applyWalnutHelperEnv
 *     (src/lib/self-api-root.ts), which gives a child with a shell the helper credential; a
 *     session is not a helper (on the Mac loopback vouches for it, on a host its daemon gives it
 *     a call token); a spawn with no tools has no shell; a probe runs no model turn. A new file
 *     with any of the signals fails until it is named here.
 *  2. The prompt. Every command a prompt tells a model to run against a Walnut address (a `${...}`
 *     or `$NAME` base, or a literal loopback port, followed by `/api/`) carries
 *     HELPER_CALL_CURL_AUTH, or is named below as a script a person runs. A credentialed curl
 *     names a path in HELPER_CALL_PATHS: anywhere else the credential is refused at run time.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCliSystemPrompt } from '../../src/core/task-search-agent-contract.js'
import { HELPER_CALL_CURL_AUTH, HELPER_CALL_PATHS } from '../../src/lib/self-api-root.js'

const SRC = path.resolve(import.meta.dirname, '../../src')

type Spawner = { kind: 'helper' | 'session' | 'no-shell' | 'probe' | 'not-a-spawn'; why: string }

/** Every src file with a Claude CLI spawn signal (see CLI_SIGNAL), repo-relative to src/. */
const SPAWNERS: Record<string, Spawner> = {
  'providers/inline-subagent.ts': { kind: 'helper', why: 'one-shot utility children (runMicroClaude cold path)' },
  'providers/micro-claude-warm.ts': { kind: 'helper', why: 'the warm micro-Claude pool (AI search, ai.run direct, quick input)' },
  'model/providers/adapter-claude-cli.ts': { kind: 'no-shell', why: "model calls through the CLI run with `--tools ''`" },
  'providers/claude-code-session.ts': { kind: 'session', why: 'a task or lane session' },
  'providers/claude-session-argv.ts': { kind: 'session', why: "a session's argv frame" },
  'providers/host-start-core.ts': { kind: 'session', why: "a session a host's daemon starts" },
  'providers/local-daemon.ts': { kind: 'session', why: 'the CLI path the local session daemon runs sessions with' },
  'providers/daemon-cron-supervision.ts': { kind: 'not-a-spawn', why: 'reads the flags of a CLI that runs' },
  'core/claude-cli-detect.ts': { kind: 'not-a-spawn', why: 'the resolver itself' },
  'core/test-claude-guard.ts': { kind: 'not-a-spawn', why: "which `claude` a test may run" },
  'core/task-search-agent.ts': { kind: 'not-a-spawn', why: 'asks whether a CLI exists; its child starts through micro-claude' },
  'web/routes/cloud-chat-fallback.ts': { kind: 'not-a-spawn', why: 'asks whether a CLI exists; its turns run as a lane session' },
  'core/agents/engine-probe.ts': { kind: 'probe', why: 'runs `claude --version`' },
  'core/diagnostics/local-probes.ts': { kind: 'probe', why: 'where `claude` resolves, without running it' },
}

/** A file that starts or resolves the Claude CLI (comments excluded). */
const CLI_SIGNAL = /\b(?:resolveClaudeCliExecutable|claudeFallbackCommand)\(|\bspawn\(\s*['"]claude['"]|['"]--(?:output|input)-format['"],\s*['"]stream-json['"]|['"]--tools(?:['"]|=)/

/** A shell command against a Walnut address: a curl whose base is `${...}`, `$NAME` or a loopback port, then /api/. */
const WALNUT_CURL = /curl\b.*(?:\$\{[^}]+\}|\$[A-Za-z_]\w*|(?:localhost|127\.0\.0\.1):\d+)\/api\//

/** Curl commands against a given Walnut address that a person runs, not a model. */
const PERSON_SCRIPTS: Record<string, string> = {
  'core/net/net-join-ps1.ts': "the join script's own wait for the server it just started",
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'static' && e.name !== 'node_modules') out.push(...sourceFiles(p)) }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Code lines only: comments name commands without running them. */
const codeOf = (text: string) => text.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
const files = sourceFiles(SRC).map((f) => {
  const text = fs.readFileSync(f, 'utf8')
  return { rel: path.relative(SRC, f).split(path.sep).join('/'), text, lines: codeOf(text) }
})

describe('every model helper the server spawns with a shell carries its credential', () => {
  it('every file that starts or resolves the Claude CLI is named, with what it does', () => {
    const found = files.filter((f) => CLI_SIGNAL.test(f.lines.join('\n'))).map((f) => f.rel).sort()
    expect(found).toEqual(Object.keys(SPAWNERS).sort())
  })

  it('a helper spawn layer builds the child env with applyWalnutHelperEnv; a no-shell spawn passes no tools', () => {
    const wrong: string[] = []
    for (const [rel, s] of Object.entries(SPAWNERS)) {
      const text = files.find((f) => f.rel === rel)?.text ?? ''
      if (s.kind === 'helper' && !text.includes('applyWalnutHelperEnv(')) wrong.push(`${rel}: a helper spawn without applyWalnutHelperEnv`)
      if (s.kind === 'no-shell' && !/'--tools',\s*''/.test(text)) wrong.push(`${rel}: named no-shell but passes tools`)
    }
    expect(wrong).toEqual([])
  })

  it('every curl a prompt builds against a Walnut address carries the credential, for a helper path', () => {
    const wrong: string[] = []
    let seen = 0
    for (const f of files) {
      for (const [i, line] of f.lines.entries()) {
        if (!WALNUT_CURL.test(line)) continue
        seen++
        const at = `${f.rel}:${i + 1}: ${line.trim().slice(0, 140)}`
        if (PERSON_SCRIPTS[f.rel]) continue
        if (!line.includes('${HELPER_CALL_CURL_AUTH}')) { wrong.push(`${at} (no helper credential)`); continue }
        for (const m of line.matchAll(/\/api\/[^\s"'`?$\\]*/g)) {
          if (!HELPER_CALL_PATHS.includes(m[0].replace(/\/+$/, ''))) wrong.push(`${at} (${m[0]} is not in HELPER_CALL_PATHS)`)
        }
      }
    }
    expect(seen).toBeGreaterThan(0)
    expect(wrong).toEqual([])
  })

  it('the named person scripts still exist (no stale entries)', () => {
    for (const rel of Object.keys(PERSON_SCRIPTS)) expect(files.some((f) => f.rel === rel)).toBe(true)
  })

  it("the AI search prompt's every curl line carries it", () => {
    const lines = buildCliSystemPrompt('http://127.0.0.1:45996').split('\n').filter((l) => l.includes('curl '))
    expect(lines.length).toBe(2)
    for (const l of lines) expect(l).toContain(HELPER_CALL_CURL_AUTH)
  })
})
