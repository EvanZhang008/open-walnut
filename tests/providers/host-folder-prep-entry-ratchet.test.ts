/**
 * Ratchet: every place this leader hands a host a start or a resume of a CLI (a start, a resume of a
 * legacy session, a send that wakes a CLI at rest, a Restart) makes the session's folder ready first,
 * through the one helper the runner's own spawn uses (src/providers/session-folder-prep.ts). A host's
 * service is a replica and cannot make a released workspace again (2026-11-24: every task woken after
 * its workspace was released failed on its host with "Working directory no longer exists").
 *
 * Enumerated from the source: every call of the leader side's hand primitives (`startOnHostCatchingUp(`,
 * `.startOnHost(`, `.sendToHost(`, and a host-api start or send path), each by the top-level function
 * it is in. Each such function calls the helper before its hand, or is listed here with why. A new
 * entry fails here until it does one or the other.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { HOST_FORWARDED_RUNNER_METHODS, HOST_RESPAWNS } from '../../src/providers/host-judged-runner.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SRC = path.join(ROOT, 'src')

/** The primitives themselves (their definitions and the switch catch-up that wraps one). */
const PRIMITIVES = new Set(['src/core/session-channel/leader-side.ts', 'src/core/session-channel/switch-catch-up.ts', 'src/core/sessions/session-command-gate.ts'])

/** Hands that start no CLI, or run where no workspace can be made, each with why. */
const NO_PREP: Record<string, string> = {
  // A probe: no line, nothing to run (holdOnly); the host answers whether it owns the session.
  'src/providers/host-handover.ts:askHostOwns': 'holdOnly probe, starts nothing',
  // The phone's send through the cloud companion, a replica (no workspace can be made there): a host
  // that refuses it on a gone folder says so on its channel to the leader, whose session:error
  // handler takes the folder-gone way (session-folder-prep.ts noteHostFolderGone).
  'src/core/session-channel/companion-host-ops.ts:sendViaHost': 'runs on the companion; the host refusal reaches the leader',
}

const PREP = /\b(prepareFolderForHost|prepareHostSessionFolder)\(/
const HAND = /startOnHostCatchingUp\(|\.startOnHost\(|\.sendToHost\(|['`]\/host-api\/sessions\/(start|send)['`]/
const FN = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Every hand site: `file:function`, and whether the helper is called in that function before it. */
function handSites(): Array<{ site: string; prepared: boolean }> {
  const sites: Array<{ site: string; prepared: boolean }> = []
  for (const file of tsFiles(SRC)) {
    const rel = path.relative(ROOT, file)
    if (PRIMITIVES.has(rel)) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    let fn = ''
    let body: string[] = []
    for (const line of lines) {
      const m = FN.exec(line)
      if (m) { fn = m[1]; body = [] }
      const code = line.trim()
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('import ')) { body.push(line); continue }
      if (HAND.test(line)) sites.push({ site: `${rel}:${fn}`, prepared: body.some((l) => PREP.test(l)) })
      body.push(line)
    }
  }
  return sites
}

describe('every start or resume this leader hands a host makes its folder ready first', () => {
  it('finds the known entries (the guard reads the source it guards)', () => {
    const names = handSites().map((s) => s.site)
    expect(names).toEqual(expect.arrayContaining([
      'src/providers/host-judged-runner.ts:startOnJudgingHost',
      'src/providers/host-resume.ts:resumeNow',
      'src/providers/host-judged-send.ts:deliver',
    ]))
  })

  it('each hand goes through the shared folder preparation, or is listed with why', () => {
    const missing = handSites().filter((s) => !s.prepared && !NO_PREP[s.site]).map((s) => s.site)
    expect(missing).toEqual([])
    // A listed exception that is gone (or now prepares) leaves the list.
    const found = new Set(handSites().filter((s) => !s.prepared).map((s) => s.site))
    expect(Object.keys(NO_PREP).filter((k) => !found.has(k))).toEqual([])
  })

  it('the leader side sends a start or a send to a host only through its two methods', () => {
    const src = readFileSync(path.join(SRC, 'core/session-channel/leader-side.ts'), 'utf8')
    expect(src.match(/request\(\s*\w+,\s*'start'/g) ?? []).toHaveLength(1)
    expect(src.match(/request\(\s*\w+,\s*'send'/g) ?? []).toHaveLength(1)
  })

  it('a forwarded runner member that starts the CLI again prepares the folder first', () => {
    // A new forwarded member whose name says it (re)starts a CLI must be in HOST_RESPAWNS.
    const respawning = HOST_FORWARDED_RUNNER_METHODS.filter((m) => /restart|reinit|respawn|resume|spawn|start/i.test(m))
    expect(respawning.filter((m) => !HOST_RESPAWNS.has(m))).toEqual([])
    expect([...HOST_RESPAWNS]).toContain('reinitialize')
    const src = readFileSync(path.join(SRC, 'providers/host-judged-runner.ts'), 'utf8')
    const at = src.indexOf('async function respawnOnHost(')
    const body = src.slice(at, src.indexOf('\n}\n', at))
    expect(body.indexOf('prepareHostSessionFolder(')).toBeGreaterThan(0)
    expect(body.indexOf('prepareHostSessionFolder(')).toBeLessThan(body.indexOf('callRunner('))
  })

  it('the runner\'s own spawn uses the same helper, with no second copy beside it', () => {
    const src = readFileSync(path.join(SRC, 'providers/claude-code-session.ts'), 'utf8')
    expect(src).toMatch(/prepareSessionFolder\(/)
    expect(src).not.toMatch(/\bcheckCwdExists\(/)
    expect(src).not.toMatch(/\bremakeForGoneFolder\(/)
    expect(src).not.toMatch(/\brestoreOwnTaskDir\(/)
    // In providers, only the helper calls the remake of a gone folder.
    const callers = tsFiles(path.join(SRC, 'providers'))
      .filter((f) => /\bremakeForGoneFolder\(/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
    expect(callers).toEqual(['src/providers/session-folder-prep.ts'])
  })
})
