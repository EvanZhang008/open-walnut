/**
 * The Apps page's plugin model: which plugin is a part of another, what a card says, and
 * the plain-word answers to "where does this come from?" and "is it current?".
 */
import { describe, expect, it } from 'vitest'
import {
  cardStatus,
  originKind,
  partParents,
  sourceFacts,
  updateNote,
  type RegistryRow,
} from '../../web/src/components/apps-page/plugin-store-model'

const HOME = '/home/me'

function row(over: Partial<RegistryRow> & { id: string }): RegistryRow {
  return {
    name: over.id,
    source: { kind: 'local' },
    installed: true,
    status: 'active',
    builtin: false,
    configurable: false,
    catalog: false,
    toggleable: true,
    ...over,
  }
}

describe('partParents', () => {
  it('puts a plugin under the installed plugin its id extends, the longest such id', () => {
    const parents = partParents([
      row({ id: 'slack' }), row({ id: 'slack-mcp' }), row({ id: 'mail' }), row({ id: 'mail-imap' }),
      row({ id: 'mail-outlook' }), row({ id: 'wechat' }),
    ])
    expect(Object.fromEntries(parents)).toEqual({ 'slack-mcp': 'slack', 'mail-imap': 'mail', 'mail-outlook': 'mail' })
  })

  it('keeps one level: a part of a part goes to the top parent', () => {
    const parents = partParents([row({ id: 'mail' }), row({ id: 'mail-imap' }), row({ id: 'mail-imap-oauth' })])
    expect(parents.get('mail-imap-oauth')).toBe('mail')
    expect(parents.has('mail')).toBe(false)
  })

  it('leaves a part standing alone when its parent is not installed, and never matches a bare prefix', () => {
    const parents = partParents([row({ id: 'slack-mcp' }), row({ id: 'mail' }), row({ id: 'mailbox' })])
    expect(parents.size).toBe(0)
  })
})

describe('cardStatus', () => {
  it('says what most needs the user first', () => {
    expect(cardStatus(row({ id: 'a', status: 'failed' }))).toEqual({ text: 'Failed', tone: 'bad' })
    expect(cardStatus(row({ id: 'a', status: 'needs-config' }))).toEqual({ text: 'Needs setup', tone: 'warn' })
    expect(cardStatus(row({ id: 'a', status: 'disabled' }))).toEqual({ text: 'Off', tone: 'off' })
    expect(cardStatus(row({ id: 'a', state: 'stale-after-update' }))).toEqual({ text: 'Restart to finish', tone: 'warn' })
    expect(cardStatus(row({ id: 'a' }), { connectionAlert: 'Sign in needed' })).toEqual({ text: 'Sign in needed', tone: 'warn' })
    expect(cardStatus(row({ id: 'a' }), { update: { kind: 'available', behind: 2 } })).toEqual({ text: 'Update available', tone: 'update' })
    expect(cardStatus(row({ id: 'a' }), { update: { kind: 'dirty', behind: 0 } })).toEqual({ text: 'On', tone: 'on' })
    expect(cardStatus(row({ id: 'a', installed: false, status: 'available' }))).toEqual({ text: 'Get', tone: 'get' })
  })
})

describe('originKind', () => {
  it('names where the code comes from in a few words', () => {
    expect(originKind(row({ id: 'a', builtin: true, source: { kind: 'builtin' } }))).toBe('Built in')
    expect(originKind(row({ id: 'a', source: { kind: 'bundled' } }))).toBe('Comes with Walnut')
    expect(originKind(row({ id: 'a', source: { kind: 'linked' } }))).toBe('Git checkout')
    expect(originKind(row({ id: 'a', source: { kind: 'local' } }))).toBe('Local folder')
  })
})

