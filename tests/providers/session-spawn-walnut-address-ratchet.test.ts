/**
 * Every place that launches an agent CLI gives it its Walnut's address from the ONE rule
 * (src/lib/self-api-root.ts walnutApiEnvForSession), and each one is checked to carry it.
 *
 * Incident this pins (2026-11-20): on a Walnut listening on another port than :3456, a VP
 * session's `walnut` calls went to :3456. The address reached the CLI only in its `--settings`
 * env; its process env was the daemon's own (none, since the daemon started before the server
 * listened), so anything reading the process env missed it. Each launch path had passed the
 * address its own way, or not at all (the in-server micro-Claude, inline subagent and
 * Personal AI children relied on the server's env happening to hold it).
 *
 * Two halves:
 *  - a ratchet over src/: a file that builds an agent CLI's launch (stream-json argv, an ACP
 *    adapter env) must ask walnutApiEnvForSession, or be listed below with how it gets the
 *    address instead. A new launch path fails here until it does one or the other;
 *  - each in-server launch builder, run with a server root set, carries exactly that root.
 *    (ClaudeCodeSession: session-walnut-api-env.test.ts; ACP: acp-walnut-api-env.test.ts;
 *    the daemon's process env: daemon-session-walnut-twins-e2e.test.ts.)
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { setSelfApiRoot } from '../../src/lib/self-api-root.js'
import { buildSpawnEnv } from '../../src/model/providers/adapter-claude-cli.js'
import { buildHostSpawnTemplate } from '../../src/providers/spawn-template.js'

const SRC = path.resolve(import.meta.dirname, '../../src')

/** Launch builders that get the address another way, and how. */
const ELSEWHERE: Record<string, string> = {
  'providers/daemon-standalone.ts': 'mirrors the address its Walnut named (sessionWalnutApiUrl), never its own',
  'providers/engine-model-probe.ts': 'asks an engine for its model list; runs no turn and calls no Walnut op',
}

/** A file that builds an agent CLI launch: a stream-json argv, or an ACP adapter's env. */
const LAUNCH = /['"]--(?:output|input)-format['"],\s*['"]stream-json['"]|(?<!function )\bbuildAcpAdapterEnv\(/

function codeOf(file: string): string {
  // Comments do not launch anything.
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.(ts|mjs|cjs|js)$/.test(e.name)) out.push(full)
  }
  return out
}

afterEach(() => setSelfApiRoot(null))

describe('every agent CLI launch path names its Walnut', () => {
  it('asks the one rule, or says how it gets the address instead', () => {
    const launches = walk(SRC).filter((f) => LAUNCH.test(codeOf(f))).map((f) => path.relative(SRC, f)).sort()
    const silent = launches.filter((rel) => !ELSEWHERE[rel] && !/\bwalnutApiEnvForSession\(/.test(codeOf(path.join(SRC, rel))))
    expect(silent).toEqual([])
    // The list names only files that still launch: a stale entry hides nothing.
    for (const rel of Object.keys(ELSEWHERE)) expect(launches, rel).toContain(rel)
    // The sweep still finds the launch builders it was written for.
    for (const rel of ['providers/claude-code-session.ts', 'providers/acp-session.ts', 'providers/spawn-template.ts',
      'providers/inline-subagent.ts', 'providers/micro-claude-warm.ts', 'model/providers/adapter-claude-cli.ts']) {
      expect(launches, rel).toContain(rel)
    }
  })
})

describe('in-server launch builders carry the server root', () => {
  const ROOT = 'http://127.0.0.1:45991'

  it('the Personal AI turn engine (adapter-claude-cli)', () => {
    setSelfApiRoot(ROOT)
    expect(buildSpawnEnv({ HOME: '/h' }).OPEN_WALNUT_API_URL).toBe(ROOT)
    setSelfApiRoot(null)
    expect(buildSpawnEnv({ HOME: '/h' }).OPEN_WALNUT_API_URL).toBeUndefined()
  })

  it('a host spawn template: a local host gets the root, a remote one none', () => {
    setSelfApiRoot(ROOT)
    const settingsOf = (hostKey: string) => {
      const t = buildHostSpawnTemplate({ home: '/h', hostKey, cwd: '/c', env: {} })
      const i = t.argv.indexOf('--settings')
      return JSON.parse(t.argv[i + 1] as string) as { env?: Record<string, string> }
    }
    expect(settingsOf('__local__').env?.OPEN_WALNUT_API_URL).toBe(ROOT)
    expect(settingsOf('devbox').env?.OPEN_WALNUT_API_URL).toBeUndefined()
  })
})
