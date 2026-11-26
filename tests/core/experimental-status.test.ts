import { describe, it, expect } from 'vitest';
import { EVERY_EXPERIMENT, EXPERIMENTAL_FEATURES, GRADUATED_EXPERIMENTS, effectiveExperimentalFlags, experimentSummary, experimentalEnabled, keepsOwnSwitch, validExperimentalFlags } from '../../src/core/experimental.js';
import { HELP_MAX } from '../web/ui-words-scan.js';
import { workerStatus } from '../../src/core/worker-status.js';
import { childrenByParent, completeStatusFacts, statusOf, type StatusFacts } from '../../src/core/user-status-sync.js';
import type { Task } from '../../src/core/types.js';
import type { UserStatus } from '../../src/core/user-status.js';

const NOW = Date.parse('2026-11-11T01:00:00Z');
const waiting: UserStatus = { state: 'waiting', kind: 'task', waitingOn: 'Its worker' };
const task = (id: string, parent?: string, status?: UserStatus): Task => ({
  id, title: `Task ${id}`, phase: 'NEED_ACTION', session_id: `s-${id}`,
  ...(parent ? { parent_task_id: parent } : {}), ...(status ? { user_status: status } : {}),
} as Task);
function facts(tasks: Task[], enabled: boolean): StatusFacts {
  const f: StatusFacts = {
    followWorkers: enabled, sessions: new Map(tasks.map((t) => [t.session_id!, { processStatus: 'idle' }])),
    sessionsOf: new Map(tasks.map((t) => [t.id, [t.session_id!]])), titles: new Map(),
    letters: new Map(), choices: new Map(), requestsFrom: new Map(), triggers: new Map(), schedules: new Map(),
  };
  completeStatusFacts(f, tasks);
  return f;
}

