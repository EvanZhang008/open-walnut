import { describe, expect, it } from 'vitest'
import type { UpdateState } from '../../web/src/components/settings/plugin-update-types'
import {
  CLICK_TO_CHECK_SUFFIX,
  CLOUD_LINKED_NOTE,
  LINKED_SCAN_SKIPPED_NOTE,
  LOCK_TRANSIENT_NOTE,
  REASON_AUTH,
  REASON_DIRTY,
  REASON_DIVERGED,
  REASON_OFFLINE,
  RESTORE_TITLE,
  chipView,
  failureFeedback,
  nameList,
  npmToVersion,
  scrubReason,
  shortRemote,
  shortenHome,
  sourceShortLabel,
  resolveRowState,
  sharedCheckoutNote,
  successFeedback,
  updateButtonMode,
} from '../../web/src/components/settings/plugin-update-view'

const NOW = Date.parse('2026-09-13T12:00:00.000Z')
const MIN = 60_000
const checkedAt = new Date(NOW - 3 * MIN).toISOString()
const view = (state: UpdateState | undefined, extra: Partial<Parameters<typeof chipView>[1]> = {}) =>
  chipView(state, { checkedAt, now: NOW, ...extra })

/** Every state kind once, plus the variants the table distinguishes. */
const FIXTURES: Record<string, UpdateState> = {
  unchecked: { kind: 'unchecked' },
  uncheckedMoved: { kind: 'unchecked', reason: 'The checkout moved since the last check.' },
  uncheckedScan: { kind: 'unchecked', reason: LINKED_SCAN_SKIPPED_NOTE },
  checking: { kind: 'checking' },
  current: { kind: 'current' },
  currentAhead: { kind: 'current', ahead: 2 },
  available1: { kind: 'available', behind: 1 },
  available3: { kind: 'available', behind: 3 },
  availableNpm: { kind: 'available', toVersion: '@acme/plugin@1.3.0' },
  dirty: { kind: 'dirty' },
  dirtyBehind: { kind: 'dirty', behind: 3 },
  diverged: { kind: 'diverged', behind: 3, ahead: 2 },
  missing: { kind: 'missing' },
  unreachableNet: {
    kind: 'unreachable', cause: 'network', lastKnown: 'available',
    reason: 'ssh: Could not resolve hostname git.example.test',
  },
  unreachableNoLast: { kind: 'unreachable', cause: 'timeout', reason: 'Timed out after 8 s' },
  unreachableAuth: {
    kind: 'unreachable', cause: 'auth', lastKnown: 'current',
    reason: 'deploy@git.example.test: Permission denied (publickey,keyboard-interactive).',
  },
  unsupportedUpstream: { kind: 'unsupported', reason: 'This branch has no upstream', hint: 'Push it or set one, then check again.' },
  unsupportedDetached: {
    kind: 'unsupported', reason: 'The checkout is not on a branch.',
    hint: 'Check out a branch in the checkout, then check again.',
  },
}

