/**
 * Copy and path helpers of the engine settings popover
 * (web/src/utils/engine-settings-copy.ts):
 *
 * 1. shortenCwd keeps the segment that tells repos apart and never
 * guesses the home directory;
 * 2. savedSentence: the six landing sentences, five gitExclude outcomes with
 * `failed` carrying the server's reason, none naming the exclude file;
 * 3. otherGroupsLink is built from the response;
 * 4. filterSettingRows: label/key hits win, help is the fallback with marks;
 * 5. the one-line sentences and their two branches.
 */
import { describe, expect, it } from 'vitest'
import type {
  EngineSettingView,
  EngineSettingsFileView,
  EngineSettingsGroupView,
  EngineSettingsWriteResult,
  GitExcludeOutcome,
} from '../../web/src/api/engine-settings'
import {
  aboutScopeLine,
  appliesOnSentence,
  dialogAriaLabel,
  emptySentence,
  envUncheckedSentence,
  filterSettingRows,
  hostLabel,
  menuActionTitle,
  noMatchSentence,
  otherGroupsLink,
  projectFileRelative,
  projectFileShort,
  savedSentence,
  scopeSentence,
  scopeStorageKey,
  SETTINGS_ENGINES_LINK,
  scopeUnavailableReason,
  shortenCwd,
  shortenUnderCwd,
  splitCwdShort,
} from '../../web/src/utils/engine-settings-copy'

const DASHES = /[\u2013\u2014]/

