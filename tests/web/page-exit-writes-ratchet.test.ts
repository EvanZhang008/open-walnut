/**
 * Every module that does work on `pagehide` is listed here with how its writes outlive the page
 * (2026-11-01: the visit batch sent at a reload was cancelled, because its POST was an ordinary
 * request). A new pagehide handler fails this test until it is classified, and a raw write fetch
 * in any of them must carry keepalive.
 *   client  : writes through web/src/api/client.ts, which sends a write made while the page hides
 *             or leaves with keepalive, at once (tests/web/api-client-page-exit.test.ts)
 *   raw     : its own fetch with keepalive, or navigator.sendBeacon
 *   local   : writes only browser storage or posts to a parent frame, nothing over the network
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../web/src')
const KNOWN: Record<string, 'client' | 'raw' | 'local'> = {
  'api/client.ts': 'client',
  'api/page-visits.ts': 'client',
  'components/settings/inputs/useCommitField.ts': 'client',
  'components/settings/inputs/useSettingsAutoSave.ts': 'client',
  'components/settings/sections/AdvancedSection.tsx': 'client',
  'components/settings/sections/SttSection.tsx': 'client',
  'utils/drafts.ts': 'raw',
  'utils/ui-prefs-sync.ts': 'raw',
  'utils/time-tracking.ts': 'raw',
  'utils/browser-logger.ts': 'raw',
  'components/chat/island-store.ts': 'local',
  'components/chat/island-runtime.ts': 'local',
  'hooks/usePhoneRestore.ts': 'local',
  'popout/PopoutExtPanel.tsx': 'local', // its snapshot goes to the parent frame, its history to IndexedDB
  'components/common/FileContentView.tsx': 'local', // the unsaved text goes to localStorage and the IndexedDB draft store
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []
  })
}

/** Each `fetch(` call's text up to its closing parenthesis. */
function fetchCalls(src: string): string[] {
  const out: string[] = []
  const re = /\bfetch\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 0
    let i = m.index + 'fetch'.length
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')' && --depth === 0) break
    }
    out.push(src.slice(m.index, i + 1))
  }
  return out
}

const files = walk(ROOT)
  .filter((f) => /['"]pagehide['"]/.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))

describe('page-exit writes outlive the page', () => {
  it('every module with a pagehide handler is classified', () => {
    expect(files.filter((f) => !(f in KNOWN))).toEqual([])
    expect(Object.keys(KNOWN).filter((f) => !files.includes(f))).toEqual([])
  })

  it.each(files)('%s: a raw write fetch carries keepalive', (file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const bad = fetchCalls(src).filter((c) => /method:\s*['"`](POST|PUT|PATCH|DELETE)/.test(c) && !/keepalive/.test(c))
    expect(bad).toEqual([])
    if (KNOWN[file] === 'raw') expect(/keepalive:\s*true|sendBeacon\(/.test(src)).toBe(true)
  })
})