describe('chipView renders the spec 4.1 table', () => {
  it('pending: blank, busy, not clickable, no title', () => {
    const v = view(undefined)
    expect(v).toMatchObject({ kind: 'pending', label: '', title: '', busy: true, clickable: false, icon: null })
    expect(v.modifiers).toEqual(['--pending'])
  })

  it('unchecked, checking, current, current with ahead', () => {
    expect(view(FIXTURES.unchecked)).toMatchObject({ kind: 'unchecked', label: 'Not checked', icon: 'circle-dashed', modifiers: ['--unchecked'] })
    expect(view(FIXTURES.unchecked).title).toBe(`Walnut has not checked this plugin yet.${CLICK_TO_CHECK_SUFFIX}`)
    expect(view(FIXTURES.checking)).toMatchObject({ kind: 'checking', label: 'Checking…', icon: 'spinner', busy: true, clickable: false, title: '' })
    expect(view(FIXTURES.current)).toMatchObject({ kind: 'current', label: 'Up to date', icon: 'check', modifiers: ['--current'] })
    expect(view(FIXTURES.current).title).toBe(`Same as the remote. Checked 3 min ago.${CLICK_TO_CHECK_SUFFIX}`)
    expect(view(FIXTURES.currentAhead).label).toBe('Up to date · 2 ahead')
    // Ahead is not "the same": the tooltip agrees with the label (N2-7), singular included.
    expect(view(FIXTURES.currentAhead).title).toBe(`Nothing newer on the remote; you have 2 commits it does not. Checked 3 min ago.${CLICK_TO_CHECK_SUFFIX}`)
    expect(view({ kind: 'current', ahead: 1 }).title).toContain('you have 1 commit it does not.')
    expect(view({ kind: 'current', ahead: 0 }).title).toContain('Same as the remote.')
  })

  it('available: git plural, singular, npm version via npmToVersion', () => {
    expect(view(FIXTURES.available3)).toMatchObject({ label: '3 commits behind', icon: 'arrow-up', modifiers: ['--available'] })
    expect(view(FIXTURES.available1).label).toBe('1 commit behind')
    expect(view(FIXTURES.available3, { toRef: 'a1b2c3d4e5f6' }).title).toBe(`Update moves this plugin to a1b2c3d.${CLICK_TO_CHECK_SUFFIX}`)
    const npm = view(FIXTURES.availableNpm)
    expect(npm.label).toBe('v1.3.0 available')
    expect(npm.label).not.toContain('@acme')
    expect(npm.title).toBe(`Update moves this plugin to v1.3.0.${CLICK_TO_CHECK_SUFFIX}`)
  })

  it('dirty and dirty with commits behind (C59), diverged, missing', () => {
    expect(view(FIXTURES.dirty)).toMatchObject({ label: 'Local changes', icon: 'pencil', modifiers: ['--dirty'] })
    expect(view(FIXTURES.dirty).title).toBe(`The checkout has uncommitted changes. Commit or stash them first.${CLICK_TO_CHECK_SUFFIX}`)
    expect(view(FIXTURES.dirtyBehind).label).toBe('3 behind · Local changes')
    expect(view(FIXTURES.dirtyBehind).title).toBe(`3 new commits on the remote. Commit or stash your changes to take them.${CLICK_TO_CHECK_SUFFIX}`)
    expect(view(FIXTURES.diverged)).toMatchObject({ label: '3 behind · 2 ahead', icon: 'arrows-up-down', modifiers: ['--diverged'] })
    expect(view(FIXTURES.diverged).title).toBe(`Both you and the remote have new commits. Rebase or merge in the checkout, then check again.${CLICK_TO_CHECK_SUFFIX}`)
    const missing = view(FIXTURES.missing)
    expect(missing).toMatchObject({ label: 'Not installed here', icon: 'slash-circle', modifiers: ['--missing'], clickable: false })
    expect(missing.title).toBe('The files for this plugin are not on this machine. Restore will clone them again.')
  })
})

