/**
 * A started session's link to its task (src/core/sessions/start-link.ts) is made by the server that
 * owns the task. On a host that runs its own sessions the leader links it from its born row, so the
 * host never asks its task copy: a start right after its task was made, before the copy had the
 * task, logged "failed to link session to task" on the host (2026-11-23), the line the cluster test
 * reads as a host task write. On the leader the link goes as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../../../src/logging/index.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { createHostSessionPort, StartBundles } from '../../../src/core/session-channel/host-port.js'
import { linkStartedSession } from '../../../src/core/sessions/start-link.js'
import type { SessionPort } from '../../../src/core/sessions/session-port.js'
import type { SessionRecord, Task } from '../../../src/core/types.js'

const TASK = 'task-new-1'
const SID = 'cccccccc-0001-4001-8001-000000000001'

/** A port whose task side knows no task yet (the host's copy before the task arrived) and records every task call. */
function basePort(): { base: SessionPort; taskCalls: string[] } {
  const taskCalls: string[] = []
  const missing = async (id: string): Promise<never> => { taskCalls.push(`getTask:${id}`); throw new Error(`No task found with ID: ${id}`) }
  const base = {
    records: { tracker: {}, loadTracker: async () => ({ getSessionByClaudeId: async () => ({ claudeSessionId: SID, taskId: TASK } as SessionRecord) }) },
    tasks: {
      loadTaskManager: async () => ({ getTask: missing, getProjectMetadata: async () => null }),
      loadPhase: async () => ({}),
      loadStartLink: async () => import('../../../src/core/sessions/start-link.js'),
    },
    config: { loadConfigManager: async () => ({ getConfig: async () => ({}) }) },
    launch: {},
    messages: { queue: {} },
    recovery: {},
  } as unknown as SessionPort
  return { base, taskCalls }
}

afterEach(() => { vi.restoreAllMocks() })

describe('a started session\'s link to its task', () => {
  it('on a host that runs its own sessions: the leader\'s, so nothing is asked of the task copy and no failure is logged', async () => {
    const { base, taskCalls } = basePort()
    const host = createHostSessionPort({ hostKey: 'marina-box', bundles: new StartBundles(), api: async () => null, base })
    const warn = vi.spyOn(log.session, 'warn')
    const link = await host.tasks.loadStartLink()
    await link.linkStartedSession(host, TASK, SID, 'bypass')
    await link.linkAcpStartedSession(host, TASK, SID, 'bypass')
    expect(taskCalls).toEqual([])
    expect(warn.mock.calls.map((c) => c[0]).filter((m) => /link session/.test(String(m)))).toEqual([])
  })

  it('on the leader: the slot by mode, then the task\'s session, and the task the link answered goes to the web UI', async () => {
    const linked: string[] = []
    const task = { id: TASK, title: 'Fresh', session_id: SID } as Task
    const leader = {
      records: { loadTracker: async () => ({ getSessionByClaudeId: async () => ({ claudeSessionId: SID, taskId: TASK } as SessionRecord) }) },
      tasks: {
        loadTaskManager: async () => ({
          linkSessionSlot: async (t: string, s: string, slot: string) => { linked.push(`slot:${t}:${s}:${slot}`); return { task } },
          linkSession: async (t: string, s: string) => { linked.push(`session:${t}:${s}`); return { task } },
          addSessionToHistory: async () => ({ task }),
        }),
      },
    } as unknown as SessionPort
    const updates: unknown[] = []
    const emit = vi.spyOn(bus, 'emit').mockImplementation(((name: string, data: unknown) => { if (name === EventNames.TASK_UPDATED) updates.push(data) }) as never)
    await linkStartedSession(leader, TASK, SID, 'plan')
    expect(linked).toEqual([`slot:${TASK}:${SID}:plan`, `session:${TASK}:${SID}`])
    expect(updates).toEqual([{ task }])
    emit.mockRestore()
  })
})