describe('experimental choices', () => {
  it('every registered experiment starts as its registry default and only a boolean overrides it', () => {
    // An experiment that graduated by its default keeps its switch: a stored false still turns it off
    // (follower_on_every_host ended on, into GRADUATED_EXPERIMENTS). The one-service experiments went on
    // by default on 2026-11-24 (docs/plan/one-service-every-host.md), per-role tool listing on 2026-11-26
    // (checked against 5 days of real sessions: docs/reference/walnut-tools.md).
    expect(EXPERIMENTAL_FEATURES.filter((f) => f.default).map((f) => f.id).sort()).toEqual(['host_call_entry', 'host_runs_sessions', 'in_process_daemon', 'mcp_tools_by_role', 'service_launcher', 'work_survives_restart']);
    for (const feature of EXPERIMENTAL_FEATURES) {
      expect(experimentalEnabled(undefined, feature.id)).toBe(feature.default);
      expect(experimentalEnabled({}, feature.id)).toBe(feature.default);
      expect(experimentalEnabled({ [feature.id]: true }, feature.id)).toBe(true);
      expect(experimentalEnabled({ [feature.id]: false }, feature.id)).toBe(false);
    }
    expect(validExperimentalFlags({ future_flag: true })).toBe(true);
    for (const bad of [null, [], true, 'true', { leader_status_follows_workers: 'false' }]) expect(validExperimentalFlags(bad)).toBe(false);
  });

  it('"every experiment on" turns on every experiment never set alone, and a choice of its own still wins', () => {
    // The switch over all of them must never be taken for an experiment's own id.
    expect(EXPERIMENTAL_FEATURES.map((f) => f.id)).not.toContain(EVERY_EXPERIMENT);
    const [first, ...rest] = EXPERIMENTAL_FEATURES;
    const flags = { [EVERY_EXPERIMENT]: true, [first.id]: false };
    expect(experimentalEnabled(flags, first.id)).toBe(false);
    // One that keeps its own switch stays at its registry default (off, or on for one that graduated by its default).
    for (const feature of rest) expect(experimentalEnabled(flags, feature.id)).toBe(!keepsOwnSwitch(feature.id) || feature.default);
    for (const feature of EXPERIMENTAL_FEATURES) expect(experimentalEnabled({ [EVERY_EXPERIMENT]: false }, feature.id)).toBe(feature.default);
    expect(validExperimentalFlags(flags)).toBe(true);
  });

  it('an experiment that copies or downloads all of the data, moves where sessions run, or is a part of the Threads plan keeps its own switch: "every experiment on" never turns it on', () => {
    // The standby copy and the weekly restore drill: on a machine with every experiment on they
    // would start copying the data folder and downloading the whole backup without being asked.
    // Each computer running its own sessions changes which machine runs and watches them; a second
    // service on a computer another Walnut serves changes which service runs this Walnut's sessions there.
    // The five parts of the Threads plan (2026-11-25): each changes what agents write or runs a model
    // on a schedule, and each is measured alone, so none comes on with the rest.
    const own = EXPERIMENTAL_FEATURES.filter((f) => keepsOwnSwitch(f.id)).map((f) => f.id);
    // Macs running one Walnut service changes what runs on machines that may be other people's.
    expect(own.sort()).toEqual(['host_runs_sessions', 'host_service_sets', 'macos_one_service', 'restore_drill', 'service_without_copy', 'switchable_leader', 'threads_audit', 'threads_one_id', 'threads_related', 'threads_reminder', 'threads_reply_tag']);
    for (const id of own) {
      // "Every experiment on" changes none of them: each stays at its own default (host_runs_sessions
      // graduated by its default, so it is on with or without it), and its own choice wins either way.
      const byDefault = EXPERIMENTAL_FEATURES.find((f) => f.id === id)!.default;
      expect(experimentalEnabled({ [EVERY_EXPERIMENT]: true }, id)).toBe(byDefault);
      expect(effectiveExperimentalFlags({ [EVERY_EXPERIMENT]: true })[id]).toBe(byDefault);
      expect(experimentalEnabled({ [EVERY_EXPERIMENT]: true, [id]: true }, id)).toBe(true);
      expect(experimentalEnabled({ [EVERY_EXPERIMENT]: true, [id]: false }, id)).toBe(false);
      // Its row says so, since the switch above it says "every experiment is on".
      expect(EXPERIMENTAL_FEATURES.find((f) => f.id === id)!.description).toContain('keeps its own switch');
    }
  });

  it('every experiment shows one short help line in Settings; a longer description needs a summary', () => {
    for (const feature of EXPERIMENTAL_FEATURES) {
      const line = experimentSummary(feature);
      expect(line.length, feature.id).toBeLessThanOrEqual(HELP_MAX);
      expect(line, feature.id).not.toMatch(/[–—]/);
    }
    // A registry entry may still leave `summary` out when its description is short enough.
    expect(experimentSummary({ description: 'Short.' })).toBe('Short.');
  });

  it('the resolved map keeps unknown flags and gives every registered experiment its value', () => {
    const out = effectiveExperimentalFlags({ [EVERY_EXPERIMENT]: true, chat_reading_split: false, future_flag: false });
    expect(out.future_flag).toBe(false);
    expect(out.chat_reading_split).toBe(false);
    for (const feature of EXPERIMENTAL_FEATURES) if (feature.id !== 'chat_reading_split') expect(out[feature.id]).toBe(!keepsOwnSwitch(feature.id) || feature.default);
    const none = effectiveExperimentalFlags(undefined);
    for (const feature of EXPERIMENTAL_FEATURES) expect(none[feature.id]).toBe(feature.default);
    for (const id of GRADUATED_EXPERIMENTS) expect(none[id]).toBe(true);
    // An ended experiment's old stored false stays in the file but reads on.
    expect(effectiveExperimentalFlags({ follower_on_every_host: false }).follower_on_every_host).toBe(true);
  });
});

