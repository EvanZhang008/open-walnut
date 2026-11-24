/**
 * Ratchet: every model helper the server itself spawns with a shell reaches its own Walnut with
 * a credential that server takes, on the leader and on a replica (2026-11-24: the AI search child
 * curled a host replica with none, was refused 401, and AI search found nothing there while the
 * Mac was away; tests/replica/search-helper-credential.test.ts).
 *
 * The class has two halves, and each fails here when a new member skips it:
 *
 *  1. The spawn. Every source file that hands the Claude CLI a `--tools` list is named below with
 *     what it spawns. A helper's spawn layer must build the child's env with applyWalnutHelperEnv
 *     (src/lib/self-api-root.ts), which gives a child with a shell the helper credential; a
 *     session is not a helper (on the Mac loopback vouches for it, on a host its daemon gives it
 *     a call token); a spawn with no tools has no shell. A new file that passes `--tools` fails
 *     until it is named here.
 *  2. The prompt. Every command a prompt tells a model to run against a Walnut address it was
 *     given (`curl ... ${...}/api/...`) carries HELPER_CALL_CURL_AUTH, or is named below as a
 *     script a person runs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCliSystemPrompt } from '../../src/core/task-search-agent-contract.js'
import { HELPER_CALL_CURL_AUTH } from '../../src/lib/self-api-root.js'

const SRC = path.resolve(import.meta.dirname, '../../src')

type Spawner =
  | { kind: 'helper'; why: string }
  | { kind: 'session'; why: string }
  | { kind: 'no-shell'; why: string }
  | { kind: 'not-a-spawn'; why: string }

/** Every src file that names the CLI's `--tools` flag, repo-relative to src/. */
const SPAWNERS: Record<string, Spawner> = {
  'providers/inline-subagent.ts': { kind: 'helper', why: 'one-shot utility children (runMicroClaude cold path)' },
  'providers/micro-claude-warm.ts': { kind: 'helper', why: 'the warm micro-Claude pool (AI search, ai.run direct, quick input)' },
  'model/providers/adapter-claude-cli.ts': { kind: 'no-shell', why: "model calls through the CLI run with `--tools ''`" },
  'providers/claude-code-session.ts': { kind: 'session', why: 'a task or lane session' },
  'providers/host-start-core.ts': { kind: 'session', why: "a session a host's daemon starts" },
  'providers/daemon-cron-supervision.ts': { kind: 'not-a-spawn', why: 'reads the flags of a CLI that runs' },
}

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

const files = sourceFiles(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }))

describe('every model helper the server spawns with a shell carries its credential', () => {
  it('every file that hands the CLI a --tools list is named, with what it spawns', () => {
    const passing = files.filter((f) => /['"]--tools['"]/.test(f.text)).map((f) => f.rel).sort()
    expect(passing).toEqual(Object.keys(SPAWNERS).sort())
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

  it("every curl a prompt builds against a Walnut address carries the helper credential", () => {
    const wrong: string[] = []
    let seen = 0
    for (const f of files) {
      for (const [i, line] of f.text.split('\n').entries()) {
        if (/^\s*(\*|\/\/)/.test(line)) continue
        if (!/curl\b[^`]*\$\{[^}]+\}[^`]*\/api\//.test(line)) continue
        seen++
        if (line.includes('${HELPER_CALL_CURL_AUTH}') || PERSON_SCRIPTS[f.rel]) continue
        wrong.push(`${f.rel}:${i + 1}: ${line.trim().slice(0, 140)}`)
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
