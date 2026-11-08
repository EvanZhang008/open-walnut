/**
 * After Not now, the person is told where to connect later, in place, once (2026-11-10 review:
 * the prompt went with no pointer). Guard: every surface that offers Not now for a found host
 * either keeps the host's row in place (Remote Hosts: the row stays, with Connect now), or puts
 * the Not now line in its place.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { notNowLine } from '../../web/src/utils/found-host-words'

const WEB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../web/src')
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name)
  return e.isDirectory() ? walk(p) : /\.tsx$/.test(e.name) ? [p] : []
})

describe('the Not now line', () => {
  it('names where to connect later', () => {
    expect(notNowLine('demo-devbox')).toBe('demo-devbox stays off. Connect it any time from the folder picker of a new task, or in Settings > Remote Hosts.')
  })

  it('the prompt puts it in the host\'s place after Not now, with a way there and a close', () => {
    const src = fs.readFileSync(path.join(WEB, 'components/common/FoundHostPrompts.tsx'), 'utf8')
    expect(src).toMatch(/if \(choice === 'not_now'\) \{[^}]*setDeferred\(/)
    expect(src).toMatch(/notNowLine\(h\.label\)/)
    expect(src).toMatch(/openHostSettings\(navigate, h\.host\)/)
  })
})

describe('guard: every Not now for a found host says where to connect later', () => {
  // Surfaces where the host's own row stays in place after Not now, so it is its own pointer.
  const ROW_STAYS: Record<string, string> = {
    'components/settings/sections/RemoteHostSshRow.tsx': 'the row stays in Remote Hosts with Connect now',
    // Its "Don't add it" answers not_now and the host's row stays in the list as waiting, with its
    // Add button (firstRunHostRows keeps a discovered host whose connect is not_now as `waits`).
    'components/first-run/FirstRunDialog.tsx': 'the row stays in the first-run host list with Add',
  }
  it('each file offering a "Not now" for a found host shows notNowLine or keeps the row', () => {
    const offenders: string[] = []
    for (const file of walk(WEB)) {
      const rel = path.relative(WEB, file)
      const src = fs.readFileSync(file, 'utf8')
      if (!/'not_now'/.test(src) || !/Not now/.test(src)) continue
      if (ROW_STAYS[rel]) continue
      if (!/notNowLine\(/.test(src)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})