describe('shortenCwd', () => {
  it('keeps a short path as it is', () => {
    expect(shortenCwd('~/work/repo-a/services/api')).toBe('~/work/repo-a/services/api')
  })

  it('keeps the head segments that tell repo-a and repo-b apart, then fills the budget head first', () => {
    const a = shortenCwd('~/work/repo-a/services/api/internal/handlers/v2/users/profile')
    const b = shortenCwd('~/work/repo-b/services/api/internal/handlers/v2/users/profile')
    expect(a).toBe('~/work/repo-a/services/api/internal/…/profile')
    expect(b).toBe('~/work/repo-b/services/api/internal/…/profile')
    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(48)
    // The contract's own example, with a max that forces the minimal shape.
    expect(shortenCwd('~/work/repo-a/services/api', 20)).toBe('~/work/repo-a/…/api')
    expect(shortenCwd('~/work/repo-b/services/api', 20)).toBe('~/work/repo-b/…/api')
  })

  it('an opaque head (a temp dir) gives the budget to the tail, so the repo still shows', () => {
    const tmp = '/var/folders/ph/qftcnrrx0wb8n18r4j_pd9m00000gq/T/walnut-browser-abc123/projects/work'
    const a = shortenCwd(`${tmp}/repo-a/services/api`)
    const b = shortenCwd(`${tmp}/repo-b/services/api`)
    expect(a).toBe('/var/folders/ph/…/work/repo-a/services/api')
    expect(b).toBe('/var/folders/ph/…/work/repo-b/services/api')
  })

  it('still too long after that: the tail is trimmed with an ellipsis, within max', () => {
    const out = shortenCwd('~/work/repo-a/services/a-really-long-final-directory-name-that-goes-on', 30)
    expect(out.length).toBeLessThanOrEqual(30)
    expect(out.endsWith('…')).toBe(true)
    expect(out.startsWith('~/work/repo-a/…/')).toBe(true)
  })

  it('never guesses home: absolute stays absolute, tilde stays tilde', () => {
    expect(shortenCwd('/Users/someone/work/repo-a/services/api/internal/handlers')).toBe('/Users/someone/work/repo-a/services/…/handlers')
    const deep = shortenCwd('~/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/aa/bb')
    expect(deep.startsWith('~/a/b/')).toBe(true)
    expect(deep.endsWith('/…/bb')).toBe(true)
    expect(deep.length).toBeLessThanOrEqual(48)
  })

  it('a path with three segments or fewer only gets its tail trimmed', () => {
    const out = shortenCwd('/one-very-long-segment-name-here/two-very-long-segment-name-here/three', 40)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('hostLabel and titles', () => {
  it('hostLabel names this machine for the local host and echoes an alias', () => {
    expect(hostLabel('__local__')).toBe('This Mac')
    expect(hostLabel(undefined)).toBe('This Mac')
    expect(hostLabel('')).toBe('This Mac')
    expect(hostLabel('devbox')).toBe('devbox')
  })

  it('menuActionTitle uses the host label verbatim mid-sentence, the one rule every sentence shares', () => {
    expect(menuActionTitle('Claude Code', '~/work/app', 'This Mac')).toBe('Claude Code settings for sessions in ~/work/app on This Mac')
    expect(menuActionTitle('Codex', '~/work/app', 'devbox')).toBe('Codex settings for sessions in ~/work/app on devbox')
  })

  it('dialogAriaLabel: sessions here, or new sessions when changes need a restart', () => {
    expect(dialogAriaLabel('Claude Code', '~/work/app', 'This Mac', 'next-turn')).toBe('Claude Code settings for sessions in ~/work/app on This Mac')
    expect(dialogAriaLabel('Claude Code', '~/work/app', 'devbox', undefined)).toBe('Claude Code settings for sessions in ~/work/app on devbox')
    expect(dialogAriaLabel('Codex', '~/work/app', 'This Mac', 'new-session')).toBe('Codex settings for new sessions in ~/work/app')
  })

  it('a session without a working directory drops the "in <cwd>" clause instead of leaving a hole', () => {
    expect(menuActionTitle('Claude Code', '', 'This Mac')).toBe('Claude Code settings for sessions on This Mac')
    expect(dialogAriaLabel('Claude Code', '', 'devbox', 'next-turn')).toBe('Claude Code settings for sessions on devbox')
    expect(dialogAriaLabel('Codex', '', 'This Mac', 'new-session')).toBe('Codex settings for new sessions')
    for (const s of [menuActionTitle('X', '', 'This Mac'), dialogAriaLabel('X', '', 'This Mac', undefined)]) {
      expect(s).not.toMatch(/ {2}/)
      expect(s).not.toContain(' in ')
    }
  })
})

const CWD = '/Users/someone/work/repo-a/services/api/internal/handlers'
const CWD_SHORT = shortenCwd(CWD)

const FILES: EngineSettingsFileView[] = [
  { id: 'user', path: '/Users/someone/.claude/settings.json', label: 'user settings', format: 'json', scope: 'user', readOnly: false, exists: true },
  { id: 'project-shared', path: `${CWD}/.claude/settings.json`, label: 'this project (shared)', format: 'json', scope: 'project', readOnly: true, exists: false },
  { id: 'project-local', path: `${CWD}/.claude/settings.local.json`, label: 'this project (local)', format: 'json', scope: 'project', readOnly: false, exists: true },
]

function row(key: string, label: string, help: string, target: string): EngineSettingView {
  const file = FILES.find((f) => f.id === target)!
  return {
    key, label, help, type: 'boolean', default: false, scope: 'sessions', file: 'user', value: true, source: 'file',
    writeTarget: { file: target, path: file.path, holds: true },
  }
}

function result(target: string, gitExclude?: EngineSettingsWriteResult['gitExclude']): EngineSettingsWriteResult {
  return {
    engine: 'claude', displayName: 'Claude Code', host: '__local__', envChecked: true, cwd: CWD,
    scope: target === 'user' ? 'default' : 'project', projectScopeAvailable: true, files: FILES,
    groups: [{ id: 'sessions', title: 'Sessions', help: '', items: [row('verbose', 'Verbose output', '', target)] }],
    changed: ['verbose'], gitExclude,
  }
}

describe('savedSentence (spec 6.6)', () => {
  it('default scope, landed in the user file: all projects on that host', () => {
    expect(savedSentence({ result: result('user'), scope: 'default', hostLabel: 'This Mac', cwdShort: CWD_SHORT, files: FILES }))
      .toBe('Saved to user settings on This Mac (all projects).')
  })

  it('default scope, but the row\'s write target is a project file: names it and the directory', () => {
    expect(savedSentence({ result: result('project-local'), scope: 'default', hostLabel: 'devbox', cwdShort: CWD_SHORT, files: FILES }))
      .toBe(`Saved to this project (local), ${CWD_SHORT} only.`)
  })

  it('project scope with no gitExclude (the file already existed)', () => {
    expect(savedSentence({ result: result('project-local'), scope: 'project', hostLabel: 'This Mac', cwdShort: CWD_SHORT, files: FILES }))
      .toBe(`Saved to this project (local), ${CWD_SHORT} only.`)
  })

  it('five gitExclude outcomes: each says what happened, none names the exclude file', () => {
    const created = `${CWD_SHORT}/.claude/settings.local.json`
    const base = `Saved to this project (local), ${CWD_SHORT} only.`
    const expected: Record<GitExcludeOutcome, string> = {
      added: `${base} Created ${created} and kept it out of git (this repo's exclude list).`,
      already: `${base} Created ${created}; git already ignores it.`,
      'not-a-repo': `${base} Created ${created}; this directory is not a git checkout.`,
      unavailable: `${base} Created ${created} but could not update this repo's exclude list on this host; add it by hand.`,
      failed: `${base} Created ${created} but could not update this repo's exclude list: EACCES: permission denied`,
    }
    for (const outcome of Object.keys(expected) as GitExcludeOutcome[]) {
      const gitExclude = { path: `${CWD}/.claude/settings.local.json`, outcome, error: outcome === 'failed' ? 'EACCES: permission denied' : undefined }
      const sentence = savedSentence({ result: result('project-local', gitExclude), scope: 'project', hostLabel: 'This Mac', cwdShort: CWD_SHORT, files: FILES })
      expect(sentence, outcome).toBe(expected[outcome])
      expect(sentence).not.toContain('.git/info/exclude')
      expect(sentence).not.toMatch(DASHES)
    }
  })

  it('a default-scope save that created a project file still says so, git answer included', () => {
    const gitExclude = { path: `${CWD}/.claude/settings.local.json`, outcome: 'added' as const }
    expect(savedSentence({ result: result('project-local', gitExclude), scope: 'default', hostLabel: 'This Mac', cwdShort: CWD_SHORT, files: FILES }))
      .toBe(`Saved to this project (local), ${CWD_SHORT} only. Created ${CWD_SHORT}/.claude/settings.local.json and kept it out of git (this repo's exclude list).`)
    // A user-file write never carries gitExclude; if a server ever sent one, the user sentence stays.
    expect(savedSentence({ result: result('user', gitExclude), scope: 'default', hostLabel: 'This Mac', cwdShort: CWD_SHORT, files: FILES }))
      .toBe('Saved to user settings on This Mac (all projects).')
  })

  it('the created path is shortened under the cwd, and a relative one is joined to it', () => {
    expect(shortenUnderCwd(`${CWD}/.claude/settings.local.json`, CWD, CWD_SHORT)).toBe(`${CWD_SHORT}/.claude/settings.local.json`)
    expect(shortenUnderCwd('.claude/settings.local.json', CWD, CWD_SHORT)).toBe(`${CWD_SHORT}/.claude/settings.local.json`)
    expect(shortenUnderCwd('/elsewhere/x.json', CWD, CWD_SHORT)).toBe('/elsewhere/x.json')
    expect(shortenUnderCwd(`${CWD}/.claude/settings.local.json`, `${CWD}/`, CWD_SHORT)).toBe(`${CWD_SHORT}/.claude/settings.local.json`)
  })

  it('projectFileShort names the writable project file from the view, or nothing', () => {
    expect(projectFileShort(FILES, CWD, CWD_SHORT)).toBe(`${CWD_SHORT}/.claude/settings.local.json`)
    expect(projectFileShort(FILES.filter((f) => f.scope === 'user'), CWD, CWD_SHORT)).toBeUndefined()
  })
})

function group(id: string, title: string, n: number): EngineSettingsGroupView {
  const items = Array.from({ length: n }, (_, i) => row(`${id}.${i}`, `${title} ${i}`, '', 'user'))
  return { id, title, help: '', items }
}

describe('removedSentence via savedSentence op=unset', () => {
  const after = (item: Partial<EngineSettingView>): EngineSettingsWriteResult => {
    const base = result('project-local')
    const fresh = { ...base.groups[0].items[0], ...item, writeTarget: { file: 'project-local', path: FILES[2].path, holds: false } }
    return { ...base, groups: [{ ...base.groups[0], items: [fresh] }] }
  }
  const input = (res: EngineSettingsWriteResult) => ({ result: res, scope: 'project' as const, op: 'unset' as const, hostLabel: 'This Mac', cwdShort: CWD_SHORT, files: FILES, key: 'verbose' })

  it('names the key, the file it left, and the layer whose value applies again', () => {
    expect(savedSentence(input(after({ source: 'file', file: 'user' }))))
      .toBe('Removed Verbose output from this project (local); the user settings value applies again.')
    expect(savedSentence(input(after({ source: 'overlay', overlay: { file: 'project-shared', path: FILES[1].path } }))))
      .toBe('Removed Verbose output from this project (local); the this project (shared) value applies again.')
    expect(savedSentence(input(after({ source: 'legacy', legacy: { file: 'legacy', path: '~/.claude.json' } }))))
      .toBe('Removed Verbose output from this project (local); the value from ~/.claude.json (older location) applies again.')
    expect(savedSentence(input(after({ source: 'default', value: null, defaultLabel: undefined }))))
      .toBe('Removed Verbose output from this project (local); the default applies again.')
    expect(savedSentence(input(after({ source: 'default', value: null, defaultLabel: 'decided by your plan' }))))
      .toBe('Removed Verbose output from this project (local); the default (decided by your plan) applies again.')
  })

  it('never says "Saved to" for a reset, whatever gitExclude came back', () => {
    const res = { ...after({ source: 'file', file: 'user' }), gitExclude: { path: `${CWD}/.claude/settings.local.json`, outcome: 'already' as const } }
    const sentence = savedSentence(input(res))
    expect(sentence.startsWith('Removed ')).toBe(true)
    expect(sentence).not.toContain('Saved to')
    expect(sentence).not.toContain('Created')
    expect(sentence).not.toMatch(DASHES)
  })

  it('op=set (and no op at all) keeps the saved sentence', () => {
    expect(savedSentence({ ...input(result('project-local')), op: 'set' })).toBe(`Saved to this project (local), ${CWD_SHORT} only.`)
  })
})

describe('otherGroupsLink', () => {
  it('Claude: two other groups, titles in response order joined by and, the real count', () => {
    const groups = [group('sessions', 'Sessions', 12), group('updates', 'Updates', 3), group('terminal', 'Terminal only', 9)]
    expect(otherGroupsLink(groups)).toBe('Updates and Terminal only settings (12) are in Settings › Engines')
  })

  it('Codex: one other group', () => {
    expect(otherGroupsLink([group('sessions', 'Sessions', 4), group('updates', 'Updates', 1)]))
      .toBe('Updates settings (1) are in Settings › Engines')
  })

  it('no other group with rows: a plain link', () => {
    expect(otherGroupsLink([group('sessions', 'Sessions', 4)])).toBe('Open Settings › Engines')
    expect(otherGroupsLink([group('sessions', 'Sessions', 4), group('terminal', 'Terminal only', 0)])).toBe('Open Settings › Engines')
    expect(otherGroupsLink([])).toBe('Open Settings › Engines')
  })

  it('no view yet: the neutral text, never a count or an "Open" it would flip away from', () => {
    expect(otherGroupsLink(null)).toBe('Settings › Engines')
    expect(SETTINGS_ENGINES_LINK).toBe('Settings › Engines')
  })
})

describe('filterSettingRows', () => {
  const ROWS = [
    row('alwaysThinkingEnabled', 'Thinking mode', 'Think before answering.', 'user'),
    row('planMode', 'Use auto mode during plan', 'Switches modes when a plan starts.', 'user'),
    row('dynamicWorkflows', 'Dynamic workflows', 'Steps are decided by your plan as it runs.', 'user'),
    row('verbose', 'Verbose output', 'Show every tool call in full.', 'user'),
  ]

  it('an empty query returns every row in order, no marks', () => {
    const out = filterSettingRows(ROWS, '   ')
    expect(out.items.map((r) => r.key)).toEqual(ROWS.map((r) => r.key))
    expect(out.helpMarks.size).toBe(0)
  })

  it('"think" matches the label only', () => {
    const out = filterSettingRows(ROWS, 'think')
    expect(out.items.map((r) => r.label)).toEqual(['Thinking mode'])
    expect(out.helpMarks.size).toBe(0)
  })

  it('"plan" hits a label, so the help-only row is left out', () => {
    const out = filterSettingRows(ROWS, 'PLAN')
    expect(out.items.map((r) => r.label)).toEqual(['Use auto mode during plan'])
    expect(out.helpMarks.size).toBe(0)
  })

  it('a word found only in help yields the row with mark ranges', () => {
    const out = filterSettingRows(ROWS, 'tool call')
    expect(out.items.map((r) => r.key)).toEqual(['verbose'])
    const marks = out.helpMarks.get('verbose')!
    expect(marks).toEqual([[11, 20]])
    expect(ROWS[3].help.slice(marks[0][0], marks[0][1])).toBe('tool call')
  })

  it('a key hit counts like a label hit', () => {
    expect(filterSettingRows(ROWS, 'dynamicwork').items.map((r) => r.key)).toEqual(['dynamicWorkflows'])
  })

  it('"zzzz" matches nothing', () => {
    const out = filterSettingRows(ROWS, 'zzzz')
    expect(out.items).toEqual([])
    expect(out.helpMarks.size).toBe(0)
    expect(noMatchSentence('zzzz')).toBe('No setting matches "zzzz".')
  })

  it('every occurrence in the help is marked', () => {
    const rows = [row('k', 'Label', 'a plan, another plan, a PLAN', 'user')]
    expect(filterSettingRows(rows, 'plan').helpMarks.get('k')).toEqual([[2, 6], [16, 20], [24, 28]])
  })
})

describe('one-line sentences', () => {
  it('appliesOnSentence: both branches and the silent one', () => {
    expect(appliesOnSentence('next-turn', 'Claude Code')).toBe("Applies on this session's next turn.")
    expect(appliesOnSentence('new-session', 'Codex')).toBe('Applies to new Codex sessions; this session keeps its current settings.')
    expect(appliesOnSentence(undefined, 'Codex')).toBeNull()
  })

  it('scopeSentence: one line each; default names the host, project the cwd-relative file', () => {
    expect(scopeSentence('default', 'Claude Code', 'This Mac'))
      .toBe('Saves to your user settings on This Mac, as Claude Code itself would.')
    expect(projectFileRelative(FILES, CWD)).toBe('.claude/settings.local.json')
    expect(scopeSentence('project', 'Claude Code', 'This Mac', projectFileRelative(FILES, CWD)))
      .toBe('Saves to .claude/settings.local.json in this project · not tracked by git.')
    // Without the view's file the sentence names no path: the client knows no engine's layout.
    expect(scopeSentence('project', 'Claude Code', 'This Mac'))
      .toBe('Saves to its local settings file in this project · not tracked by git.')
    // A project file NOT under the cwd stays as the server sent it.
    expect(projectFileRelative([{ ...FILES[2], path: '/elsewhere/settings.local.json' }], CWD)).toBe('/elsewhere/settings.local.json')
    expect(projectFileRelative(FILES.filter((f) => f.scope !== 'project'), CWD)).toBeUndefined()
  })

  it('envUncheckedSentence, scopeUnavailableReason, emptySentence, scopeStorageKey', () => {
    expect(envUncheckedSentence('devbox')).toBe("Environment variables on devbox were not checked: one set for the engine's processes there can take precedence over these files.")
    expect(scopeUnavailableReason({ cwd: undefined, displayName: 'Codex' })).toBe('This session has no working directory, so there is no project file to write.')
    expect(scopeUnavailableReason({ cwd: '/work/app', displayName: 'Codex' })).toBe('Codex keeps no per-project settings file.')
    expect(emptySentence('Codex')).toBe('Codex reports no settings that a running session reads. Its other settings are in Settings › Engines.')
    expect(scopeStorageKey('__local__', '/work/app')).toBe('walnut:engine-settings-scope:__local__:/work/app')
    // Per engine, so a Codex session never inherits a Claude Code memory for the same directory.
    expect(scopeStorageKey('__local__', '/work/app', 'claude')).toBe('walnut:engine-settings-scope:claude:__local__:/work/app')
    expect(scopeStorageKey('devbox', '/work/app', 'codex')).not.toBe(scopeStorageKey('devbox', '/work/app', 'claude'))
  })

  it('no sentence carries an em or en dash', () => {
    const all = [
      appliesOnSentence('next-turn', 'X'), appliesOnSentence('new-session', 'X'),
      scopeSentence('default', 'X', 'This Mac'), scopeSentence('project', 'X', 'This Mac', '.claude/x.json'),
      envUncheckedSentence('h'), scopeUnavailableReason({ cwd: undefined, displayName: 'X' }),
      scopeUnavailableReason({ cwd: '/a', displayName: 'X' }), emptySentence('X'), noMatchSentence('q'),
      menuActionTitle('X', '~/a', 'This Mac'), dialogAriaLabel('X', '~/a', 'This Mac', 'new-session'),
    ]
    for (const s of all) expect(s).not.toMatch(DASHES)
  })
})

describe('splitCwdShort', () => {
  it('splits a shortened path into a clippable head and a tail that keeps the repo', () => {
    expect(splitCwdShort('/var/folders/ph/…/projects/repo-a')).toEqual({ head: '/var/folders/ph/…/projects/', tail: 'repo-a' })
    expect(splitCwdShort('~/work/repo-b')).toEqual({ head: '~/work/', tail: 'repo-b' })
    const short = shortenCwd(CWD)
    expect(splitCwdShort(short)).toEqual({ head: short.slice(0, short.lastIndexOf('/') + 1), tail: 'handlers' })
  })

  it('a trimmed tail keeps its ellipsis; no slash or a bare root is all tail', () => {
    expect(splitCwdShort('/a/b/very-long-name…')).toEqual({ head: '/a/b/', tail: 'very-long-name…' })
    expect(splitCwdShort('repo')).toEqual({ head: '', tail: 'repo' })
    expect(splitCwdShort('/')).toEqual({ head: '', tail: '/' })
    expect(splitCwdShort('')).toEqual({ head: '', tail: '' })
  })

  it('head + tail is the original string, so the subtitle text never changes', () => {
    for (const p of ['/var/folders/ph/…/projects/repo-a', '~/x', 'plain', shortenCwd(CWD)]) {
      const { head, tail } = splitCwdShort(p)
      expect(head + tail).toBe(p)
    }
  })
})

describe('aboutScopeLine', () => {
  it('names the project file while the switch is on This project only', () => {
    expect(aboutScopeLine('project', 'Claude Code', 'This Mac', CWD_SHORT, FILES, CWD))
      .toBe(`With the switch on "This project only", every save from here goes to ${CWD_SHORT}/.claude/settings.local.json, created on first save and kept out of git. Other projects are unchanged.`)
  })

  it('names the user file and the per-project exception under the engine default', () => {
    const line = aboutScopeLine('default', 'Claude Code', 'devbox', CWD_SHORT, FILES, CWD)
    expect(line).toBe('With the switch on "Same as Claude Code", saves go to /Users/someone/.claude/settings.json on devbox, except the few keys Claude Code itself keeps per project; those go to this project\'s local file.')
    expect(line).not.toContain('/config')
    expect(line).not.toMatch(DASHES)
  })

  it('without a user file in the view it still says where, in words', () => {
    expect(aboutScopeLine('default', 'Codex', 'This Mac', '', [], undefined)).toContain('saves go to your user settings on This Mac')
  })
})