describe('chipView: unreachable, unsupported, static, busy, transient', () => {
  it('unreachable (network) keeps the last known words with the stale modifier (C19)', () => {
    const v = view({ ...FIXTURES.unreachableNet, behind: 3 } as UpdateState)
    expect(v.kind).toBe('unreachable')
    expect(v.label).toBe('3 commits behind')
    expect(v.icon).toBe('arrow-up')
    expect(v.modifiers).toEqual(['--available', '--stale'])
    expect(v.stale).toBe(true)
    // The hostname is scrubbed from the tooltip too: it names a private remote as surely as a URL.
    expect(v.title).toBe(`Could not reach the remote just now. Last checked 3 min ago. ssh: Could not resolve hostname the remote.${CLICK_TO_CHECK_SUFFIX}`)
    expect(view(FIXTURES.unreachableNet).label).toBe('Update available')
    expect(view(FIXTURES.unreachableNoLast).label).toBe('Not checked')
    expect(view(FIXTURES.unreachableNoLast).modifiers).toEqual(['--unchecked', '--stale'])
  })

  it('unreachable keeps the number the server remembered: 1 COMMIT BEHIND, 1 behind · 1 ahead, v1.3.0 available (N2)', () => {
    expect(view({ kind: 'unreachable', cause: 'network', lastKnown: 'available', reason: 'x', behind: 1 }).label).toBe('1 commit behind')
    expect(view({ kind: 'unreachable', cause: 'timeout', lastKnown: 'diverged', reason: 'x', behind: 1, ahead: 1 }).label).toBe('1 behind · 1 ahead')
    expect(view({ kind: 'unreachable', cause: 'network', lastKnown: 'dirty', reason: 'x', behind: 2 }).label).toBe('2 behind · Local changes')
    expect(view({ kind: 'unreachable', cause: 'network', lastKnown: 'current', reason: 'x', ahead: 2 }).label).toBe('Up to date · 2 ahead')
    expect(view({ kind: 'unreachable', cause: 'network', lastKnown: 'available', reason: 'x', toVersion: '1.3.0' }).label).toBe('v1.3.0 available')
  })

  it('a long or raw reason in the stale tooltip is scrubbed and ends with an ellipsis before the suffix (N1)', () => {
    const raw = `Could not fetch: fatal: '/var/folders/zz/T/linked-origin.git' does not appear to be a git repository and then some more words ${'w'.repeat(60)}`
    const v = view({ kind: 'unreachable', cause: 'unknown', lastKnown: 'available', reason: raw, behind: 1 })
    expect(v.title).not.toMatch(/\/var\//)
    expect(v.title).not.toMatch(/fatal:/)
    expect(v.title).toContain("'linked-origin.git' does not appear to be a git repository")
    expect(v.title).toMatch(/…\.? Click to check again\.$/)
    expect(v.title.endsWith(CLICK_TO_CHECK_SUFFIX)).toBe(true)
  })

  it('unreachable (auth) is Sign-in needed with the renew sentence (C50)', () => {
    const v = view(FIXTURES.unreachableAuth)
    expect(v).toMatchObject({ label: 'Sign-in needed', icon: 'key', modifiers: ['--auth'], stale: false })
    expect(v.title).toBe(`Your credentials for this remote were refused. Renew them and check again.${CLICK_TO_CHECK_SUFFIX}`)
  })

  it('unsupported: Cannot compare with reason + hint (C66)', () => {
    expect(view(FIXTURES.unsupportedUpstream)).toMatchObject({ label: 'Cannot compare', icon: 'slash-circle', modifiers: ['--unsupported'] })
    expect(view(FIXTURES.unsupportedUpstream).title).toBe(`This branch has no upstream. Push it or set one, then check again.${CLICK_TO_CHECK_SUFFIX}`)
    expect(view(FIXTURES.unsupportedDetached).title).toBe(`The checkout is not on a branch. Check out a branch in the checkout, then check again.${CLICK_TO_CHECK_SUFFIX}`)
  })

  it('unchecked carries a server reason verbatim; the scan-skipped note keeps its own call to action (C30)', () => {
    expect(view(FIXTURES.uncheckedMoved).title).toBe(`The checkout moved since the last check.${CLICK_TO_CHECK_SUFFIX}`)
    expect(view(FIXTURES.uncheckedScan).title).toBe(LINKED_SCAN_SKIPPED_NOTE)
  })

  it('replica mode: static, not clickable, the cloud note as title (C68)', () => {
    const v = view(FIXTURES.current, { staticNote: CLOUD_LINKED_NOTE })
    expect(v.clickable).toBe(false)
    expect(v.title).toBe(CLOUD_LINKED_NOTE)
    expect(v.label).toBe('Up to date')
    expect(view(undefined, { staticNote: CLOUD_LINKED_NOTE }).label).toBe('Cannot compare')
  })

  it('busy overrides the state: Checking… / Updating…, never clickable', () => {
    expect(view(FIXTURES.available3, { busy: 'checking' })).toMatchObject({ kind: 'checking', label: 'Checking…', busy: true, clickable: false })
    expect(view(FIXTURES.available3, { busy: 'updating' })).toMatchObject({ kind: 'checking', label: 'Updating…', busy: true })
  })

  it('a transient lock keeps the words and swaps the tooltip', () => {
    const v = view(FIXTURES.available3, { transient: true })
    expect(v.label).toBe('3 commits behind')
    expect(v.title).toBe(`${LOCK_TRANSIENT_NOTE}${CLICK_TO_CHECK_SUFFIX}`)
  })
})

describe('chipView invariants over every fixture', () => {
  const all = Object.entries(FIXTURES)
  const NO_SUFFIX = new Set(['checking', 'missing', 'uncheckedScan'])

  it('every tooltip ends with the click-to-check suffix except checking, missing, pending, static and the scan note', () => {
    for (const [name, state] of all) {
      const v = view(state)
      if (NO_SUFFIX.has(name)) expect(v.title.endsWith(CLICK_TO_CHECK_SUFFIX), name).toBe(false)
      else expect(v.title.endsWith(CLICK_TO_CHECK_SUFFIX), name).toBe(true)
    }
    expect(view(undefined).title).toBe('')
  })

  it('no absolute path, no @host, no git command in any label, title or aria text (C18, C50)', () => {
    const banned = [/(^|\s)\/[A-Za-z0-9_.-]/, /\S+@\S+/, /\bgit\s+(fetch|pull|status|rev-|clone|push)/i, /\([a-z-]+(,[a-z-]+)+\)/]
    for (const [name, state] of all) {
      const v = view(state)
      const aria = `${v.label} (${v.title})`
      for (const text of [v.label, v.title, aria]) {
        for (const re of banned) expect(re.test(text), `${name}: ${text}`).toBe(false)
      }
    }
  })

  it('no text glyphs anywhere in labels or titles (C54); icons are named, not characters', () => {
    const glyphs = /[⚠✓✔✎⇅∅○◌ⓘℹ]/
    for (const [name, state] of all) {
      const v = view(state)
      expect(glyphs.test(v.label + v.title), name).toBe(false)
    }
  })

  it('no em or en dash in any copy', () => {
    for (const [name, state] of all) {
      const v = view(state)
      expect(/[\u2013\u2014]/.test(v.label + v.title), name).toBe(false)
    }
    for (const s of [REASON_DIRTY, REASON_DIVERGED, REASON_OFFLINE, REASON_AUTH, RESTORE_TITLE, CLOUD_LINKED_NOTE, LOCK_TRANSIENT_NOTE]) {
      expect(/[\u2013\u2014]/.test(s)).toBe(false)
    }
  })

  it('every non-pending view has data-update-kind equal to the state kind', () => {
    for (const [, state] of all) {
      const v = view(state)
      expect(v.kind).toBe(state.kind)
    }
  })
})

describe('updateButtonMode: the spec 6.3 three-state matrix', () => {
  it('primary only for available (Update) and missing (Restore)', () => {
    expect(updateButtonMode(FIXTURES.available3)).toEqual({ render: true, primary: true, label: 'Update' })
    expect(updateButtonMode(FIXTURES.availableNpm)).toEqual({ render: true, primary: true, label: 'Update' })
    expect(updateButtonMode(FIXTURES.missing)).toEqual({ render: true, primary: true, label: 'Restore', title: RESTORE_TITLE })
  })

  it('disabled with the spec 7 reason for dirty, diverged and unreachable-with-available', () => {
    expect(updateButtonMode(FIXTURES.dirty)).toEqual({ render: true, disabled: true, label: 'Update', reason: REASON_DIRTY })
    expect(updateButtonMode(FIXTURES.dirtyBehind)).toEqual({ render: true, disabled: true, label: 'Update', reason: REASON_DIRTY })
    expect(updateButtonMode(FIXTURES.diverged)).toEqual({ render: true, disabled: true, label: 'Update', reason: REASON_DIVERGED })
    expect(updateButtonMode(FIXTURES.unreachableNet)).toEqual({ render: true, disabled: true, label: 'Update', reason: REASON_OFFLINE })
    expect(updateButtonMode({ kind: 'unreachable', cause: 'auth', lastKnown: 'available', reason: 'x' }))
      .toEqual({ render: true, disabled: true, label: 'Update', reason: REASON_AUTH })
    expect(REASON_DIRTY).toBe('Commit or stash your changes in the checkout first.')
    expect(REASON_DIVERGED).toBe('Rebase or merge in the checkout, then check again.')
    expect(REASON_OFFLINE).toBe('Could not reach the remote. Check again when you are back online.')
  })

  it('not rendered for current, ahead, unchecked, checking, unsupported, pending and unreachable without available (C31)', () => {
    for (const state of [FIXTURES.current, FIXTURES.currentAhead, FIXTURES.unchecked, FIXTURES.checking,
      FIXTURES.unsupportedUpstream, FIXTURES.unreachableAuth, FIXTURES.unreachableNoLast, undefined]) {
      expect(updateButtonMode(state)).toEqual({ render: false })
    }
  })

  it('the row that is updating shows Updating… disabled, whatever its state; a sibling sharing the row key shows a disabled Update (N10)', () => {
    for (const state of [FIXTURES.available3, FIXTURES.current, undefined]) {
      expect(updateButtonMode(state, 'updating')).toEqual({ render: true, disabled: true, label: 'Updating…', reason: null })
      expect(updateButtonMode(state, 'updating', true)).toEqual({ render: true, disabled: true, label: 'Updating…', reason: null })
      expect(updateButtonMode(state, 'updating', false)).toEqual({ render: true, disabled: true, label: 'Update', reason: null })
    }
    // A check in flight keeps the button in place but dead until the answer lands (N3-12).
    expect(updateButtonMode(FIXTURES.available3, 'checking')).toEqual({ render: true, disabled: true, label: 'Update', reason: null })
  })
})

describe('feedback sentences (spec 7) use display names, never ids', () => {
  const nameOf = (id: string) => ({ 'acme-tracker': 'Acme Tracker', 'acme-notes': 'Acme Notes', 'acme-mail': 'Acme Mail' }[id] ?? id)
  const sha = 'a1b2c3d4e5f60718'

  it('linked: reloaded one, reloaded several, nothing running, already current', () => {
    expect(successFeedback('linked', { sha, updated: true, reloaded: ['acme-tracker'] }, nameOf))
      .toEqual({ kind: 'ok', text: 'Updated to a1b2c3d · reloaded Acme Tracker' })
    const many = successFeedback('linked', { sha, updated: true, reloaded: ['acme-tracker', 'acme-notes', 'acme-mail'] }, nameOf)
    expect(many.text).toBe('Updated to a1b2c3d · reloaded Acme Tracker and 2 more')
    expect(many.text).not.toContain('acme-')
    expect(successFeedback('linked', { sha, updated: true, reloaded: [], skipped: ['acme-notes'] }, nameOf).text)
      .toBe('Updated to a1b2c3d · nothing was running from it')
    expect(successFeedback('linked', { sha, updated: false, reloaded: [] }, nameOf).text).toBe('Already up to date at a1b2c3d')
  })

  it('linked: a reload failure is named and its raw error goes to detail', () => {
    const fb = successFeedback('linked', { sha, updated: true, reloaded: ['acme-notes'], failed: [{ id: 'acme-tracker', error: 'Error: boom\n  at x' }] }, nameOf)
    expect(fb.text).toBe('Updated to a1b2c3d · reloaded Acme Notes · Acme Tracker could not be reloaded.')
    expect(fb.detail).toContain('boom')
    expect(fb.text).not.toContain('at x')
  })

  it('git and npm sources: restart wording and version via npmToVersion', () => {
    expect(successFeedback('git', { updated: true, toSha: sha, restartRequired: true }, nameOf).text)
      .toBe('Updated to a1b2c3d · restart Walnut to run the new code')
    expect(successFeedback('git', { updated: true, toSha: sha, restartRequired: false }, nameOf).text).toBe('Updated to a1b2c3d · reloaded')
    expect(successFeedback('npm', { updated: true, resolved: '@acme/plugin@1.3.0' }, nameOf).text)
      .toBe('Updated to v1.3.0 · restart Walnut to run the new code')
    expect(successFeedback('npm', { updated: false, resolved: '@acme/plugin@1.3.0' }, nameOf).text).toBe('Already up to date at v1.3.0')
  })

  it('failures: 409 codes, timeout, and a capped scrubbed sentence with Details (C16, C17)', () => {
    expect(failureFeedback(409, { error: 'The checkout has uncommitted changes', code: 'dirty' }))
      .toEqual({ kind: 'error', text: 'Could not update: the checkout has uncommitted changes.' })
    expect(failureFeedback(409, { error: 'x', code: 'diverged' }).text).toBe('Could not update: your branch and the remote have both moved.')
    expect(failureFeedback(504, { error: 'Update timed out after 60 s.' }).text).toBe('Could not update: git did not finish in 60 s.')
    const long = failureFeedback(502, { error: `The remote refused the fetch. ${'x'.repeat(200)}`, detail: 'fatal: git stderr here' })
    expect(long.text.startsWith('Could not update: the remote refused the fetch.')).toBe(true)
    expect(long.text.length).toBeLessThanOrEqual('Could not update: '.length + 121)
    expect(long.text.endsWith('…')).toBe(true)
    expect(long.detail).toBe('fatal: git stderr here')
    expect(failureFeedback(500, { error: 'HEAD is detached' }).text).toBe('Could not update: HEAD is detached.')
    expect(failureFeedback(500, null).text).toBe('Could not update: the server returned an error.')
  })

  it('a git failure reads as one classifier sentence, and the raw text (path, host, fatal:) only in Details (N1)', () => {
    const raw = "git exited 1: fatal: '/var/folders/zz/T/linked-origin.git' does not appear to be a git repository\nfatal: Could not read from remote repository."
    // The server already classified it and sent the raw text as detail.
    const network = failureFeedback(502, { error: 'the remote could not be reached.', cause: 'network', detail: raw })
    expect(network).toEqual({ kind: 'error', text: 'Could not update: the remote could not be reached.', detail: raw })
    expect(failureFeedback(502, { error: 'x', cause: 'auth', detail: raw }).text).toBe('Could not update: your credentials for the remote were refused.')
    expect(failureFeedback(502, { error: 'x', cause: 'timeout', detail: raw }).text).toBe('Could not update: the remote could not be reached.')
    expect(failureFeedback(502, { error: 'x', cause: 'lock', detail: raw }).text).toBe('Could not update: another git command was running; try again.')
    // An old server (or a plain Error) sends the raw text as `error`: the client scrubs it and keeps it whole in Details.
    const legacy = failureFeedback(502, { error: raw })
    expect(legacy.text).toBe("Could not update: 'linked-origin.git' does not appear to be a git repository.")
    expect(legacy.detail).toBe(raw)
    const url = failureFeedback(502, { error: 'fatal: unable to access https://someone@git.example.test/acme/x.git/: Could not resolve host' })
    expect(url.text).toBe('Could not update: unable to access the remote: Could not resolve host.')
    expect(url.detail).toContain('https://')
    for (const text of [network.text, legacy.text, url.text]) {
      expect(text).not.toMatch(/(^|\s|')\/(Users|home|private|var|tmp|opt)\//)
      expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i)
      expect(text).not.toMatch(/\bgit (fetch|pull|status|rev-parse|merge|rebase|exited)\b|fatal:/)
    }
    // A plain sentence stays a sentence, with no Details invented for it.
    expect(failureFeedback(500, { error: 'The plugin could not be reloaded' })).toEqual({ kind: 'error', text: 'Could not update: the plugin could not be reloaded.' })
  })

  it('nameList: one, two, many', () => {
    expect(nameList([], nameOf)).toBe('')
    expect(nameList(['acme-tracker'], nameOf)).toBe('Acme Tracker')
    expect(nameList(['acme-tracker', 'acme-notes'], nameOf)).toBe('Acme Tracker and 1 more')
  })
})

describe('helpers: npmToVersion, scrubReason, shortRemote, shortenHome, sourceShortLabel', () => {
  it('npmToVersion strips the package name, scoped or not (C63)', () => {
    expect(npmToVersion('@acme/plugin@1.3.0')).toBe('1.3.0')
    expect(npmToVersion('acme-plugin@2.0.0')).toBe('2.0.0')
    expect(npmToVersion('1.3.0')).toBe('1.3.0')
    expect(npmToVersion('v1.3.0')).toBe('1.3.0')
  })

  it('scrubReason removes user@host prefixes, auth method lists, URLs, hosts, absolute paths and git framing; caps at 120 with an ellipsis (N1, C18)', () => {
    expect(scrubReason('deploy@git.example.test: Permission denied (publickey,keyboard-interactive).')).toBe('Permission denied')
    expect(scrubReason('fatal: unable to access https://tok:secret@git.example.test/acme/x.git/: Could not resolve host'))
      .toBe('unable to access the remote: Could not resolve host')
    expect(scrubReason("git exited 1: fatal: '/var/folders/zz/T/linked-origin.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\nPlease make sure you have the correct access rights."))
      .toBe("'linked-origin.git' does not appear to be a git repository")
    expect(scrubReason('ssh: connect to host git.example.test port 22: Connection refused')).toBe('ssh: connect to host the remote port 22: Connection refused')
    expect(scrubReason("Unable to create '/repo/.git/index.lock': File exists.")).toBe("Unable to create 'index.lock': File exists")
    const long = scrubReason('y'.repeat(300))
    expect(long.length).toBe(120)
    expect(long.endsWith('…')).toBe(true)
    const words = scrubReason(`${'word '.repeat(40)}tail`)
    expect(words.length).toBeLessThanOrEqual(120)
    expect(words).toMatch(/word…$/)
  })

  it('shortRemote drops protocol, userinfo and .git; scp-like syntax becomes host/owner/repo', () => {
    expect(shortRemote('https://github.com/acme/plugins.git')).toBe('github.com/acme/plugins')
    expect(shortRemote('https://user:token@github.com/acme/plugins')).toBe('github.com/acme/plugins')
    expect(shortRemote('git@github.com:acme/plugins.git')).toBe('github.com/acme/plugins')
    expect(shortRemote('ssh://git@git.example.test:2222/acme/plugins.git')).toBe('git.example.test:2222/acme/plugins')
    expect(shortRemote('https://git.example.test/acme/plugins/')).toBe('git.example.test/acme/plugins')
  })

  it('shortRemote never yields an absolute path: a file:// or bare-path remote keeps only the repo folder', () => {
    expect(shortRemote('file:///home/sample/repos/acme-plugins.git')).toBe('acme-plugins')
    expect(shortRemote('file:///tmp/fixtures/origin.git/')).toBe('origin')
    expect(shortRemote('/home/sample/repos/acme-plugins')).toBe('acme-plugins')
    expect(shortRemote('file:///')).toBe('local repository')
    expect(sourceShortLabel({ kind: 'git', url: 'file:///home/sample/repos/acme-plugins.git' })).toBe('git · acme-plugins')
  })

  it('shortenHome replaces the home prefix with ~ and leaves other paths alone', () => {
    expect(shortenHome('/home/sample/code/acme-plugins', '/home/sample')).toBe('~/code/acme-plugins')
    expect(shortenHome('/home/sample/code/acme-plugins', '/home/sample/')).toBe('~/code/acme-plugins')
    expect(shortenHome('/home/sample', '/home/sample')).toBe('~')
    expect(shortenHome('/home/samples/code', '/home/sample')).toBe('/home/samples/code')
    expect(shortenHome('/opt/plugins', '/home/sample')).toBe('/opt/plugins')
    expect(shortenHome('/opt/plugins', undefined)).toBe('/opt/plugins')
  })

  it('sourceShortLabel: git host/owner/repo or npm package, never a URL, userinfo or .git', () => {
    expect(sourceShortLabel({ kind: 'git', url: 'https://x:y@github.com/acme/plugins.git' })).toBe('git · github.com/acme/plugins')
    expect(sourceShortLabel({ kind: 'npm', type: 'npm', spec: '@acme/plugin@^1', packageName: '@acme/plugin' })).toBe('npm · @acme/plugin')
    expect(sourceShortLabel({ kind: 'npm', type: 'npm', resolved: '@acme/plugin@1.3.0' })).toBe('npm · @acme/plugin')
    expect(sourceShortLabel({ kind: 'npm', type: 'npm', spec: 'acme-plugin@2' })).toBe('npm · acme-plugin')
    expect(sourceShortLabel({ kind: 'npm', type: 'npm', spec: '@acme/plugin' })).toBe('npm · @acme/plugin')
    for (const label of [sourceShortLabel({ kind: 'git', url: 'git@github.com:acme/plugins.git' })]) {
      expect(/https?:\/\/|git@|\.git\b/.test(label)).toBe(false)
    }
  })
})

describe('round three: N3-2, N3-4, N3-11, N3-12, N3-13, N3-16', () => {
  it('resolveRowState: a row the server is still checking shows Checking, never Not checked first (N3-2)', () => {
    // First GET not back: pending placeholder.
    expect(resolveRowState({ known: undefined, loaded: false, refreshing: false })).toBeUndefined()
    expect(resolveRowState({ known: undefined, loaded: false, refreshing: true })).toBeUndefined()
    // Loaded, server refreshing, no cache for this row: the spinner.
    expect(resolveRowState({ known: undefined, loaded: true, refreshing: true })).toEqual({ kind: 'checking' })
    // A cached `unchecked` (the checkout moved, C69) is also about to be replaced.
    expect(resolveRowState({ known: { kind: 'unchecked', reason: 'The checkout moved since the last check.' }, loaded: true, refreshing: true })).toEqual({ kind: 'checking' })
    // The batch finished without this row: Not checked, with the scan note when the registry admits it.
    expect(resolveRowState({ known: undefined, loaded: true, refreshing: false })).toEqual({ kind: 'unchecked' })
    expect(resolveRowState({ known: undefined, loaded: true, refreshing: false, scanSkipped: true })).toEqual({ kind: 'unchecked', reason: LINKED_SCAN_SKIPPED_NOTE })
    expect(resolveRowState({ known: { kind: 'unchecked', reason: 'moved' }, loaded: true, refreshing: false })).toEqual({ kind: 'unchecked', reason: 'moved' })
    // A settled state is never overridden by a refresh: cached rows do not flash spinners.
    expect(resolveRowState({ known: { kind: 'available', behind: 2 }, loaded: true, refreshing: true })).toEqual({ kind: 'available', behind: 2 })
    expect(view(resolveRowState({ known: undefined, loaded: true, refreshing: true })).busy).toBe(true)
  })

  it('offline marks every known chip stale and keeps its words; pending, busy and missing are untouched (C49, N3-13)', () => {
    for (const state of [FIXTURES.current, FIXTURES.available3, FIXTURES.dirty, FIXTURES.diverged] as UpdateState[]) {
      const on = view(state)
      const off = view(state, { offline: true })
      expect(off.label).toBe(on.label)
      expect(off.kind).toBe(on.kind)
      expect(off.stale).toBe(true)
      expect(off.modifiers).toContain('--stale')
      expect(off.modifiers.filter((m) => m === '--stale')).toHaveLength(1)
    }
    // Already stale (remote unreachable): one marker, not two.
    expect(view(FIXTURES.unreachableNet as UpdateState, { offline: true }).modifiers.filter((m) => m === '--stale')).toHaveLength(1)
    expect(view(undefined, { offline: true }).stale).toBe(false)
    expect(view(FIXTURES.current, { offline: true, busy: 'checking' }).stale).toBe(false)
    expect(view(FIXTURES.missing as UpdateState, { offline: true }).stale).toBe(false)
  })

  it('a Sources chip whose Update lives on the Installed row says so instead of promising a button (N3-11)', () => {
    const state: UpdateState = { kind: 'available', behind: 2 }
    expect(view(state, { toRef: '2951707abcdef' }).title).toBe(`Update moves this plugin to 2951707.${CLICK_TO_CHECK_SUFFIX}`)
    expect(view(state, { toRef: '2951707abcdef', updateElsewhere: true }).title).toBe(`Update from its Installed row moves this plugin to 2951707.${CLICK_TO_CHECK_SUFFIX}`)
    expect(view(state, { updateElsewhere: true }).title).toBe(`Update from its Installed row moves this plugin to the newest commit on the remote.${CLICK_TO_CHECK_SUFFIX}`)
    expect(view({ kind: 'available', toVersion: '@acme/plugin@1.3.0' }, { updateElsewhere: true }).title).toContain('Update from its Installed row moves this plugin to v1.3.0.')
    // Other kinds do not mention the button at all, so nothing changes.
    expect(view(FIXTURES.current, { updateElsewhere: true }).title).toBe(view(FIXTURES.current).title)
  })

  it('while the row is being checked the button stays but is disabled, whatever the state (N3-12)', () => {
    expect(updateButtonMode({ kind: 'available', behind: 1 }, 'checking')).toEqual({ render: true, disabled: true, label: 'Update', reason: null })
    expect(updateButtonMode({ kind: 'missing' }, 'checking')).toEqual({ render: true, disabled: true, label: 'Restore', reason: null })
    expect(updateButtonMode({ kind: 'dirty' }, 'checking')).toEqual({ render: true, disabled: true, label: 'Update', reason: null })
    // A row that renders no button keeps rendering none: no flash of a grey Update during Check now.
    expect(updateButtonMode({ kind: 'current' }, 'checking')).toEqual({ render: false })
    expect(updateButtonMode(undefined, 'checking')).toEqual({ render: false })
    expect(updateButtonMode({ kind: 'unsupported', reason: 'x', hint: 'y' }, 'checking')).toEqual({ render: false })
  })

  it('a shared checkout says so on the primary Update: title names every sibling (N3-4)', () => {
    expect(sharedCheckoutNote(undefined)).toBeUndefined()
    expect(sharedCheckoutNote([])).toBeUndefined()
    expect(sharedCheckoutNote(['Acme Notes'])).toBe('Also updates Acme Notes (same checkout).')
    expect(sharedCheckoutNote(['Acme Notes', 'Acme Mail'])).toBe('Also updates Acme Notes and Acme Mail (same checkout).')
    expect(sharedCheckoutNote(['A', 'B', 'C'])).toBe('Also updates A, B and C (same checkout).')
    expect(updateButtonMode({ kind: 'available', behind: 1 }, null, true, { siblingNames: ['Acme Notes'] }))
      .toEqual({ render: true, primary: true, label: 'Update', title: 'Also updates Acme Notes (same checkout).' })
    expect(updateButtonMode({ kind: 'available', behind: 1 }, null, true, { siblingNames: [] })).toEqual({ render: true, primary: true, label: 'Update' })
    // Disabled and Restore keep their own reason / title.
    expect(updateButtonMode({ kind: 'dirty' }, null, true, { siblingNames: ['Acme Notes'] })).toMatchObject({ disabled: true, reason: REASON_DIRTY })
  })

  it('success names the abbreviated siblings in a title (N3-16); a single reload has no title', () => {
    const nameOf = (id: string) => ({ 'acme-tracker': 'Acme Tracker', 'acme-notes': 'Acme Notes' })[id] ?? id
    const two = successFeedback('linked', { sha: 'c8fd498ab', reloaded: ['acme-tracker', 'acme-notes'] }, nameOf)
    expect(two.text).toBe('Updated to c8fd498 · reloaded Acme Tracker and 1 more')
    expect(two.title).toBe('Reloaded Acme Tracker, Acme Notes')
    expect(two.title).not.toContain('acme-')
    const one = successFeedback('linked', { sha: 'c8fd498ab', reloaded: ['acme-tracker'] }, nameOf)
    expect(one.title).toBeUndefined()
    expect(successFeedback('git', { toSha: 'c8fd498ab', updated: true, restartRequired: true }, nameOf).title).toBeUndefined()
  })
})
