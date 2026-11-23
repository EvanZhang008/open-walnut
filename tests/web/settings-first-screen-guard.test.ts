/**
 * 2026-11-22, the UI audit's second look: three panes lost what their first screen showed.
 * - Settings > Sessions: the default model and effort rows (three lines of help each, an "as last
 *   seen" line) and the default mode row stacked under its help pushed the engine checkboxes off.
 *   Every row above them keeps a help of one short line; the rest opens under it from the row's
 *   "More" (SettingsRow `more`). Its third look: the rest moved into a `title` hover lost Default
 *   effort's last seen efforts and what "Wait for the reset" means, so a hover alone is refused.
 * - Remote Hosts: one live host's card stretched across the pane put its rings 300px apart and
 *   pushed Details down. A card as wide as the pane reads in two columns.
 * The Org list's fold of six Directors is guarded in org-leaders.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '../..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

/** One line of help beside a select in the 680px pane: about this many characters. */
const ONE_LINE = 72

/** Every string literal a row's `help` can show, with the line it sits on. */
function helpStrings(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = []
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf('help=')
    if (at < 0) continue
    // The prop runs until the next prop of the row (a line starting `name=`) or the row's end.
    let body = lines[i].slice(at + 5)
    for (let j = i + 1; j < lines.length && !/^\s*(?:[a-zA-Z-]+=|\/?>|\{\.\.\.)/.test(lines[j]); j++) body += `\n${lines[j]}`
    for (const m of body.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)) {
      const text = (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, '')
      if (/[a-z]{3,} /i.test(text)) out.push({ text, line: i + 1 })
    }
  }
  return out
}

describe('Settings > Sessions keeps the engine checkboxes on the first screen', () => {
  // The rows above "Engines in the model picker", in the pane's order.
  const rows = [
    'web/src/components/settings/sections/DefaultEngineRow.tsx',
    'web/src/components/settings/sections/ClaudeLaunchDefaultsRow.tsx',
    'web/src/components/settings/sections/ClaudeDefaultModeRow.tsx',
  ]
  // A warning a person's own entry raises may take a second line: it is shown only then.
  const warnings = [/is not a model Claude Code lists here/]

  it('every help above them is one short line', () => {
    const long: string[] = []
    for (const f of rows) {
      for (const h of helpStrings(read(f))) {
        if (warnings.some((w) => w.test(h.text))) continue
        if (h.text.length > ONE_LINE) long.push(`${f}:${h.line} (${h.text.length}) ${h.text}`)
      }
    }
    expect(long).toEqual([])
  })

  // 2026-11-23, the audit's live check: at 1280x800 the Share new tasks card above them (five rows,
  // grey while it is off) pushed the checkboxes under the fold again. They follow the defaults.
  it('the checkboxes come right after the defaults group, before Share new tasks', () => {
    const src = read('web/src/components/settings/sections/SessionsSection.tsx')
    const body = src.slice(src.indexOf('<SettingsSection id="sessions"'))
    const firstGroupEnd = body.indexOf('</SettingsGroup>')
    const picker = body.indexOf('<PickerEnginesGroup')
    const split = body.indexOf('<EngineSplitRow')
    expect(picker).toBeGreaterThan(firstGroupEnd)
    expect(body.slice(firstGroupEnd + '</SettingsGroup>'.length, picker)).not.toMatch(/<[A-Z]/)
    expect(split).toBeGreaterThan(picker)
  })

  it('the When it is out of usage row says it in one line', () => {
    const src = read('web/src/components/settings/sections/FallbackEngineRow.tsx')
    const help = src.match(/data-testid="fallback-engine-help">([^<]*)</)
    expect(help?.[1]).toBeTruthy()
    expect(help![1].length).toBeLessThanOrEqual(ONE_LINE)
  })

  it('the default mode row puts its fields beside the label when they fit, never always under it', () => {
    const src = read('web/src/components/settings/sections/ClaudeDefaultModeRow.tsx')
    expect(src).not.toMatch(/settings-row-stacked/)
    expect(src).toMatch(/className="settings-row-wraps"/)
    expect(read('web/src/styles/settings-rows.css')).toMatch(/\.settings-row\.settings-row-wraps\s*\{[^}]*flex-wrap: wrap/)
  })

  it('what a row\'s one line leaves out opens on the page from its More, never only a hover', () => {
    const fallback = 'web/src/components/settings/sections/FallbackEngineRow.tsx'
    for (const f of [...rows, fallback]) expect(read(f), f).not.toMatch(/^\s*title=/m)
    expect(read('web/src/components/settings/sections/ClaudeLaunchDefaultsRow.tsx'))
      .toMatch(/more=\{<>[\s\S]*?wins over it[\s\S]*?data-testid="default-claude-effort-observed"[\s\S]*?as last seen/)
    expect(read(fallback)).toMatch(/more=\{<span data-testid="fallback-engine-more">[\s\S]*?wait for the reset[\s\S]*?once its usage resets/)
    const row = read('web/src/components/settings/SettingsSection.tsx')
    expect(row).toMatch(/<DisclosureButton inline className="settings-row-more"[^>]*aria-controls=\{moreId\}/)
    expect(row).toMatch(/hasMore && moreOpen && <div className="settings-row-help settings-row-more-body" id=\{moreId\}/)
  })
})

describe('Remote Hosts: a card as wide as the pane reads in two columns', () => {
  const css = read('web/src/styles/host-fleet.css')
  it('the card is a size container and its body a grid of two columns when wide', () => {
    expect(css).toMatch(/\.hf-dash \.hf-card \{[^}]*container: hf-card \/ inline-size/)
    const wide = css.match(/@container hf-card \(min-width: (\d+)px\) \{([\s\S]*?)\n\}/)
    expect(wide).toBeTruthy()
    expect(Number(wide![1])).toBeLessThanOrEqual(700)
    expect(wide![2]).toMatch(/grid-template-columns: minmax\(0, 360px\) minmax\(0, 1fr\)/)
    for (const area of ['vitals', 'numbers', 'history']) expect(wide![2]).toMatch(new RegExp(`grid-area: ${area}`))
  })
  it('every part of the card sits in its body, so the columns hold them all', () => {
    const tsx = read('web/src/components/settings/sections/HostFleetCard.tsx')
    const card = tsx.slice(tsx.indexOf('<article className="hf-card"'), tsx.indexOf('</article>'))
    expect(card).toMatch(/^<article[^>]*>\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="hf-card-body">/)
    expect(card.trimEnd().endsWith('</div>')).toBe(true)
  })
})
