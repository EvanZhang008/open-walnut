/**
 * On the leader, a host's facts (event-classes.ts 'fact') arrive on the bus as the host emitted
 * them (session-channel/leader-side.ts). A subscriber that would do a session's own work again
 * (resend, respawn, recover, repair its process, drain its queue) must skip a session its host
 * runs: it asks judgeOf (sessions/judge-of.ts, or one of its gates). Every other subscriber reads
 * the forwarded events for the leader's own data and stays as it is.
 *
 * This lists every file under src/core and src/providers that subscribes to the bus and names a
 * fact event, and requires each one to call a judge-of gate or be listed below with its reason
 * (the plan's section 5 table: what stays on the leader and reads forwarded events). A new
 * subscriber of a fact fails here until it does one or the other.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SESSION_EVENT_CLASS } from '../../../src/core/session-channel/event-classes.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const GATE = /\b(judgeOf|judgingHostOf|judgeOfRecord|judgedHere|judgedHereOnly|judgedHereRecords|routeHostJudgedEvent)\(/

/** Subscribers that keep the leader's own data from the forwarded facts: no judge needed. */
const LEADER_DATA_ONLY: Record<string, string> = {
  'src/core/session-hooks/dispatcher.ts': 'session hooks: the leader runs its hooks on the forwarded turn ends',
  'src/core/user-status-sync.ts': "the user's status: derived on the leader from the forwarded facts",
  'src/core/push-notification.ts': 'push: the leader tells the phone',
  'src/core/org/thread-answers.ts': 'org threads: the leader keeps the threads',
  'src/core/org/thread-reply.ts': 'org threads: the leader keeps the threads',
  'src/core/topics/topic-replies.ts': 'topics: the leader keeps the topics',
  'src/core/boards/board-kanban-watch.ts': 'boards: the leader keeps the boards',
  'src/core/time-tracking/agent-time.ts': 'agent time: counted on the leader',
  'src/core/time-tracking/detail-store.ts': 'time detail: kept on the leader',
  'src/core/search.ts': 'search: the leader indexes the forwarded turns',
  'src/core/search/wiring.ts': 'search: the leader indexes the forwarded turns',
  'src/core/subagents/on-host.ts': 'the subagents registry: kept on the leader, its runs answer through forwarded facts',
  'src/core/triage/runs.ts': 'triage runs: the leader keeps them',
  'src/core/transfer/transfer.ts': 'transfer: the leader orchestrates it and waits for the forwarded fork init',
  'src/core/session-projection.ts': "the session projection: the leader's copy for the companion",
  'src/core/host-slice.ts': "the host slice: the leader's read copy for each host",
  'src/core/history-ready-refresh.ts': "first-paint views: the leader's cache, asked of the host's daemon",
  'src/core/session-changes-prewarm.ts': "the Changed tab's cache: the leader's",
  'src/core/session-git-status.ts': "the git glance: the leader's cache",
  'src/core/usage/session-cost.ts': 'session cost: counted on the leader',
  'src/core/routines/clock-placement-watch.ts': "routine clocks: the leader's placement",
  'src/core/routines/run-start-deps.ts': "routine runs: the leader's record of a run it started",
  'src/core/ai/ai-agent.ts': "ai.run: waits for its own turn's forwarded result",
  'src/core/sessions/lane-turn.ts': "lane turns: wait for their own turn's forwarded result",
  'src/core/sessions/lane-turn-gate.ts': "lane turns: wait for their own turn's forwarded result",
  'src/core/sessions/launch-prompts.ts': "launch prompts: the leader's optimistic first bubble",
  'src/core/sessions/missing-walnut-tool.ts': 'a one-time hint: sent through session:send, which goes to the host',
  'src/core/sessions/turn-run.ts': "the turn record's readers: reads, never resends",
  'src/core/sessions/request-reached.ts': "the request ledger: the leader's",
  'src/core/sessions/thread-takeaway.ts': "thread takeaways: the leader's",
  'src/core/sessions/thread-title.ts': "thread titles: the leader's",
  'src/core/stt/learn-from-sends.ts': "the correction list: learns from the user's sends on the leader",
  'src/core/session-channel/leader-boot.ts': "the leader's channel: it re-emits a host's facts (the Background panel's with the leader's subagent rows) and subscribes only to the leader's own deletes",
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...filesUnder(rel))
    else if (e.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

/** EventNames constant -> event name, from event-bus.ts. */
function eventNames(): Map<string, string> {
  const text = fs.readFileSync(path.join(ROOT, 'src/core/event-bus.ts'), 'utf8')
  return new Map([...text.matchAll(/^\s+([A-Z_]+):\s*'([a-z:-]+)'/gm)].map((m) => [m[1], m[2]]))
}

function factSubscribers(): Array<{ file: string; gated: boolean; facts: string[] }> {
  const facts = new Set(Object.entries(SESSION_EVENT_CLASS).filter(([, c]) => c === 'fact').map(([n]) => n))
  const consts = [...eventNames()].filter(([, v]) => facts.has(v))
  const out: Array<{ file: string; gated: boolean; facts: string[] }> = []
  for (const file of [...filesUnder('src/core'), ...filesUnder('src/providers')]) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    if (!/\bbus\.subscribe\(/.test(text)) continue
    const named = new Set<string>()
    for (const f of facts) if (text.includes(`'${f}'`)) named.add(f)
    for (const [c, v] of consts) if (text.includes(`EventNames.${c}`)) named.add(v)
    if (named.size === 0) continue
    out.push({ file, gated: GATE.test(text), facts: [...named].sort() })
  }
  return out
}

describe('every leader-side subscriber of a host fact asks judgeOf or is listed', () => {
  const subs = factSubscribers()

  it('finds the subscribers', () => {
    expect(subs.length).toBeGreaterThan(20)
  })

  it('each one calls a judge-of gate or is listed with its reason', () => {
    const missing = subs.filter((s) => !s.gated && !LEADER_DATA_ONLY[s.file]).map((s) => `${s.file} (${s.facts.slice(0, 3).join(', ')})`)
    expect(missing, 'gate it with judgeOf / judgedHereOnly (sessions/judge-of.ts), or list it in LEADER_DATA_ONLY with why').toEqual([])
  })

  it('the resend, respawn and repair family is gated', () => {
    const must = [
      'src/core/sessions/queue-after-turn.ts', 'src/core/sessions/usage-limit-wait.ts', 'src/core/sessions/context-full-recovery.ts',
      'src/core/sessions/prompt-refresh-respawn.ts', 'src/core/sessions/model-restore.ts', 'src/core/sessions/safeguard-switch.ts',
      'src/core/sessions/idle-compaction.ts', 'src/core/session-auto-continue.ts', 'src/core/sessions/endpoint-wait.ts',
      'src/core/session-health-monitor.ts', 'src/core/session-snapshot-apply.ts', 'src/core/session-reconcile.ts',
      'src/core/sessions/auto-recover-env.ts', 'src/providers/claude-code-session.ts',
    ]
    for (const file of must) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(GATE.test(text), file).toBe(true)
      expect(LEADER_DATA_ONLY[file], file).toBeUndefined()
    }
  })

  it('lists no file that no longer subscribes to a fact', () => {
    const found = new Set(subs.map((s) => s.file))
    const stale = Object.keys(LEADER_DATA_ONLY).filter((f) => !found.has(f))
    expect(stale).toEqual([])
  })
})

