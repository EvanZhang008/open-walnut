/**
 * A replication that drops the targets that left it drops only its own kinds
 * (src/core/replication/replica-status.ts dropTargetsNotIn). 2026-11-20: the task replica's
 * rounds dropped every host copy's state too, so a host that refused the one tree's move never
 * counted past one refusal: Settings never offered its confirm, and its warnings never stopped.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { _resetReplicaStatusForTesting, dropTargetsNotIn, kindState, peekKindState } from '../../../src/core/replication/replica-status.js'

beforeEach(() => _resetReplicaStatusForTesting())

const target = (id: string) => ({ id, kind: 'host' as const, label: id })

describe('dropTargetsNotIn', () => {
  it('keeps another replication\'s kinds on a target that left this one', () => {
    kindState(target('host:companion'), 'host-notes').refusals = 2
    kindState(target('host:companion'), 'tasks').refusals = 1
    kindState(target('host:gone'), 'tasks')
    kindState(target('host:kept'), 'tasks').refusals = 1
    dropTargetsNotIn(['host:kept'], ['tasks', 'registry'])
    expect(peekKindState('host:companion', 'host-notes')?.refusals).toBe(2)
    expect(peekKindState('host:companion', 'tasks')).toBeNull()
    expect(peekKindState('host:gone', 'tasks')).toBeNull()
    expect(peekKindState('host:kept', 'tasks')?.refusals).toBe(1)
  })
})