describe('leader status follows workers', () => {
  it.each([
    ['mixed working and waiting', [{ state: 'working' }, waiting], 'working'],
    ['all waiting', [waiting, waiting], 'waiting'],
    ['waiting and completed', [waiting, { state: 'done' }], 'waiting'],
    ['snoozed worker', [{ state: 'needs', snoozed: { until: '2026-11-12T00:00:00Z' } }], 'waiting'],
    ['all complete', [{ state: 'done' }, { state: 'done' }], 'read'],
    ['reported finished awaiting lead', [{ state: 'waiting', kind: 'lead', waitingOn: 'Its lead, to check the result and close it' }], 'read'],
    ['result with work remaining', [{ state: 'read' }, { state: 'working' }], 'working'],
    ['new worker has not started', [{ state: 'waiting', kind: 'not-started' }], 'waiting'],
    ['worker asks while another works', [{ state: 'needs', ask: 'Choose a release' }, { state: 'working' }], 'needs'],
  ] as [string, UserStatus[], UserStatus['state']][])('%s', (_name, workers, expected) => {
    expect(workerStatus(waiting, workers).state).toBe(expected);
  });

  it('keeps own requests, explicitly completed tasks, no-worker tasks and snoozes', () => {
    for (const own of [{ state: 'needs', ask: 'Allow the send' }, { state: 'done' },
      { ...waiting, snoozed: { until: '2026-11-12T00:00:00Z' } }] as UserStatus[]) {
      expect(workerStatus(own, [{ state: 'working' }])).toBe(own);
    }
    expect(workerStatus(waiting, [])).toBe(waiting);
  });

  it('a leader running its own turn reads Working, and its own outside wait outlives finished workers', () => {
    const running: UserStatus = { state: 'working' };
    expect(workerStatus(running, [waiting, waiting])).toBe(running);
    const ownCi: UserStatus = { state: 'waiting', kind: 'outside', waitingOn: 'CI on main' };
    expect(workerStatus(ownCi, [{ state: 'done' }])).toBe(ownCi);
    expect(workerStatus(ownCi, [{ state: 'working' }]).state).toBe('working');
  });

  it('keeps a same-ask fold, an answer given above and an answer to the user as they are', () => {
    const folded: UserStatus = { ...waiting, sameAsk: { id: 'w', title: 'Worker' } } as UserStatus;
    const answeredAbove: UserStatus = { ...waiting, answeredFor: { by: 'lead', at: '2026-11-11T00:00:00Z' } } as UserStatus;
    const answer: UserStatus = { state: 'read', toRead: 'answer' };
    for (const own of [folded, answeredAbove, answer]) expect(workerStatus(own, [{ state: 'working' }])).toBe(own);
  });

  it('a finished nested leader waits on its own lead; the top one reads Can close', () => {
    const nested = workerStatus(waiting, [{ state: 'done' }], { hasLeader: true });
    expect(nested).toMatchObject({ state: 'waiting', kind: 'lead' });
    expect(workerStatus(waiting, [nested]).state).toBe('read');
  });

  it('a Needs you from below leaves the ask with its owner', () => {
    const next = workerStatus(waiting, [{ state: 'needs', ask: 'Choose a release' }]);
    expect(next.state).toBe('needs');
    expect(next.ask).toBeUndefined();
  });

  it('Main and a VP keep their own rule with the experiment on', () => {
    const lead = { ...task('lead'), org_role: 'lead' } as Task; const w = task('w', 'lead', { state: 'working' });
    const tasks = [lead, w]; const children = childrenByParent(tasks);
    expect(statusOf(lead, facts(tasks, true), children, NOW).status)
      .toEqual(statusOf(lead, facts(tasks, false), children, NOW).status);
  });

  it('drops the old status line and wait reason while keeping context and the ask owner', () => {
    const own: UserStatus = { ...waiting, now: 'Checking results', line: { text: 'Old wait', by: 'self', at: '2026-11-11T00:00:00Z' },
      asks: [{ id: 'w', title: 'Worker', ask: 'Approve the post' }] };
    const next = workerStatus(own, [{ state: 'working' }]);
    expect(next).toMatchObject({ state: 'needs', now: 'Checking results', asks: own.asks });
    expect(next.line).toBeUndefined();
    expect(next.waitingOn).toBeUndefined();
  });

  it('off keeps the existing handback rule, on reads working from the team', () => {
    const p = task('p'); const w = task('w', 'p', { state: 'working' });
    const tasks = [p, w]; const children = childrenByParent(tasks);
    expect(statusOf(p, facts(tasks, false), children, NOW).status.state).toBe('read');
    expect(statusOf(p, facts(tasks, true), children, NOW).status.state).toBe('working');
  });

  it('asks below a nested leader keep their owner and priority over working', () => {
    const p = task('p'); const middle = task('middle', 'p');
    const leaf = task('leaf', 'middle', { state: 'needs', ask: 'Approve the send' });
    const working = task('working', 'p', { state: 'working' });
    const tasks = [p, middle, leaf, working]; const f = facts(tasks, true); const children = childrenByParent(tasks);
    middle.user_status = statusOf(middle, f, children, NOW).status;
    const next = statusOf(p, f, children, NOW).status;
    expect(next.state).toBe('needs');
    expect(next.asks).toEqual([expect.objectContaining({ id: 'leaf', ask: 'Approve the send', via: 'middle' })]);
  });

  it('works on a dense team and filters a different router area', () => {
    const p = task('p'); const tasks = [p, ...Array.from({ length: 250 }, (_, i) => task(`w${i}`, 'p', waiting))];
    tasks.push({ ...task('other-area', 'p', { state: 'needs', ask: 'Other area' }), router_area_id: 'other' } as Task);
    tasks[230].user_status = { state: 'working' };
    expect(statusOf(p, facts(tasks, true), childrenByParent(tasks), NOW).status.state).toBe('working');
  });
});
