import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../../web/src/utils/log.js'
import { resolvePane } from '../../web/src/components/settings/settings-routing.js'

const WEB_SRC = fileURLToPath(new URL('../../web/src', import.meta.url))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p)
  }
  return out
}

interface HashRef { file: string; hash: string }

/** Every place the app links into Settings by hash, as written in source. */
function settingsHashRefs(): HashRef[] {
  const refs: HashRef[] = []
  const patterns = [
    /settings#([A-Za-z0-9_-]+)/g, // '/settings#engines'
    /settingsHash:\s*'([A-Za-z0-9_-]+)'/g, // error suggestions
    /(?:onNavigateSettings|handleNavigateSettings)\('#([A-Za-z0-9_-]+)'\)/g, // setup banner
  ]
  for (const file of sourceFiles(WEB_SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const re of patterns) {
      for (const m of text.matchAll(re)) refs.push({ file: relative(WEB_SRC, file), hash: m[1] })
    }
    // Same-page links inside settings sections: `<a href="#providers">`.
    if (file.includes(join('components', 'settings'))) {
      for (const m of text.matchAll(/href="#([A-Za-z0-9_-]+)"/g)) refs.push({ file: relative(WEB_SRC, file), hash: m[1] })
    }
  }
  return refs
}

describe('settings deep links in the app', () => {
  afterEach(() => vi.restoreAllMocks())

  it('finds the known entry points (the scan itself works)', () => {
    const hashes = new Set(settingsHashRefs().map((r) => r.hash))
    for (const h of ['providers', 'engines', 'calendar', 'remote-hosts', 'plugin-store']) expect(hashes).toContain(h)
  })

  it('opens a real pane for every hash, never the unknown fallback', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const bad: string[] = []
    for (const ref of settingsHashRefs()) {
      const r = resolvePane(`#${ref.hash}`, [])
      if (!r.known || r.paneId === 'general') bad.push(`${ref.file}: #${ref.hash} -> ${r.paneId}`)
    }
    expect(bad).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})

/** Settings UI sources: SettingsPage plus everything under components/settings. */
function settingsSources(): string[] {
  return [join(WEB_SRC, 'pages', 'SettingsPage.tsx'), ...sourceFiles(join(WEB_SRC, 'components', 'settings'))]
}

/** Source with comments blanked out (strings kept), good enough for these scans. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length))
}

describe('settings source hygiene', () => {
  it('logs through the structured logger, never console', () => {
    const offenders = settingsSources()
      .filter((f) => /\bconsole\.(log|warn|error|info|debug)\(/.test(withoutComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(WEB_SRC, f))
    expect(offenders).toEqual([])
  })

  it('has no em or en dash in UI strings (C10)', () => {
    const offenders: string[] = []
    for (const f of settingsSources()) {
      const lines = withoutComments(readFileSync(f, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (/[\u2013\u2014]|&[mn]dash;/.test(line)) offenders.push(`${relative(WEB_SRC, f)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
