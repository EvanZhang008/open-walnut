/**
 * The pure rules behind settings-polish-panes.spec.ts (N3 ids are review items), so a
 * regression fails here before anyone opens the page.
 */
import { describe, expect, it } from 'vitest'
import { categorizeSettings } from '../../web/src/components/settings/sections/engine-setting-categories.js'
import { deviceNameForServer } from '../../web/src/components/settings/sections/device-name.js'
import { sttScanSummary } from '../../web/src/components/settings/sections/stt-scan-summary.js'
import { fieldOwnerFor } from '../../web/src/components/settings/plugin-config-fields.js'
import { truncateHint, HINT_MAX } from '../../web/src/components/settings/settings-filter.js'
import { groupShowsTags } from '../../web/src/components/settings/sections/HooksSection.js'
import { paneControlKind, textIsCode } from '../../web/src/components/settings/sections/EngineSettingRows.js'
import { fromMs, toMs } from '../../web/src/components/settings/sections/AdvancedSection.js'
import { providerStatusTag } from '../../web/src/components/settings/sections/ProvidersSection.js'
import { jevTestText } from '../../web/src/components/settings/sections/JevSettings.js'
import { permissionActionLabel, permissionTag } from '../../web/src/components/settings/sections/PermissionsSection.js'

const CLAUDE_SESSION_KEYS = [
  'alwaysThinkingEnabled', 'autoCompactEnabled', 'verbose', 'permissions.defaultMode', 'outputStyle', 'language',
  'model', 'fastMode', 'fileCheckpointingEnabled', 'switchModelsOnFlag', 'enableWorkflows',
  'workflowKeywordTriggerEnabled', 'workflowSizeGuideline', 'enableArtifact', 'precomputeCompactionEnabled',
  'useAutoModeDuringPlan', 'worktree.baseRef', 'teammateMode', 'dialogExpiry', 'crossSessionInbound', 'modelProposedGoals',
]

describe('N3-02: a long engine group splits under real topic headings', () => {
  const items = CLAUDE_SESSION_KEYS.map((key) => ({ key, label: key }))
  const cats = categorizeSettings('sessions', 'Sessions', items)

  it('never generates a "continued" heading and keeps every row', () => {
    expect(cats.map((c) => c.title)).toEqual(['Model', 'Replies', 'Context', 'Workflows', 'Safety'])
    expect(cats.some((c) => /continued/i.test(c.title))).toBe(false)
    expect(cats.flatMap((c) => c.items.map((i) => i.key)).sort()).toEqual([...CLAUDE_SESSION_KEYS].sort())
    expect(Math.max(...cats.map((c) => c.items.length))).toBeLessThanOrEqual(10)
  })

  it('leaves a short group alone and files an unknown key under Other', () => {
    expect(categorizeSettings('updates', 'Updates', [{ key: 'a', label: 'A' }]).map((c) => c.title)).toEqual(['Updates'])
    const extra = [...items, { key: 'somethingNew', label: 'Something new' }]
    expect(categorizeSettings('sessions', 'Sessions', extra).at(-1)).toMatchObject({ title: 'Other' })
  })
})

describe('N3-03: the placeholder device name pairs', () => {
  it('turns a name with spaces into the id the server accepts', () => {
    expect(deviceNameForServer('My iPhone')).toBe('My-iPhone')
    expect(deviceNameForServer('  Test   phone ')).toBe('Test-phone')
    // Accented letter as test data, escaped: the accent is dropped, not the letter.
    expect(deviceNameForServer('Caf\u00e9 phone')).toBe('Cafe-phone')
    expect(deviceNameForServer('!!!')).toBeNull()
    expect(deviceNameForServer('x'.repeat(80))?.length).toBe(64)
  })
})

describe('N3-05: the Voice scan ends in a sentence, never in silence', () => {
  const found = { found: true }
  const none = { found: false }
  const base = { ffmpeg: found, whisperCli: none, whisperServer: none, sherpaOnnxNode: none, homebrew: found, models: [], recommendation: null }
  it('names what it found, or says nothing was found', () => {
    expect(sttScanSummary(base as never)).toBe('No dictation engine found on this Mac.')
    expect(sttScanSummary({ ...base, whisperCli: found, models: [{}, {}] } as never)).toBe('Found whisper-cli, 2 Whisper models.')
  })
})

describe('N3-04: one place per setting', () => {
  it('hands the calendar choice keys to Calendar Accounts', () => {
    expect(fieldOwnerFor('calendar', 'hidden_calendar_ids')?.pane).toBe('calendar')
    expect(fieldOwnerFor('calendar', 'visible_calendar_ids')?.pane).toBe('calendar')
    expect(fieldOwnerFor('calendar', 'refresh_minutes')).toBeNull()
    expect(fieldOwnerFor('mail', 'hidden_calendar_ids')).toBeNull()
  })
})