/**
 * The late-fact rule of each listed subscriber (the plan's late facts table: a fact the leader
 * applies long after it happened merges state and never acts again as if it just happened).
 *
 *   merges     reads or keeps state from the fact (a cache, an index, a ledger, a waiter of its own
 *              turn): the same late as fresh, nothing it does is "now"
 *   skips      acts only on what happens now (a hint into the session, a hook that asks it): its
 *              source reads `.late` and skips (or narrows) a late fact
 *   own time   records a time (agent time, a journal line, a card's output, a turn's end): its source
 *              reads the event's timestamp, the fact's original time (event-bus.ts EmitOptions.timestamp)
 *   gathers    derives once for a whole backlog (session-channel/late-gather.ts), never per fact
 *   unreached  no forwarded fact is addressed to it (event-classes.ts reemitDestinations)
 */
type LateRule = 'merges' | 'skips' | 'own time' | 'gathers' | 'unreached'
const LATE_RULES: Record<string, LateRule> = {
  'src/core/session-hooks/dispatcher.ts': 'skips',
  'src/core/user-status-sync.ts': 'gathers',
  'src/core/push-notification.ts': 'unreached',
  'src/core/org/thread-answers.ts': 'own time',
  // His reply delivered is recorded; the leaders' line about it rides their next message, never a wake.
  'src/core/org/thread-reply.ts': 'merges',
  // The member's reply is the topic's record and its delivery the conversation itself.
  'src/core/topics/topic-replies.ts': 'own time',
  'src/core/boards/board-kanban-watch.ts': 'own time',
  'src/core/time-tracking/agent-time.ts': 'own time',
  'src/core/time-tracking/detail-store.ts': 'own time',
  'src/core/search.ts': 'merges',
  'src/core/search/wiring.ts': 'merges',
  'src/core/subagents/on-host.ts': 'merges',
  // Settles a run once (settledTasks, and a COMPLETE run is never settled again): never starts one.
  'src/core/triage/runs.ts': 'own time',
  'src/core/transfer/transfer.ts': 'merges',
  'src/core/session-projection.ts': 'merges',
  'src/core/host-slice.ts': 'merges',
  'src/core/history-ready-refresh.ts': 'merges',
  'src/core/session-changes-prewarm.ts': 'merges',
  'src/core/session-git-status.ts': 'merges',
  'src/core/usage/session-cost.ts': 'merges',
  'src/core/routines/clock-placement-watch.ts': 'merges',
  'src/core/routines/run-start-deps.ts': 'merges',
  'src/core/ai/ai-agent.ts': 'merges',
  'src/core/sessions/lane-turn.ts': 'merges',
  'src/core/sessions/lane-turn-gate.ts': 'merges',
  'src/core/sessions/launch-prompts.ts': 'merges',
  'src/core/sessions/missing-walnut-tool.ts': 'skips',
  'src/core/sessions/turn-run.ts': 'merges',
  'src/core/sessions/request-reached.ts': 'merges',
  'src/core/sessions/thread-takeaway.ts': 'merges',
  'src/core/sessions/thread-title.ts': 'merges',
  'src/core/stt/learn-from-sends.ts': 'merges',
}

