/**
 * Every path that meets a session whose host cannot be reached, and how each one gets out
 * (sessions/host-lost.ts). 2026-11-07: a task whose session ran on a laptop that went offline
 * was stuck for good: task_move answered 502, task_start on another host was refused
 * ("already has its active session"), task_stop said "its host has not confirmed it yet".
 *
 * The ratchet: each refusal marker below is counted per file across src/, and a file or a
 * count not listed fails, so a new place that refuses on an unreachable host is looked at.
 * The structural checks pin that each listed path asks the host first and takes the way out.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Text a refusal on an unreachable host carries, and the files allowed to carry it, with the way out. */
const MARKERS: Record<string, { re: RegExp; files: Record<string, { count: number; way: string }> }> = {
  'stop not confirmed': {
    re: /has not confirmed (?:it|the stop) yet/g,
    files: {
      'src/web/routes/session-stop-v1.ts': { count: 1, way: 'only a host that is connected and did not confirm: an unreachable one is stopped here (hostLost) and answers 200' },
      'src/ops/task-lifecycle.ts': { count: 1, way: 'the same, for task_stop; a lost stop has its own outcome naming task_move' },
      'src/core/sessions/team-stop.ts': { count: 1, way: 'the same, for one member of a team stop' },
      'src/web/routes/session-lifecycle-v1.ts': { count: 1, way: 'a doc line of the stop route (stop_pending)' },
    },
  },
  'host unavailable stop': {
    re: /STOP_HOST_UNAVAILABLE\b(?!\s*=)/g,
    files: {
      'src/core/sessions/session-stop.ts': { count: 2, way: 'deliver probes a host with no live link first; only a coordinator with no probe keeps waiting' },
    },
  },
  'awaiting confirmation': {
    re: /awaiting host confirmation/g,
    files: {
      'src/core/sessions/session-stop.ts': { count: 2, way: 'the fence (a lost session gets hostLostFenceText, task_move, instead) and a doc line' },
      'src/core/sessions/session-lifecycle.ts': { count: 1, way: 'restartSession: a lost session gets host_lost and task_move' },
      'src/core/sessions/lifecycle-waits.ts': { count: 1, way: 'a doc line' },
    },
  },
  'another host refused': {
    re: /refuseDifferentPlace\(/g,
    files: {
      'src/core/sessions/task-start.ts': { count: 2, way: 'moveFromLostHost runs first: a lost session host becomes a move' },
      'src/core/sessions/quick-start.ts': { count: 1, way: 'moveFromLostHost runs first' },
    },
  },
  'unconfirmed start': {
    re: /still has an unconfirmed start/g,
    files: {
      'src/core/sessions/task-start.ts': { count: 1, way: 'stoppedAsLost frees a start on a host that does not answer' },
    },
  },
  'phone send during a stop': {
    re: /to confirm the stop before sending/g,
    files: {
      'src/web/routes/cloud-session-send.ts': { count: 1, way: 'a lost session gets "could not be reached ... move its task" instead' },
    },
  },
  'transfer source gone': {
    re: /'source_unreachable'/g,
    files: {
      'src/core/transfer/transfer.ts': { count: 1, way: 'a copy needs the source by nature; the answer names task_move' },
    },
  },
  'old host not gone yet': {
    re: /'host_unreachable'/g,
    files: {
      'src/core/sessions/engine-switch.ts': { count: 1, way: 'a move off a host that does not answer but is not gone yet (hostGone): says why and when to try again, never the old 502' },
      'src/core/sessions/task-start.ts': { count: 1, way: 'the same for a start on another host (moveFromLostHost)' },
      'src/core/sessions/folder-gone.ts': { count: 2, way: 'the folder check needs the host; the answer names task_move' },
      'src/core/sessions/host-start-gate.ts': { count: 1, way: 'the NEW host of a start does not answer: no old session involved' },
      'src/core/hosts/host-problem.ts': { count: 1, way: 'the gate code type' },
      'src/web/routes/engines.ts': { count: 3, way: "an engine's settings on a host that timed out: no session involved" },
    },
  },
  'ACP session on a gone host': {
    re: /'host_lost_acp'/g,
    files: {
      'src/core/sessions/engine-switch.ts': { count: 1, way: 'an ACP thread lives on its host and could not be stopped when it returns: refused, says wait for the host or end it there' },
    },
  },
  'archived target': {
    re: /'target_archived'/g,
    files: {
      'src/core/sessions/session-send-core.ts': { count: 2, way: 'the code type, and the refusal: never for a session its task is moving away from (movingFrom): that message is held and goes with the task' },
      'src/providers/gateway-core.ts': { count: 1, way: 'the code type the host gateway relays' },
      'src/core/human-inbox/item-plans.ts': { count: 1, way: 'attaching an email to an archived conversation: no move involved' },
    },
  },
  'work packed on the old host': {
    re: /moveTaskWork\(/g,
    files: {
      'src/core/sessions/engine-switch.ts': { count: 1, way: 'only when the move is not from a lost host (from_host_lost copies nothing)' },
      'src/core/transfer/task-work.ts': { count: 1, way: 'its definition' },
    },
  },
}

describe('paths that meet an unreachable session host', () => {
  for (const [name, marker] of Object.entries(MARKERS)) {
    it(`${name}: every file that carries it is listed with its way out`, () => {
      const found: Record<string, number> = {}
      for (const file of walk(path.join(ROOT, 'src'))) {
        const n = (fs.readFileSync(file, 'utf8').match(marker.re) ?? []).length
        if (n) found[path.relative(ROOT, file)] = n
      }
      expect(found).toEqual(Object.fromEntries(Object.entries(marker.files).map(([f, v]) => [f, v.count])))
    })
  }

  it('a stop probes a host with no live link before it waits for it', () => {
    const src = read('src/core/sessions/session-stop.ts')
    const deliver = src.indexOf('private async deliver(')
    const probe = src.indexOf('this.deps.probe(host)', deliver)
    const unavailable = src.indexOf('error = STOP_HOST_UNAVAILABLE', deliver)
    expect(deliver).toBeGreaterThan(0)
    expect(probe).toBeGreaterThan(deliver)
    expect(probe).toBeLessThan(unavailable)
    // The coordinator the server runs has the probe and the lost write.
    const live = src.slice(src.indexOf('export const sessionStops'))
    expect(live).toMatch(/\bprobe: async/)
    expect(live).toMatch(/\blost: async/)
  })

  it('a move probes its old host and copies nothing from a lost one', () => {
    const src = read('src/core/sessions/engine-switch.ts')
    const from = src.indexOf('async function switchFrom(')
    expect(src.indexOf('hostGone(oldHost, { target: host })', from)).toBeGreaterThan(from)
    // A lost host's busy session never makes the move wait.
    expect(src).toMatch(/const busy = lost \? false : await sessionBusy\(old\)/)
    const prep = src.indexOf('async function prepare(')
    const lostBranch = src.indexOf('if (state.move && state.from_host_lost)', prep)
    expect(lostBranch).toBeGreaterThan(prep)
    expect(lostBranch).toBeLessThan(src.indexOf('moveTaskWork(', prep))
    expect(src).toMatch(/lostHost \? await readCachedContext\(old\) : await readActiveContext\(old\)/)
  })

  it('a start on another host tries the lost-host move before it refuses', () => {
    const start = read('src/core/sessions/task-start.ts')
    const body = start.indexOf('async function startSessionForTaskNow(')
    const move = start.indexOf('moveFromLostHost(task, params)', body)
    expect(move).toBeGreaterThan(body)
    expect(move).toBeLessThan(start.indexOf('refuseDifferentPlace(task, conversation, params)', body))
    const quick = read('src/core/sessions/quick-start.ts')
    expect(quick.indexOf('moveFromLostHost(updatedTask')).toBeGreaterThan(0)
    expect(quick.indexOf('moveFromLostHost(updatedTask')).toBeLessThan(quick.indexOf('refuseDifferentPlace(updatedTask'))
  })

  it('a host coming back sends its pending stops before it delivers anything', () => {
    const runner = read('src/providers/claude-code-session.ts')
    const redeliver = runner.indexOf('private async redeliverPendingForHost(')
    const flush = runner.indexOf('sessionStops.flush(hostKey, connection)', redeliver)
    expect(flush).toBeGreaterThan(redeliver)
    expect(flush).toBeLessThan(runner.indexOf('getAllSessionsWithPending()', redeliver))
  })

  it('a send to a task (or its old session) during its move is held, never refused as archived', () => {
    // 2026-11-08: task_send to a task whose move was copying its work answered target_archived.
    const src = read('src/core/sessions/session-send-core.ts')
    expect(src).toMatch(/target\.session\.archived && !\(await import\('\.\/engine-switch\.js'\)\)\.movingFrom\(\{ sessionId: targetSid \}\)/)
    const sw = read('src/core/sessions/engine-switch.ts')
    // Rows that reached the old session after the move took its queue follow it to the new one.
    expect(sw).toMatch(/carryLateRows\(taskId, r\.fromSessionId, r\.sessionId\)/)
  })

  it('what a lost session did on its host after the stop is not replayed', () => {
    const src = read('src/core/offline-handover.ts')
    expect(src).toMatch(/lostSessionWindow\(callerSid\)/)
  })
})
