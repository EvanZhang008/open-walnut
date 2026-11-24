/**
 * Every connect step a list names is a phase connect really stamps.
 *
 * 2026-11-24: the JS daemon twin went, and with it the connect step that installed Bun
 * (`setPhase('install-runtime')`). The step lists kept naming it, so the live onboarding
 * test failed ("missing connect steps") and the UI drew an "Install runtime" step that never
 * runs. This reads the source of DaemonConnection, collects every phase it stamps with a
 * `setPhase('<phase>')` call, and checks each step list against it, so a step deleted from
 * connect cannot stay in a list again.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DAEMON_CONNECT_STEPS } from '../../src/core/sessions/host-connect-hint.js'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const read = (...p: string[]) => fs.readFileSync(path.join(REPO, ...p), 'utf8')

/** Phases DaemonConnection stamps: `this.setPhase('x')` and deployDaemon's local `setPhase('x')`. */
function stampedPhases(): Set<string> {
  const src = read('src', 'providers', 'daemon-connection.ts')
  return new Set([...src.matchAll(/\bsetPhase\(\s*'([\w-]+)'\s*\)/g)].map((m) => m[1]))
}

/** The quoted phase names inside the array literal that follows `marker` in `text`. */
function listAfter(text: string, marker: string, item: RegExp): string[] {
  const at = text.indexOf(marker)
  expect(at, `${marker} not found`).toBeGreaterThanOrEqual(0)
  const open = text.indexOf('[', at + marker.length)
  let depth = 0
  let end = open
  for (; end < text.length; end++) {
    if (text[end] === '[') depth++
    else if (text[end] === ']' && --depth === 0) break
  }
  const body = text.slice(open, end + 1)
  const phases = [...body.matchAll(item)].map((m) => m[1])
  expect(phases.length, `no phases read after ${marker}`).toBeGreaterThan(3)
  return phases
}

const LISTS: Array<{ name: string; phases: () => string[] }> = [
  { name: 'DAEMON_CONNECT_STEPS (server)', phases: () => [...DAEMON_CONNECT_STEPS] },
  {
    name: 'CONNECT_STEPS (web fallback)',
    phases: () => listAfter(read('web', 'src', 'utils', 'host-connect.ts'), 'export const CONNECT_STEPS', /phase: '([\w-]+)'/g),
  },
  {
    name: 'CONNECT_STEPS (live onboarding test)',
    phases: () => listAfter(read('tests', 'live', 'remote-host-onboarding.live.test.ts'), 'const CONNECT_STEPS =', /'([\w-]+)'/g),
  },
  {
    name: 'STEPS (host-status-live spec)',
    phases: () => listAfter(read('tests', 'e2e', 'browser', 'host-status-live.spec.ts'), 'const STEPS: ', /phase: '([\w-]+)'/g),
  },
  {
    name: 'STEPS (host-background-connect-card spec)',
    phases: () => listAfter(read('tests', 'e2e', 'browser', 'host-background-connect-card.spec.ts'), 'const STEPS =', /\['([\w-]+)', '/g),
  },
  {
    name: 'connectSteps (first-use spec)',
    phases: () => listAfter(read('tests', 'e2e', 'browser', 'first-use.spec.ts'), 'const connectSteps =', /\['([\w-]+)', '/g),
  },
]

describe('connect step lists name only phases connect stamps', () => {
  it('reads the stamped phases from the source', () => {
    const stamped = stampedPhases()
    for (const p of ['ssh', 'probe', 'upload', 'start', 'tunnel', 'handshake', 'connected']) expect(stamped).toContain(p)
  })

  it.each(LISTS)('$name', ({ phases }) => {
    const stamped = stampedPhases()
    const unstamped = phases().filter((p) => !stamped.has(p))
    expect(unstamped, 'a listed step that DaemonConnection never stamps with setPhase').toEqual([])
  })

  it('the web fallback and the server list the same steps, in order', () => {
    expect(LISTS[1].phases()).toEqual([...DAEMON_CONNECT_STEPS])
  })
})
