/**
 * Notes written while the Mac is away (WP11, `note-journal-v1`): both daemon twins
 * carry the same wiring (CLAUDE.md: keep daemon-standalone.ts and daemon-source.ts in
 * sync). Static ratchets over both sources, the shared cores and the source twin's
 * rendered template; the behaviour on real processes is
 * tests/integration/note-journal-twins.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { createHostReplica } from '../../src/providers/host-replica-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { APPLIED_V2_KINDS } from '../../src/core/offline-merge/apply-v2.js'

const root = path.join(import.meta.dirname, '..', '..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8')
const twins = { standalone: read('src/providers/daemon-standalone.ts'), source: read('src/providers/daemon-source.ts') }

function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`(async )?function ${name}\\(`))
  expect(start, name).toBeGreaterThan(-1)
  return src.slice(start, src.indexOf('\n}', start))
}

describe('note-journal-v1: both twins', () => {
  it('is advertised, never required (an older daemon keeps today\'s path)', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('note-journal-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('note-journal-v1')
  })

  it('the Mac drains note records and the host journals them as a v2 kind', () => {
    expect(JOURNAL_V2_DRAINS).toContain('note')
    expect(APPLIED_V2_KINDS as readonly string[]).toContain('note')
  })

  for (const [name, src] of Object.entries(twins)) {
    it(`${name}: replica.sync takes the leader's confirmation and answers a refusal with its code`, () => {
      const body = fnBody(src, 'cmdReplica')
      expect(body).toMatch(/hostReplica\.sync\(home, cmd\.kind, cmd\.entries, cmd\.asOf, cmd\.opts( as Record<string, unknown> \| undefined)?, \{ confirm: cmd\.confirm, confirmFor: cmd\.confirmFor \}\)/)
      expect(body).toMatch(/errorKind: (e|err)\.code/)
    })

    it(`${name}: the copy is wired before the offline host, which sets the journal view on it`, () => {
      expect(src).toMatch(/replica: hostReplica,/)
      const made = src.search(/(const|var) hostReplica = (createHostReplica|\(__CREATE_HOST_REPLICA__\))\(/)
      expect(made).toBeGreaterThan(-1)
      expect(made).toBeLessThan(src.indexOf('replica: hostReplica,'))
    })

    it(`${name}: follower.op reaches the offline host's handleFollower (note_put, note_delete there)`, () => {
      expect(fnBody(src, 'cmdFollowerOp')).toMatch(/offlineHost\.handleFollower\(home, \{ op: cmd\.op, args: cmd\.args, actor: cmd\.actor, opId: cmd\.opId/)
    })
  }

  it('the offline host core: a gateway note write only when the Mac drains notes and the host keeps them', () => {
    const core = read('src/providers/offline-host-core.ts')
    expect(core).toMatch(/case 'note_write': case 'note_edit':\n\s+if \(deps\.replica && deps\.replica\.has\(home, 'notes'\) && drainsKind\(home, 'note'\)\)/)
    expect(core).toMatch(/if \(name === 'note_put' \|\| name === 'note_delete'\) return followerNote\(home, name, args, actor, opId\)/)
    expect(core).toMatch(/deps\.replica\.setJournalView\(\{ overlay: noteOverlay, held: notesHeld \}\)/)
    expect(core).toMatch(/why: 'mac_too_old'/)
  })

  it('the cores are part of the daemon version hash and the build script', () => {
    for (const f of ['src/providers/host-replica-core.ts', 'src/providers/offline-host-core.ts', 'src/providers/offline-journal-core.ts']) {
      expect(read('src/providers/daemon-version-check.ts')).toContain(`'${f}'`)
      expect(read('scripts/build-daemon.sh')).toContain(f)
    }
  })

  it('the source twin template inlines the host replica with the journal view', () => {
    const rendered = getDaemonSource()
    const text = createHostReplica.toString()
    expect(text).toContain('setJournalView')
    expect(text).toContain('manifest_removes_most_rows')
    expect(rendered).toContain(text)
  })
})
