/**
 * Class guard: every client a session's agent calls Walnut through keeps a call no Walnut answered
 * in the session's spool and tells it with a later call that gets through (lib/no-answer-report.ts).
 *
 * 2026-11-25 audit: 11 such failures in agents' transcripts, 4 in usage_watch. The fix of the day
 * before covered two clients (the in-session CLI and the host's MCP server); the Mac session's
 * `walnut` is the hub's own CLI (commands/tools.ts) and Main's MCP mount is the hub's own
 * (mcp/tools.ts), and neither kept anything. The members are read from the source: a CLI command or
 * an MCP server that runs an op over HTTP, and a client that sends a gateway call an agent reads
 * (clientFiles below). A new one fails here until it keeps and tells, or is listed below with why not.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../../..')

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...filesUnder(rel))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(rel)
  }
  return out
}

/**
 * The clients that print an op's answer to an agent, read from the source: a CLI command or an MCP
 * server that runs an op over HTTP (`executeOp(` in src/commands/ or src/mcp/, or anywhere with
 * `forAgent`), and a client that sends a gateway call an agent reads (`client: 'cli'|'mcp'` in
 * src/providers/, `toolsCallLine(`, `request('tools.call'`).
 */
function clientFiles(): string[] {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8')
  const http = [...filesUnder('src/commands'), ...filesUnder('src/mcp')].filter((f) => /\bexecuteOp\(/.test(read(f)))
  const gateway = filesUnder('src/providers').filter((f) => /\bclient: '(?:cli|mcp)'/.test(read(f)))
  const anywhere = filesUnder('src').filter((f) => {
    const src = read(f)
    return /\btoolsCallLine(?:Within)?\(|request\('tools\.call'/.test(src) || (/\bexecuteOp\(/.test(src) && /\bforAgent\b/.test(src))
  })
  return [...new Set([...http, ...gateway, ...anywhere])].sort()
}

const KEEPS = /\b(?:spoolNoAnswer|keepNoAnswer|noteSessionFailure|noAnswer)\(/
const TELLS = /\b(?:tellSpooledNoAnswers|tellKeptNoAnswers|noteSessionAnswered|tellNoAnswers)\(/

/** Files the enumeration finds that are no session's client, with why. */
const NOT_A_SESSIONS: Record<string, string> = {
  // The builder of the lines themselves, used by the clients.
  'src/providers/gateway-request.ts': 'builds tools.call lines for the clients',
  // A trigger check's calls: no session made them (core/hosts/trigger-caller.ts).
  'src/commands/tools-daemon-fallback.ts': 'sends a trigger check\'s calls; a session\'s go through wn-cli.ts',
  // The executor and the servers that run a session's call in their own process: no one away to miss.
  'src/ops/executor.ts': 'the executor every client calls; it reports, the client keeps',
  'src/core/peers/capability-router.ts': 'the hub: it runs the call, it does not wait on a Walnut',
  'src/core/leader/backup-gateway.ts': 'the companion\'s gateway while it leads: it runs the call itself',
}

/**
 * Clients that never show an agent a no-answer: each rides a restart (lib/wait-through-restart.ts)
 * until its own deadline, so what the agent reads is the answer that came. The marker is the call
 * that makes it so, checked below.
 */
const RIDES_RESTARTS: Record<string, string> = {
  'src/commands/wait.ts': 'waitThroughRestart(',
  'src/commands/approve.ts': 'runApprove(',
  'src/commands/pass.ts': 'runPass(',
  'src/commands/browser.ts': 'runBrowser(',
}

describe('every client a session calls Walnut through counts a call no Walnut answered', () => {
  it('the enumeration finds the four the audit named', () => {
    const files = clientFiles()
    for (const f of ['src/commands/tools.ts', 'src/mcp/tools.ts', 'src/providers/wn-cli.ts', 'src/providers/walnut-mcp-stdio.ts']) expect(files).toContain(f)
  })

  it('each keeps and tells, or rides a restart', () => {
    const missing = clientFiles().filter((f) => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf-8')
      if (RIDES_RESTARTS[f] || NOT_A_SESSIONS[f]) return false
      return !(KEEPS.test(src) && TELLS.test(src))
    })
    expect(missing, 'a client that prints an op\'s answer to an agent: keep a no-answer and tell it (providers/session-no-answer.ts noteSessionFailure and noteSessionAnswered), or list it in RIDES_RESTARTS or NOT_A_SESSIONS with why').toEqual([])
  })

  it('a client listed as riding restarts still does', () => {
    for (const [f, marker] of Object.entries(RIDES_RESTARTS)) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf-8'), f).toContain(marker)
    }
  })

  it('a listed non-client is still in the source', () => {
    for (const f of Object.keys(NOT_A_SESSIONS)) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true)
  })

  it('none keeps them only in its own memory: one spool per session, so any client of it tells them', () => {
    // Memory is a fallback for a spool that cannot be written (walnut-mcp-stdio.ts), never the place.
    for (const f of clientFiles()) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf-8')
      expect(src, f).not.toMatch(/const noAnswers\s*=\s*\[/)
      if (/new NoAnswerLog\(/.test(src)) expect(src, f).toMatch(/if \(!spoolNoAnswer\(/)
    }
  })
})
