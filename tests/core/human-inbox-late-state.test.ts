/**
 * Late reader-flag writes on the PRIMARY: setLetterState with `since`.
 *
 * A cloud replica takes the human's read / pin / archive while the Mac is out of
 * reach and replays it later, stamped with the moment the human made it. The
 * primary must apply that replay, unless the letter changed after that moment in
 * a way the replay would undo: a newer read flip, or an agent turn (news the
 * human's read or archive could not have seen). Plain last-arrival-wins would
 * mark an agent's fresh answer read, unseen.
 *
 * Also pinned: every state write reports the index clock it stamped, which is
 * what the replica waits for in its git-synced copy before it stops overlaying.
 *
 * WALNUT_HOME is an isolated tmpdir (createMockConstants).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-inbox-late-state'))

import {
  agentReply,
  getLetter,
  humanInboxPaths,
  sendLetter,
  setLetterState,
  setRead,
} from '../../src/core/human-inbox/store.js'
import { handleHumanInboxRelayAction } from '../../src/core/human-inbox/relay.js'
import type { LetterSender } from '../../src/core/human-inbox/types.js'

const SENDER: LetterSender = { sessionId: 'sess-late', host: 'workstation' }

async function letter(): Promise<string> {
  const l = await sendLetter({ subject: 'Nightly report', type: 'review', markdown: '# Report\nAll green.', sender: SENDER })
  return l.id
}

function indexStamp(): string {
  return (JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8')) as { lastUpdated: string }).lastUpdated
}

/** A moment strictly before anything the next store write stamps. */
async function momentBefore(): Promise<number> {
  const t = Date.now()
  await new Promise(r => setTimeout(r, 5))
  return t
}

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true })
})

describe('setLetterState', () => {
  it('reports the index clock its own write stamped', async () => {
    const id = await letter()
    const write = await setLetterState(id, 'read', true)
    expect(write.letter.read).toBe(true)
    expect(write.superseded).toBeUndefined()
    expect(write.storeUpdatedAt).toBe(indexStamp())
  })

  it('applies a late read when nothing changed after it', async () => {
    const id = await letter()
    const since = await momentBefore()
    const write = await setLetterState(id, 'read', true, { since })
    expect(write.superseded).toBeUndefined()
    expect((await getLetter(id))?.read).toBe(true)
  })

  it('keeps a newer read flip over a late replay of an older one', async () => {
    const id = await letter()
    const since = await momentBefore()
    await setRead(id, true) // the console, after the phone's change
    const write = await setLetterState(id, 'read', false, { since })
    expect(write.superseded).toBe(true)
    expect(write.letter.read).toBe(true)
    expect((await getLetter(id))?.read).toBe(true)
  })

  it('never marks read an agent turn that came after the human read', async () => {
    const id = await letter()
    const since = await momentBefore()
    // Already unread, so the reply moves no flag (and no readAt): only the
    // thread says it is news.
    await agentReply(id, { text: 'Follow-up: one job went red after all.' })
    const write = await setLetterState(id, 'read', true, { since })
    expect(write.superseded).toBe(true)
    expect((await getLetter(id))?.read).toBe(false)
  })

  it('keeps an answered letter out of the archive the human emptied before the answer', async () => {
    const id = await letter()
    const since = await momentBefore()
    await agentReply(id, { text: 'Answered your question.' })
    const write = await setLetterState(id, 'archived', true, { since })
    expect(write.superseded).toBe(true)
    expect((await getLetter(id))?.archived).toBe(false)
  })

  it('applies an archive whose agent turns are all older', async () => {
    const id = await letter()
    await agentReply(id, { text: 'Earlier note.' })
    const since = await momentBefore()
    const write = await setLetterState(id, 'archived', true, { since })
    expect(write.superseded).toBeUndefined()
    expect((await getLetter(id))?.archived).toBe(true)
  })

  it('applies a late pin regardless of later activity', async () => {
    const id = await letter()
    const since = await momentBefore()
    await agentReply(id, { text: 'Later activity.' })
    const write = await setLetterState(id, 'pinned', true, { since })
    expect(write.superseded).toBeUndefined()
    expect((await getLetter(id))?.pinned).toBe(true)
  })

  it('keeps a newer pin or archive change over a late replay of an older one', async () => {
    const id = await letter()
    await setLetterState(id, 'pinned', true)
    await setLetterState(id, 'archived', true)
    const since = await momentBefore()
    // On this box, after the phone's change: unpinned, then unarchived.
    await setLetterState(id, 'pinned', false)
    await setLetterState(id, 'archived', false)
    expect((await setLetterState(id, 'pinned', true, { since })).superseded).toBe(true)
    expect((await setLetterState(id, 'archived', true, { since })).superseded).toBe(true)
    const now = await getLetter(id)
    expect(now?.pinned).toBe(false)
    expect(now?.archived).toBe(false)
  })

  it('stamps when pin and archive move, and the stamps survive a rewrite', async () => {
    const id = await letter()
    const before = Date.now()
    await setLetterState(id, 'pinned', true)
    await setLetterState(id, 'archived', true)
    await setRead(id, true) // an unrelated rewrite of the index
    const raw = JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8')) as { letters: Array<Record<string, number>> }
    expect(raw.letters[0].pinnedAt).toBeGreaterThanOrEqual(before)
    expect(raw.letters[0].archivedAt).toBeGreaterThanOrEqual(before)
    // An agent reply that pulls it out of the archive moves the stamp too.
    const archivedAt = raw.letters[0].archivedAt
    await new Promise(r => setTimeout(r, 5))
    await agentReply(id, { text: 'Back in the feed.' })
    expect((await getLetter(id))?.archivedAt).toBeGreaterThan(archivedAt)
  })

  it('a late write that matches the current value is never superseded', async () => {
    const id = await letter()
    const since = await momentBefore()
    await setRead(id, true)
    const write = await setLetterState(id, 'read', true, { since })
    expect(write.superseded).toBeUndefined()
    expect(write.letter.read).toBe(true)
  })
})

describe('relay actions for the reader flags', () => {
  it('pass `since` through and answer the letter, the clock and the verdict', async () => {
    const id = await letter()
    const since = await momentBefore()
    await setRead(id, true)
    const refused = await handleHumanInboxRelayAction('read', { id, read: false, since })
    expect(refused).toMatchObject({ superseded: true, letter: { id, read: true } })
    expect(refused.storeUpdatedAt).toBe(indexStamp())

    const pinned = await handleHumanInboxRelayAction('pin', { id, pinned: true })
    expect(pinned).toMatchObject({ letter: { id, pinned: true } })
    expect(pinned.superseded).toBeUndefined()
    expect(typeof pinned.storeUpdatedAt).toBe('string')
  })

  it('ignore a `since` that is not a positive number (plain write)', async () => {
    const id = await letter()
    await setRead(id, true)
    const out = await handleHumanInboxRelayAction('read', { id, read: false, since: 'yesterday' })
    expect(out).toMatchObject({ letter: { read: false } })
    expect(out.superseded).toBeUndefined()
  })
})