const LATE_PROOF: Partial<Record<LateRule, RegExp>> = {
  skips: /\.late\b/,
  'own time': /\bevent\.timestamp\b/,
  gathers: /\bcreateLateGather\(/,
}

describe('every listed subscriber of a host fact says what it does with a late one', () => {
  const listed = Object.keys(LEADER_DATA_ONLY)

  it('each one has a late rule, and only listed ones do', () => {
    expect(listed.filter((f) => !LATE_RULES[f]), 'give it a rule in LATE_RULES').toEqual([])
    expect(Object.keys(LATE_RULES).filter((f) => !LEADER_DATA_ONLY[f])).toEqual([])
  })

  it('a rule that needs proof in the source has it', () => {
    const unproven = listed.filter((f) => {
      const proof = LATE_PROOF[LATE_RULES[f]]
      return proof && !proof.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))
    })
    expect(unproven).toEqual([])
  })

  it("the main AI's subscriber raises no phase for a late tool call (server.ts enforceStreamingPhase)", () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/web/server.ts'), 'utf8')
    expect(text).toContain("enforceStreamingPhase(sessionId, eventData<'session:tool-use'>(event).taskId, event.late || eventData<'session:tool-use'>(event).replayed)")
  })

  it('only the turn-end kind of hook fires for a late fact', () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/core/session-hooks/builtins.ts'), 'utf8')
    const late = text.split(/\nexport const /).filter((def) => /\bfiresLate: true\b/.test(def)).map((def) => def.match(/\bid: '([^']+)'/)?.[1])
    expect(late).toEqual(['session-request-watch'])
  })
})
