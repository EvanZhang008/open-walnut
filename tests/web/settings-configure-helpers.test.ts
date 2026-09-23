/**
 * Pure helpers behind the Configure panes of /settings (General, Tasks,
 * Sessions, Engines, Hooks, Advanced, API provider, Triage, Search), plus the
 * one-at-a-time write queue those panes share.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement as h } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import type { Config } from '../../src/core/types.js'
import { developerKeyFor, useSerialSave, type BuildPatch, type SaveOpts } from '../../web/src/components/settings/sections/GeneralSection.js'
import { firstSentence, paneSettingLabel } from '../../web/src/components/settings/sections/EngineSettingRows.js'
import { chunkRows, engineOwnerName, hostTagOf } from '../../web/src/components/settings/sections/EnginesSection.js'
import { toggleMode } from '../../web/src/components/settings/sections/SessionsSection.js'
import { toggleSource } from '../../web/src/components/settings/sections/TriageSection.js'
import { parseExcludedFolders } from '../../web/src/components/settings/sections/SearchSection.js'
import { gitSummary, keepAwakeSummary } from '../../web/src/components/settings/sections/AdvancedSection.js'
import { providerDisplayName, providersSummary, testResultText } from '../../web/src/components/settings/sections/ProvidersSection.js'
import { jevTestText } from '../../web/src/components/settings/sections/JevSettings.js'
import { unknownProjectWarning } from '../../web/src/components/settings/sections/TasksSection.js'
import { hookDisplayName, hookGroupOf, hookTag } from '../../web/src/components/settings/sections/HooksSection.js'
import { defaultRunnerName, usesHelp } from '../../web/src/components/settings/sections/SmartTaskCreation.js'

const DASH = /[—–]/

describe('engine rows', () => {
  it('shows the first sentence, skipping code spans and abbreviations', () => {
    expect(firstSentence('Picks a model. Also more.')).toBe('Picks a model.')
    expect(firstSentence('Use e.g. opus here. Second.')).toBe('Use e.g. opus here.')
    expect(firstSentence('Set `a. b` first. Then.')).toBe('Set `a. b` first.')
    expect(firstSentence('No period')).toBe('No period')
  })

  it('names the owner of a bare model label', () => {
    expect(paneSettingLabel('Default model', 'Claude Code')).toBe('Claude Code model')
    expect(paneSettingLabel('Model', 'Codex')).toBe('Codex model')
    expect(paneSettingLabel('Effort', 'Codex')).toBe('Effort')
    expect(paneSettingLabel('Model', undefined)).toBe('Model')
    expect(paneSettingLabel('Default model', engineOwnerName('claude', 'Claude'))).toBe('Claude Code model')
    expect(engineOwnerName('codex', 'Codex')).toBe('Codex')
  })

  it('chunks long groups at ten rows and words host tags plainly', () => {
    const rows = Array.from({ length: 23 }, (_, i) => i)
    expect(chunkRows(rows).map((c) => c.length)).toEqual([8, 8, 7]) // N12: balanced, no lone tail
    expect(chunkRows([])).toEqual([])
    expect(hostTagOf('connected').text).toBe('Reachable')
    expect(hostTagOf('error').text).toBe('Offline')
    expect(hostTagOf('testing').text).toBe('Checking')
  })
})

describe('lists that must never be empty or reordered', () => {
  it('keeps at least one session mode', () => {
    const one = toggleMode(['bypass'] as never[], 'bypass' as never, false)
    expect(one).toEqual(['bypass'])
  })

  it('toggles triage sources in canonical order', () => {
    expect(toggleSource(['slack'], 'mail', true)).toEqual(['mail', 'slack'])
    expect(toggleSource(['mail', 'slack'], 'mail', false)).toEqual(['slack'])
    expect(toggleSource(['mail'], 'mail', false)).toEqual([])
  })

  it('normalizes excluded folders', () => {
    expect(parseExcludedFolders(' /Archive/ ,archive\nPrivate//')).toEqual(['Archive', 'Private'])
    expect(parseExcludedFolders(' , \n')).toEqual([])
  })
})

describe('summaries and result lines are plain words', () => {
  it('summarizes keep awake and git', () => {
    expect(keepAwakeSummary(false, null)).toBe('Off')
    expect(keepAwakeSummary(true, { needsSudo: true, setupDone: false, holding: false } as never)).toBe('Needs setup')
    expect(keepAwakeSummary(true, { needsSudo: false, setupDone: true, holding: true } as never)).toBe('Active')
    expect(keepAwakeSummary(true, { needsSudo: false, setupDone: true, holding: false } as never)).toBe('On')
    expect(gitSummary(true, false)).toBe('Auto commit on, push off')
  })

  it('summarizes the API provider and connection tests', () => {
    expect(providersSummary('claude', undefined)).toBe('Off')
    expect(providersSummary('custom', 'OpenRouter')).toBe('On, OpenRouter')
    expect(providersSummary(undefined, undefined)).toBe('')
    expect(testResultText({ kind: 'ok', ms: 42 })).toBe('Connected in 42 ms')
    expect(testResultText({ kind: 'fail', error: 'timeout' })).toBe("Couldn't connect: timeout")
    expect(testResultText({ kind: 'idle' })).toBeNull()
    expect(jevTestText({ kind: 'ok', ms: 12.6, model: 'x' })).toBe('Connected in 13 ms')
    expect(jevTestText({ kind: 'fail', error: 'no key' })).toBe("Couldn't connect: no key")
    // N3-27: the server's snake_case sentence becomes plain words.
    expect(jevTestText({ kind: 'fail', error: 'not configured (missing or unresolvable api_key)' })).toBe('Add an API key first.')
  })

  it('warns about an unknown default project only once projects are loaded', () => {
    const known = (n: string) => n === 'Home'
    expect(unknownProjectWarning('Home', true, known)).toBeNull()
    expect(unknownProjectWarning('Garden', false, known)).toBeNull()
    expect(unknownProjectWarning(' Garden ', true, known)).toBe('No project named "Garden" yet; the next quick add creates it.')
    expect(unknownProjectWarning('', true, known)).toBeNull()
  })

  it('groups, names and tags hooks', () => {
    expect(hookGroupOf({ runtime: 'daemon', source: 'daemon-policy' } as never)).toBe('daemon')
    expect(hookGroupOf({ runtime: 'server', source: 'builtin' } as never)).toBe('walnut')
    expect(hookGroupOf({ runtime: 'server', source: 'config' } as never)).toBe('yours')
    expect(hookDisplayName('Turn retry (daemon:turn-result)')).toBe('Turn retry')
    expect(hookDisplayName('(only parens)')).toBe('(only parens)')
    expect(hookTag({ source: 'daemon-policy' } as never)).toBe('Daemon policy')
    expect(hookTag({ source: 'config' } as never)).toBeNull()
  })

  it('names who answers smart task creation', () => {
    expect(defaultRunnerName(undefined)).toBe('Claude Code')
    expect(defaultRunnerName('claude_cli')).toBe('Claude Code')
    // F14: an id this build does not know is never shown raw.
    expect(defaultRunnerName('some-new-api')).toBe('Your API')
    expect(usesHelp('default' as never, 'some-new-api')).toBe('Slow: each guess calls your API once.')
    expect(providerDisplayName('some-new-api')).toBe('an unknown provider')
    expect(providerDisplayName('openrouter')).toBe('OpenRouter')
    expect(usesHelp('default' as never, 'claude_cli')).toBe('Slow: each guess starts Claude Code once.')
    expect(usesHelp('jev' as never, 'claude_cli')).toBe('Under a second, fractions of a cent.')
  })

  it('never uses a dash in these strings', () => {
    const all = [
      gitSummary(false, true), providersSummary('custom', 'X'), usesHelp('default' as never, 'openrouter'),
      unknownProjectWarning('A', true, () => false) ?? '', testResultText({ kind: 'fail', error: 'e' }) ?? '',
    ]
    for (const s of all) expect(s).not.toMatch(DASH)
    expect(developerKeyFor('heartbeat' as never)).toBe('show_ui_only_heartbeat')
  })
})

describe('useSerialSave', () => {
  /** Mount once through SSR to get the queue function the hook returns. */
  function queueFor(config: Config, onSave: (p: Partial<Config>, o?: SaveOpts) => Promise<void>) {
    let save: ((b: BuildPatch, o?: SaveOpts) => Promise<void>) | null = null
    function Probe() {
      save = useSerialSave(config, onSave)
      return null
    }
    renderToStaticMarkup(h(Probe))
    return save!
  }

  afterEach(() => { vi.useRealTimers() })

  it('runs one write at a time and builds each from the config current when it runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const log: string[] = []
    let release: (() => void) | null = null
    const onSave = async (p: Partial<Config>) => {
      log.push(`start ${JSON.stringify(p)}`)
      if (!release) await new Promise<void>((r) => { release = r })
      log.push('end')
    }
    const config = { triage: { enabled: false } } as unknown as Config
    const save = queueFor(config, onSave)
    const built: string[] = []
    const first = save((c) => { built.push('first'); return { triage: { ...c.triage, enabled: true } } as Partial<Config> })
    const second = save((c) => { built.push('second'); return { triage: { ...c.triage, every: '45m' } } as Partial<Config> })
    await vi.advanceTimersByTimeAsync(10)
    // The second patch is not even built while the first is in flight.
    expect(built).toEqual(['first'])
    release!()
    await first
    // This probe never re-renders, so the page still shows the config the first save
    // was built on: the second waits for the refreshed render, up to its cap.
    await vi.advanceTimersByTimeAsync(2_900)
    expect(built).toEqual(['first'])
    await vi.advanceTimersByTimeAsync(200)
    await Promise.all([first, second])
    expect(built).toEqual(['first', 'second'])
    expect(log.filter((l) => l === 'end')).toHaveLength(2)
    expect(log.indexOf('end')).toBeLessThan(log.findIndex((l) => l.includes('45m')))
  })

  it('a failed write does not block the next one', async () => {
    let calls = 0
    const save = queueFor({} as Config, async () => {
      calls += 1
      if (calls === 1) throw new Error('disk full')
    })
    await expect(save(() => ({}))).rejects.toThrow('disk full')
    await expect(save(() => ({}))).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })
})