describe('sourceFacts', () => {
  const values = (facts: { label: string; value: string }[]) => Object.fromEntries(facts.map((fact) => [fact.label, fact.value]))

  it('a local folder: the folder it runs from, no remote, and why nothing can update it', () => {
    const { facts, note } = sourceFacts(row({ id: 'slack', dir: `${HOME}/.open-walnut/plugins/slack` }), undefined, HOME)
    expect(values(facts)).toEqual({ 'Comes from': 'A folder on this computer', 'Runs from': '~/.open-walnut/plugins/slack', Remote: 'None' })
    expect(facts.find((fact) => fact.label === 'Runs from')?.copy).toBe(`${HOME}/.open-walnut/plugins/slack`)
    expect(note?.title).toBe('Local folder')
    expect(note?.text).toContain('cannot check for or install updates')
  })

  it('a linked checkout: folder, repository, remote, branch and commit', () => {
    const { facts, note } = sourceFacts(row({
      id: 'tunnels',
      source: { kind: 'linked', path: `${HOME}/code/store/tunnels`, checkout: `${HOME}/code/store`, branch: 'main', sha: 'd832a349049b70dc', remote: 'ssh://git.example.com/store' },
    }), undefined, HOME)
    expect(values(facts)).toEqual({
      'Comes from': 'A git checkout on this computer, linked into Walnut',
      'Runs from': '~/code/store/tunnels',
      Repository: '~/code/store',
      Remote: 'ssh://git.example.com/store',
      Branch: 'main at d832a34',
    })
    expect(note).toBeUndefined()
  })

  it('a linked checkout with no remote says so instead of leaving the row out', () => {
    const { facts } = sourceFacts(row({ id: 'ip', source: { kind: 'linked', path: '/x/ip', checkout: '/x/ip', branch: 'main', sha: 'abc' } }), undefined, HOME)
    expect(values(facts).Remote).toBe('None: this checkout has no remote')
    expect(values(facts).Repository).toBeUndefined()
  })

  it('a git source Walnut installed: remote, branch, installed commit, folder', () => {
    const { facts } = sourceFacts(
      row({ id: 'acme', source: { kind: 'git' }, sourceSlug: 'acme', dir: `${HOME}/.open-walnut/plugin-sources/acme` }),
      { slug: 'acme', kind: 'git', url: 'https://example.com/acme.git', ref: 'v2', lastSha: '0123456789abcdef', enabled: true, cloned: true, plugins: [] },
      HOME,
    )
    expect(values(facts)).toEqual({
      'Comes from': 'A git repository Walnut installed',
      Remote: 'https://example.com/acme.git',
      'Branch or tag': 'v2',
      'Installed commit': '0123456',
      'Runs from': '~/.open-walnut/plugin-sources/acme',
    })
  })

  it('built in and bundled show no host path (their files sit in the app\'s own runtime folder)', () => {
    const builtin = sourceFacts(row({ id: 'mail', builtin: true, source: { kind: 'builtin' }, dir: '/tmp/runtime/integrations/mail' }), undefined, HOME)
    expect(values(builtin.facts)['Runs from']).toBe('Inside the Walnut app')
    expect(builtin.note).toBeUndefined()
    const bundled = sourceFacts(row({ id: 'rhythm', source: { kind: 'bundled', path: 'plugin-store/rhythm' } }), undefined, HOME)
    expect(values(bundled.facts)['Runs from']).toBe('Inside the Walnut app')
  })

  it('a replica, or a Mac that could not read its sources, never claims a hand-copied folder', () => {
    const cloud = sourceFacts(row({ id: 'slack' }), undefined, HOME, { cloud: true })
    expect(values(cloud.facts)).toEqual({ 'Comes from': 'Installed on your Mac' })
    expect(cloud.note?.title).toBe('Read from your Mac')
    const unread = sourceFacts(row({ id: 'slack', dir: `${HOME}/.open-walnut/plugins/slack` }), undefined, HOME, { sourcesUnavailable: true })
    expect(values(unread.facts)['Comes from']).toBe('Not known right now')
    expect(unread.note?.text).not.toContain('by hand')
  })

  it('an older server without dir still says where it comes from', () => {
    const { facts } = sourceFacts(row({ id: 'slack' }), undefined, HOME)
    expect(values(facts)).toEqual({ 'Comes from': 'A folder on this computer', Remote: 'None' })
  })

  it('a row you can get: the example folder, or the remote', () => {
    expect(values(sourceFacts(row({ id: 'hello', installed: false, status: 'available', source: { kind: 'example', path: 'examples/plugins/hello' } }), undefined, HOME).facts))
      .toEqual({ 'Comes from': 'An example in the Walnut source', Folder: 'examples/plugins/hello' })
    expect(values(sourceFacts(row({ id: 'r', installed: false, status: 'available', source: { kind: 'git', url: 'https://example.com/r.git' } }), undefined, HOME).facts))
      .toEqual({ 'Comes from': 'A git repository', Remote: 'https://example.com/r.git' })
  })
})

describe('updateNote', () => {
  it('Local changes: what it means and what to do, naming the checkout', () => {
    const note = updateNote({ kind: 'dirty', behind: 3 }, { checkout: `${HOME}/code/store`, homeDir: HOME })!
    expect(note.title).toBe('Local changes: Walnut will not update this')
    expect(note.text).toContain('~/code/store has edits that are not committed')
    expect(note.text).toContain('never overwrites your work')
    expect(note.text).toContain('3 new commits waiting')
    expect(note.text).toContain('Commit or discard the edits')
    expect(note.tone).toBe('warn')
  })

  it('Cannot compare: why there is nothing to compare with, then the server reason and hint', () => {
    const note = updateNote({
      kind: 'unsupported',
      reason: 'No upstream branch is set for main, so there is nothing to compare against.',
      hint: 'This branch has no upstream. Push it or set one, then check again.',
    })!
    expect(note.title).toBe('Cannot compare: Walnut cannot tell whether there is a newer version')
    expect(note.text).toBe('Walnut checks for updates by comparing this copy with where it came from, and here there is nothing to compare it with. No upstream branch is set for main, so there is nothing to compare against. This branch has no upstream. Push it or set one, then check again.')
  })

  it('adds a period to a reason that has none', () => {
    expect(updateNote({ kind: 'unsupported', reason: 'Detached HEAD', hint: 'Check out a branch.' })!.text).toContain('Detached HEAD. Check out a branch.')
  })

  it('says nothing more for a state the row already says in full', () => {
    expect(updateNote({ kind: 'current' })).toBeNull()
    expect(updateNote({ kind: 'checking' })).toBeNull()
    expect(updateNote(undefined)).toBeNull()
  })

  it('an update and a diverged branch read in plain words', () => {
    expect(updateNote({ kind: 'available', toVersion: 'acme@1.4.0' })!.text).toBe('Update moves this plugin to v1.4.0.')
    expect(updateNote({ kind: 'available', behind: 1 })!.text).toBe('Update moves this plugin to the newest of 1 new commit.')
    expect(updateNote({ kind: 'diverged', behind: 2, ahead: 1 })!.text).toContain('1 commit the remote does not, and the remote has 2 commits it does not')
  })
})
