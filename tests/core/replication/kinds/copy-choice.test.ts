/**
 * The per-host choice of copied kinds (docs/plan/walnut-replica-servers-impl.md,
 * WP4): `hosts.<key>.server.copies` in config.yaml, read by the host-server
 * settings, defaults filled in for the copy kinds (every kind on, letter
 * bodies off).
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-choice', { CLOUD_MODE: false }))

import { DEFAULT_COPY_CHOICE, copyChoiceFrom } from '../../../../src/core/replication/kinds/copy-kind.js'
import { hostServerSettingsFrom } from '../../../../src/core/host-server/index.js'
import { copyKinds } from '../../../../src/core/replication/kinds/index.js'

describe('the copied kinds choice', () => {
  it('defaults to every kind kept and letter bodies read from the Mac', () => {
    expect(DEFAULT_COPY_CHOICE).toEqual({
      sessions: true, requests: true, boards: true, inbox: true, inbox_bodies: false,
      // WP5: routines, the Ask lists, prefs and favorites, the allowlisted config.
      routines: true, conversations: true, prefs: true, config: true, personas: true,
      // 3e: a conversation's messages, kept by the companion only.
      conversation_bodies: false,
    })
    expect(copyChoiceFrom(undefined)).toEqual(DEFAULT_COPY_CHOICE)
    expect(copyChoiceFrom({ inbox_bodies: true, boards: false, sessions: 'no', other: true })).toEqual({ ...DEFAULT_COPY_CHOICE, inbox_bodies: true, boards: false })
  })

  it('keeps no letter bodies on a host that keeps no inbox', () => {
    expect(copyChoiceFrom({ inbox: false, inbox_bodies: true })).toEqual({ ...DEFAULT_COPY_CHOICE, inbox: false, inbox_bodies: false })
  })

  it('keeps no conversation bodies on a host that keeps no conversation lists', () => {
    expect(copyChoiceFrom({ conversation_bodies: true })).toEqual({ ...DEFAULT_COPY_CHOICE, conversation_bodies: true })
    expect(copyChoiceFrom({ conversations: false, conversation_bodies: true })).toEqual({ ...DEFAULT_COPY_CHOICE, conversations: false, conversation_bodies: false })
  })

  it('is read from hosts.<key>.server.copies, booleans only', () => {
    expect(hostServerSettingsFrom({ enabled: true }).copies).toBeUndefined()
    expect(hostServerSettingsFrom({ enabled: true, copies: { inbox: false, boards: 'x' } }).copies).toEqual({ inbox: false })
  })

  it('names a choice for every copy kind', () => {
    for (const k of copyKinds()) expect(Object.keys(DEFAULT_COPY_CHOICE)).toContain(k.choice)
    expect(copyKinds().map((k) => k.kind)).toEqual(['sessions', 'requests', 'boards', 'inbox', 'inbox-bodies', 'routines', 'conversations', 'prefs', 'config', 'personas', 'conversation-bodies'])
  })
})
