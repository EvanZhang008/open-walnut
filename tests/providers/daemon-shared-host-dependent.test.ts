/**
 * Every capability the daemon adds in its hello beyond ADVERTISED_DAEMON_CAPABILITIES is
 * host-dependent for the shared-daemon rule (daemon-shared.ts). Otherwise a running daemon
 * that says it reads as having something this build "lacks", and a host another Walnut shares
 * keeps that daemon for good (2026-11-12: caller-proof-v1, said by the bun daemon where its FFI
 * loads, kept a dev host's daemon from every update that day).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { HOST_DEPENDENT_CAPABILITIES, sharedDaemonVerdict, ourDaemonCapabilities } from '../../src/providers/daemon-shared.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

/** The body of `function <name>` in a file, to its first line that is a lone `}`. */
function body(file: string, start: string): string {
  const s = read(file)
  const i = s.indexOf(start)
  expect(i, `${start} in ${file}`).toBeGreaterThan(-1)
  return s.slice(i, s.indexOf('\n}\n', i))
}

/** The capability strings a hello builder adds: literals, and *_CAPABILITY constants resolved from src/providers. */
function added(src: string): string[] {
  const out = new Set(src.match(/'[a-z0-9-]+-v\d+'/g)?.map((q) => q.slice(1, -1)) ?? [])
  for (const name of src.match(/\b[A-Z][A-Z0-9_]*_CAPABILITY\b/g) ?? []) {
    const dir = path.join(ROOT, 'src/providers')
    const def = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .map((t) => new RegExp(`export const ${name}\\s*=\\s*'([a-z0-9-]+)'`).exec(t)?.[1]).find(Boolean)
    expect(def, `the value of ${name}`).toBeTruthy()
    out.add(def!)
  }
  return [...out]
}

describe('capabilities the daemon adds by its host are host-dependent', () => {
  it('each one the daemon adds beyond the advertised list is in HOST_DEPENDENT_CAPABILITIES', () => {
    const advertised = new Set<string>(ADVERTISED_DAEMON_CAPABILITIES)
    const runtime = added(body('src/providers/daemon-standalone.ts', 'function helloCapabilities(): string[] {'))
      .filter((c) => !advertised.has(c))
    expect(runtime).toContain('caller-proof-v1')
    expect(runtime.filter((c) => !HOST_DEPENDENT_CAPABILITIES.has(c))).toEqual([])
  })

  it('a shared daemon that says caller-proof-v1 is still updated to a build that brings what it lacks', () => {
    const ours = ourDaemonCapabilities('binary')
    const verdict = sharedDaemonVerdict({
      ourKey: 'aaaaaaaaaaaaaaaa', runningVersion: 'walnut-daemon-old', now: 1_000_000,
      running: { version: 'walnut-daemon-old', twin: 'binary', capabilities: [...ours.slice(0, -1), 'caller-proof-v1', 'service-handover-v1'], walnuts: { bbbbbbbbbbbbbbbb: 999_000 } },
      env: {},
    })
    expect(verdict.keep).toBe(false)
  })

  it('a shared daemon lacking pty-stream-v1 needs the update unless it says its runtime has no pty', () => {
    const ours = ourDaemonCapabilities('source')
    const lacking = ours.filter((c) => c !== 'pty-stream-v1')
    const verdict = (pty: boolean | undefined) => sharedDaemonVerdict({
      ourKey: 'aaaaaaaaaaaaaaaa', runningVersion: 'walnut-daemon-old', now: 1_000_000,
      running: { version: 'walnut-daemon-old', twin: 'source', capabilities: lacking, walnuts: { bbbbbbbbbbbbbbbb: 999_000 }, ...(pty === undefined ? {} : { pty }) },
      env: {},
    })
    // A build from before the terminal streams says nothing about a pty: it lacks them, it is updated.
    expect(verdict(undefined)).toMatchObject({ keep: false, missing: ['pty-stream-v1'] })
    // A daemon on bun that still lacks them is behind too.
    expect(verdict(true)).toMatchObject({ keep: false, missing: ['pty-stream-v1'] })
    // A source twin on Node can never have them: every build there lacks them, so it is kept.
    expect(verdict(false).keep).toBe(true)
    // Every other capability is still missing when lacked, pty or not.
    const other = sharedDaemonVerdict({
      ourKey: 'aaaaaaaaaaaaaaaa', runningVersion: 'walnut-daemon-old', now: 1_000_000,
      running: { version: 'walnut-daemon-old', twin: 'source', capabilities: lacking.slice(1), walnuts: { bbbbbbbbbbbbbbbb: 999_000 }, pty: false },
      env: {},
    })
    expect(other).toMatchObject({ keep: false, missing: [lacking[0]] })
  })
})
