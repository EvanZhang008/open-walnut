/**
 * The live "current action" of a running task (src/core/live-activity.ts): the tracker the
 * session runner feeds from the stream, the one line every surface shows, and the registry's
 * throttle (src/core/sessions/live-activity-registry.ts). The phone's formatter is pinned to
 * the same lines in ios-native/WalnutTests/TeamStatusModelTests.swift.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LiveActivityTracker, formatLiveActivity, formatSpan, parseLiveActivity, toolTarget, toolLabel,
  type LiveActivity,
} from '../../src/core/live-activity.js';
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import {
  LIVE_ACTIVITY_THROTTLE_MS, liveActivityByTask, liveActivityForTask, reportLiveActivity, resetLiveActivity, withLiveActivity, withLiveActivityAll,
} from '../../src/core/sessions/live-activity-registry.js';

const T0 = Date.parse('2026-10-26T04:54:00Z');
const min = 60_000;

describe('toolTarget', () => {
  it('names what each common tool works on, in one short line', () => {
    expect(toolTarget('Bash', { command: '\n  bun run test:quick\n  echo done', description: 'Run tests' })).toBe('bun run test:quick');
    expect(toolTarget('Edit', { file_path: '/Users/me/repo/src/core/live-activity.ts' })).toBe('core/live-activity.ts');
    expect(toolTarget('Read', { file_path: 'a.ts' })).toBe('a.ts');
    expect(toolTarget('Grep', { pattern: 'lastTool' })).toBe('lastTool');
    expect(toolTarget('Agent', { description: 'Map the fold', prompt: 'x'.repeat(5000) })).toBe('Map the fold');
    expect(toolTarget('WebFetch', { url: 'https://example.com/a/b' })).toBe('example.com/a/b');
    expect(toolTarget('TodoWrite', { todos: [] })).toBe('');
    expect(toolTarget('mcp__slack__post', { query: 'hi' })).toBe('hi');
    expect(toolTarget('Weird', null)).toBe('');
  });

  it('cuts a long target on a code point, never mid-surrogate', () => {
    const t = toolTarget('Bash', { command: `echo ${'\u{1F600}'.repeat(100)}` });
    expect(Array.from(t)).toHaveLength(80);
    expect(t.endsWith('…')).toBe(true);
    expect(t).not.toMatch(/[\uD800-\uDBFF]…$/);
  });

  it('labels an MCP tool without its prefix', () => {
    expect(toolLabel('mcp__slack__post_message')).toBe('slack: post_message');
    expect(toolLabel('Bash')).toBe('Bash');
  });
});

describe('formatLiveActivity', () => {
  const at = (m: number) => new Date(T0 + m * min).toISOString();

  it('reads like the research example: tool, its span, the turn, the cost', () => {
    const a: LiveActivity = { kind: 'tool', tool: 'Bash', target: 'bun run test:quick', since: at(38), turnStartedAt: at(0), lastToolAt: at(38), costUsd: 2.1 };
    const line = formatLiveActivity(a, T0 + 41 * min);
    expect(line.text).toBe('Bash: bun run test:quick · 3 min · turn 41 min · $2.10');
    expect(line.quiet).toBe(false);
  });

  it('says it went quiet when no tool ran for five minutes, and a running tool never does', () => {
    const thinking: LiveActivity = { kind: 'thinking', since: at(50), turnStartedAt: at(0), lastToolAt: at(43), costUsd: 3.4 };
    const line = formatLiveActivity(thinking, T0 + 55 * min);
    expect(line.quiet).toBe(true);
    expect(line.text).toBe('No tool call for 12 min · turn 55 min · $3.40');
    // Four minutes is not quiet yet.
    expect(formatLiveActivity({ ...thinking, since: at(44) }, T0 + 47 * min).action).toBe('Thinking · 3 min');
    // A long tool call is work, not silence.
    const longTool: LiveActivity = { kind: 'tool', tool: 'Bash', since: at(0), turnStartedAt: at(0), lastToolAt: at(0) };
    expect(formatLiveActivity(longTool, T0 + 30 * min).quiet).toBe(false);
    // No tool yet this turn: quiet counts from the turn's start.
    const noTool: LiveActivity = { kind: 'writing', since: at(9), turnStartedAt: at(0) };
    expect(formatLiveActivity(noTool, T0 + 10 * min).action).toBe('No tool call for 10 min');
  });

  it('leaves out what it does not know', () => {
    expect(formatLiveActivity({ kind: 'writing', since: new Date(T0).toISOString() }, T0 + 40_000).text).toBe('Writing · 40 s');
    expect(formatLiveActivity({ kind: 'tool', since: new Date(T0).toISOString() }, T0).text).toBe('a tool · 0 s');
    expect(formatLiveActivity({ kind: 'tool', tool: 'X', since: 'garbage' }, T0).text).toBe('X');
  });

  it('spans and costs', () => {
    expect(formatSpan(59_999)).toBe('59 s');
    expect(formatSpan(65 * min)).toBe('1 h 5 min');
    expect(formatSpan(120 * min)).toBe('2 h');
    expect(formatSpan(-5)).toBe('0 s');
    expect(formatLiveActivity({ kind: 'writing', since: new Date(T0).toISOString(), costUsd: 0.004 }, T0).cost).toBe('<$0.01');
  });

  it('parses the wire shape and refuses a malformed one', () => {
    expect(parseLiveActivity({ kind: 'tool', since: 'x', tool: 'Bash', costUsd: 1, extra: 3 })).toEqual({ kind: 'tool', since: 'x', tool: 'Bash', costUsd: 1 });
    expect(parseLiveActivity({ kind: 'dancing', since: 'x' })).toBeUndefined();
    expect(parseLiveActivity({ kind: 'tool' })).toBeUndefined();
    expect(parseLiveActivity(null)).toBeUndefined();
  });
});

describe('LiveActivityTracker', () => {
  it('follows a turn: thinking, a tool, its result, text, the end', () => {
    const t = new LiveActivityTracker();
    expect(t.snapshot()).toBeNull();
    expect(t.turnStart(T0)).toBe(true);
    expect(t.snapshot({ turnStartedAt: T0 })).toMatchObject({ kind: 'thinking', turnStartedAt: new Date(T0).toISOString() });
    // A second thinking token is no change: nothing to send.
    expect(t.thinking(T0 + 1)).toBe(false);
    expect(t.toolUse('tu1', 'Bash', { command: 'make' }, T0 + 1000)).toBe(true);
    expect(t.snapshot()).toMatchObject({ kind: 'tool', tool: 'Bash', target: 'make', lastToolAt: new Date(T0 + 1000).toISOString() });
    // Another session's result id is not ours.
    expect(t.toolResult('other', T0 + 1500)).toBe(false);
    expect(t.toolResult('tu1', T0 + 2000)).toBe(true);
    expect(t.snapshot()).toMatchObject({ kind: 'thinking', since: new Date(T0 + 2000).toISOString() });
    expect(t.writing(T0 + 3000)).toBe(true);
    expect(t.writing(T0 + 3001)).toBe(false);
    expect(t.end()).toBe(true);
    expect(t.snapshot()).toBeNull();
    expect(t.end()).toBe(false);
  });

  it('keeps the latest of parallel calls until the last result, and a subagent call only proves motion', () => {
    const t = new LiveActivityTracker();
    t.turnStart(T0);
    t.toolUse('a', 'Read', { file_path: '/x/a.ts' }, T0 + 1);
    t.toolUse('b', 'Grep', { pattern: 'foo' }, T0 + 2);
    expect(t.snapshot()).toMatchObject({ tool: 'Grep' });
    expect(t.toolResult('b', T0 + 3)).toBe(true);
    expect(t.snapshot()).toMatchObject({ tool: 'Read', target: '/x/a.ts', since: new Date(T0 + 1).toISOString() });
    t.toolUse('c', 'Agent', { description: 'Explore' }, T0 + 4);
    t.toolResult('a', T0 + 5);
    expect(t.snapshot()).toMatchObject({ tool: 'Agent', target: 'Explore' });
    // Inside the subagent: the row stays on the Agent call, but the session is not quiet.
    expect(t.toolUse('s1', 'Bash', { command: 'ls' }, T0 + 9 * min, true)).toBe(false);
    expect(t.snapshot()).toMatchObject({ tool: 'Agent', lastToolAt: new Date(T0 + 9 * min).toISOString() });
  });

  it('starts from text or a tool when it missed the turn start (a session attached mid-turn)', () => {
    const t = new LiveActivityTracker();
    expect(t.writing(T0)).toBe(true);
    expect(t.snapshot()?.kind).toBe('writing');
    const u = new LiveActivityTracker();
    expect(u.toolUse(undefined, 'Bash', { command: 'x' }, T0)).toBe(true);
    // A result with no id cannot be matched: the call stays shown.
    expect(u.toolResult(undefined, T0 + 1)).toBe(false);
  });

  it('rounds the cost and leaves out a zero one', () => {
    const t = new LiveActivityTracker();
    t.turnStart(T0);
    expect(t.snapshot({ costUsd: 0 })).not.toHaveProperty('costUsd');
    expect(t.snapshot({ costUsd: 1.234567 })?.costUsd).toBe(1.2346);
  });
});

describe('live activity registry', () => {
  let events: BusEvent[];
  const act = (tool: string, sinceMs: number): LiveActivity => ({ kind: 'tool', tool, since: new Date(sinceMs).toISOString() });

  beforeEach(() => {
    vi.useFakeTimers();
    bus.clear();
    resetLiveActivity();
    events = [];
    bus.subscribe('web-ui', (e) => { if (e.name === EventNames.SESSION_LIVE_ACTIVITY) events.push(e); });
  });
  afterEach(() => {
    resetLiveActivity();
    bus.clear();
    vi.useRealTimers();
  });

  it('sends the first change at once, then at most one per session every few seconds, the latest winning', () => {
    const now = Date.now();
    reportLiveActivity('s1', 't1', act('A', now), now);
    expect(events).toHaveLength(1);
    reportLiveActivity('s1', 't1', act('B', now + 1), now + 1000);
    reportLiveActivity('s1', 't1', act('C', now + 2), now + 2000);
    expect(events).toHaveLength(1);
    // The registry itself is current at once; only the sending waits.
    expect(liveActivityForTask('t1')?.tool).toBe('C');
    vi.advanceTimersByTime(LIVE_ACTIVITY_THROTTLE_MS);
    expect(events).toHaveLength(2);
    expect((events[1].data as { activity: LiveActivity }).activity.tool).toBe('C');
    expect(events[1].destinations).toEqual(['web-ui', 'mobile-events-feed']);
    // Another session is throttled on its own clock.
    reportLiveActivity('s2', 't2', act('X', now), Date.now());
    expect(events).toHaveLength(3);
  });

  it('clears at once at the turn end, and a repeat of the same state sends nothing', () => {
    const now = Date.now();
    const a = act('A', now);
    reportLiveActivity('s1', 't1', a, now);
    reportLiveActivity('s1', 't1', { ...a }, now + LIVE_ACTIVITY_THROTTLE_MS + 1);
    expect(events).toHaveLength(1);
    reportLiveActivity('s1', 't1', act('B', now), now + LIVE_ACTIVITY_THROTTLE_MS + 2);
    reportLiveActivity('s1', undefined, null);
    expect(events.map((e) => (e.data as { activity: unknown }).activity)).toEqual([a, act('B', now), null]);
    expect(liveActivityForTask('t1')).toBeUndefined();
    // The pending trailing send of B was cancelled with the clear.
    vi.advanceTimersByTime(LIVE_ACTIVITY_THROTTLE_MS * 2);
    expect(events).toHaveLength(3);
    // Clearing a session it never saw sends nothing.
    reportLiveActivity('nobody', undefined, null);
    expect(events).toHaveLength(3);
  });

  it('a dead process seen by someone else clears its entry; the runner\'s own events and a turn\'s end do not', () => {
    const now = Date.now();
    reportLiveActivity('s1', 't1', act('A', now), now);
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: 's1', process_status: 'idle' }, ['*']);
    expect(liveActivityForTask('t1')).toBeDefined();
    // The server sends session:ended at every turn's result: a background command runs on.
    bus.emit(EventNames.SESSION_ENDED, { sessionId: 's1' }, ['*']);
    expect(liveActivityForTask('t1')).toBeDefined();
    // The runner's own status event, committed late, may follow the next turn's first report.
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: 's1', process_status: 'error' }, ['*'], { source: 'session-runner' });
    expect(liveActivityForTask('t1')).toBeDefined();
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: 's1', process_status: 'stopped' }, ['*'], { source: 'session-snapshot' });
    expect(liveActivityForTask('t1')).toBeUndefined();
    reportLiveActivity('s2', 't2', act('B', now), now);
    bus.emit(EventNames.SESSION_STATUS_CHANGED, { sessionId: 's2', process_status: 'error' }, ['*'], { source: 'health-monitor' });
    expect(liveActivityByTask()).toEqual({});
  });

  it('every event carries the task\'s own line, so one session\'s end never clears another\'s', () => {
    const now = Date.now();
    const a = act('A', now - 1000);
    const b = act('B', now);
    reportLiveActivity('s1', 't1', a, now);
    reportLiveActivity('s2', 't1', b, now);
    reportLiveActivity('s2', 't1', null, now + 1);
    const task = events.map((e) => (e.data as { taskActivity: unknown }).taskActivity);
    expect(task).toEqual([a, b, a]);
    expect(events.map((e) => (e.data as { activity: unknown }).activity)).toEqual([a, b, null]);
  });

  it('a task with two running sessions shows the newer action; rows get it additively', () => {
    const now = Date.now();
    reportLiveActivity('s1', 't1', act('Old', now - 1000), now);
    reportLiveActivity('s2', 't1', act('New', now), now);
    expect(liveActivityForTask('t1')?.tool).toBe('New');
    expect(liveActivityByTask().t1?.tool).toBe('New');
    expect(withLiveActivity({ id: 't1', phase: 'IN_PROGRESS' })).toMatchObject({ live_activity: { tool: 'New' } });
    expect(withLiveActivity({ id: 't1', phase: 'COMPLETE' })).not.toHaveProperty('live_activity');
    const plain = { id: 'other', phase: 'IN_PROGRESS' };
    expect(withLiveActivity(plain)).toBe(plain);
    const rows = withLiveActivityAll([{ id: 't1', phase: 'IN_PROGRESS' }, plain, { id: 't1', phase: 'COMPLETE' }]);
    expect(rows.map((r) => r.live_activity?.tool)).toEqual(['New', undefined, undefined]);
    expect(rows[1]).toBe(plain);
  });
});