describe('N3-13: match hints are cut on words with the match in view', () => {
  it('keeps a match near the start without a leading ...', () => {
    const cut = truncateHint("What Walnut's model calls cost, by day and by source", 14)
    expect(cut).toBe("What Walnut's model calls...")
    expect(cut.length).toBeLessThanOrEqual(HINT_MAX)
  })
  it('starts at the matched word when it is far in, and never ends mid-word', () => {
    const text = 'Scheduled copies of your Walnut data to an S3 bucket in another region.'
    const cut = truncateHint(text, text.indexOf('bucket'))
    expect(cut.startsWith('...bucket')).toBe(true)
    const words = text.split(' ')
    const inner = cut.replace(/^\.\.\./, '').replace(/\.\.\.$/, '').split(' ')
    for (const w of inner) expect(words.some((x) => x.startsWith(w))).toBe(true)
    expect(inner.every((w) => words.includes(w) || words.includes(`${w}.`))).toBe(true)
  })
})

describe('N3-11: a tag only when it tells rows apart', () => {
  it('hides a tag every row of the group shares', () => {
    expect(groupShowsTags([{ source: 'builtin' }, { source: 'inline' }] as never)).toBe(false)
    expect(groupShowsTags([{ source: 'daemon-policy' }, { source: 'daemon-policy' }] as never)).toBe(false)
    expect(groupShowsTags([{ source: 'builtin' }, { source: 'config' }] as never)).toBe(true)
  })
})

describe('N3-01, N3-07: the Engines row layout keys off the control it draws', () => {
  it('names the control kind', () => {
    expect(paneControlKind({ type: 'boolean', default: true } as never)).toBe('switch')
    expect(paneControlKind({ type: 'boolean', default: null } as never)).toBe('segmented')
    expect(paneControlKind({ type: 'select', options: [{ value: 'a', label: 'Auto' }, { value: 'b', label: 'On' }] } as never)).toBe('segmented')
    expect(paneControlKind({ type: 'select', options: Array.from({ length: 6 }, (_, i) => ({ value: `${i}`, label: `${i}` })) } as never)).toBe('select')
    expect(paneControlKind({ type: 'text' } as never)).toBe('text')
  })
  it('sets a language in the text font and a model id in mono', () => {
    expect(textIsCode({ key: 'language', label: 'Language' })).toBe(false)
    expect(textIsCode({ key: 'model', label: 'Default model' })).toBe(true)
  })
})

describe('N3-24: intervals in seconds and minutes, saved as milliseconds', () => {
  it('round-trips', () => {
    expect(fromMs(30_000, 1_000)).toBe(30)
    expect(fromMs(600_000, 60_000)).toBe(10)
    expect(toMs(10, 60_000)).toBe(600_000)
    expect(toMs(1.5, 1_000)).toBe(1_500)
    expect(fromMs(undefined, 1_000)).toBeUndefined()
    expect(toMs(undefined, 1_000)).toBeUndefined()
  })
})

describe('N3-26: a Ready tag says where the credential comes from', () => {
  const ready = (credential_source: string) => ({ status: 'ready', credential_source } as never)
  it('tells saved keys from keys found elsewhere', () => {
    expect(providerStatusTag({ api: 'bedrock' } as never, ready('access_keys'), false).text).toBe('Ready, using access keys found on this Mac')
    expect(providerStatusTag({ api: 'bedrock' } as never, ready('access_keys'), true).text).toBe('Ready, using the saved access keys')
    expect(providerStatusTag({ api: 'bedrock' } as never, ready('profile')).text).toBe('Ready, using an AWS profile')
  })
})

describe('N3-27: Jev errors in plain words', () => {
  it('never shows the snake_case field name', () => {
    const text = jevTestText({ kind: 'fail', error: 'not configured (missing or unresolvable api_key)' })
    expect(text).toBe('Add an API key first.')
    expect(text).not.toMatch(/_/)
  })
})

describe('N3-28: macOS Access names its action and what is known', () => {
  it('uses named actions', () => {
    expect(permissionActionLabel({ state: 'denied', optional: false } as never)).toBe('Open System Settings...')
    expect(permissionActionLabel({ state: 'not-determined', optional: false } as never)).toBe('Ask...')
    expect(permissionActionLabel({ state: 'not-determined', optional: true } as never)).toBe('Set up...')
    expect(permissionActionLabel({ state: 'granted' } as never)).toBeNull()
    expect(permissionTag({ state: 'unknown' } as never).text).toBe("Couldn't check")
  })
})

describe('N3-24: an untouched interval saves its exact milliseconds', () => {
  it('keeps 12345 and 700000 through the rounded display', () => {
    expect(toMs(fromMs(12_345, 1_000), 1_000, 12_345)).toBe(12_345)
    expect(toMs(fromMs(700_000, 60_000), 60_000, 700_000)).toBe(700_000)
    // A value the user typed wins over the stored one.
    expect(toMs(20, 1_000, 12_345)).toBe(20_000)
  })
})
