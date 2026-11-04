/**
 * Every reader of a turn's end decides about quiet turns (src/core/sessions/quiet-turn.ts: Walnut's
 * idle compaction). A file in src/ that names a turn-end event (result, error, settle) either asks `isQuietTurn`
 * or is listed here with why a quiet turn's end is fine for it. A new reader fails this test until
 * it says which: a summary, a notice, a push or a phase written for Walnut's own upkeep is the
 * noise the quiet turn exists to avoid.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(ROOT, 'src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

/** Readers a quiet turn's end may reach, and why. */
const SEES_QUIET_TURNS: Record<string, string> = {
  'src/core/event-bus.ts': 'defines the event name',
  'src/core/event-types.ts': 'defines the payload',
  'src/core/phase.ts': 'applySessionPhase itself refuses a quiet turn\'s session edges',
  'src/core/session-hooks/dispatcher.ts': 'hands the event to derive/session.ts, which skips a quiet turn',
  'src/core/session-health-monitor.ts': 'only names the phase trigger; applySessionPhase gates it',
  'src/providers/claude-code-session.ts': 'the runner: drains the queue and settles the turn, quiet or not',
  'src/providers/acp-session.ts': 'an ACP engine: never compacted while idle',
  'src/providers/acp-stream-normalizer.ts': 'an ACP engine: never compacted while idle',
  'src/session-server/sdk-session.ts': 'the session server\'s own runner',
  'src/session-server/types.ts': 'types',
  'src/providers/session-server-client.ts': 'forwards the session server\'s events',
  'src/web/routes/events-v1.ts': 'forwards turn edges to clients: the panel must see the compaction end',
  'src/web/routes/session-stream-v1.ts': 'forwards turn edges to clients: the panel must see the compaction end',
  'src/core/session-projection.ts': 'refreshes the session\'s projection: its status really changed',
  'src/core/search.ts': 'reindexes the transcript, which really changed',
  'src/core/search/wiring.ts': 'reindexes the transcript, which really changed',
  'src/core/session-changes-prewarm.ts': 'warms the Changed tab cache: harmless',
  'src/core/session-git-status.ts': 'recounts the session\'s git changes (debounced; a tree a quiet turn left unchanged changes no count)',
  'src/core/sessions/launch-prompts.ts': 'forgets a launch prompt once the transcript has it',
  'src/core/sessions/lane-turn.ts': 'chat lanes are never compacted while idle',
  'src/core/sessions/lane-turn-gate.ts': 'chat lanes are never compacted while idle',
  'src/core/ai/ai-agent.ts': 'sums an ai.run lane\'s cost; lanes are never compacted while idle',
  'src/core/boards/board-kanban-watch.ts': 'moves a card only when the task itself changed in the turn',
  'src/replica/ask-launch.ts': 'a replica\'s own broadcast',
  'src/core/routines/run-start-deps.ts': 'waits for a routine run\'s own session to start; never compacted while idle',
  'src/core/sessions/auto-recover-env.ts': 'waits for the delivery of the one message it resent',
  'src/core/transfer/transfer.ts': 'waits for a fork it just started',
  'src/session-server/server.ts': 'the session server\'s own broadcast',
  'src/web/routes/sessions.ts': 'waits for a session it just launched to start',
  'src/core/session-reconcile.ts': 'emits the settle edge of a turn whose result was missed; its readers are gated',
  'src/core/session-snapshot-apply.ts': 'emits the settle edge from a daemon snapshot; its readers are gated',
  'src/core/sessions/report-phase.ts': 'emits the settle edge after a restart; its readers are gated',
};

/** The events a turn ends with: its result, its error, its settle edge. */
const TURN_END_EVENTS = /EventNames\.(SESSION_RESULT|SESSION_ERROR|SESSION_TURN_SETTLED)\b|['"]session:(result|error|turn-settled)['"]/;

describe('every reader of a turn end decides about quiet turns', () => {
  it('asks isQuietTurn, or is listed with its reason', () => {
    const readers = walk(SRC)
      .filter((f) => TURN_END_EVENTS.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    const undecided = readers.filter((f) => !(f in SEES_QUIET_TURNS) && !/\bisQuietTurn\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(undecided, 'a new turn-end reader: gate it with isQuietTurn(sessionId) or list it with a reason').toEqual([]);
    // A listed file that stopped reading the event leaves the list.
    expect(Object.keys(SEES_QUIET_TURNS).filter((f) => !readers.includes(f))).toEqual([]);
  });

  it('the paths that would make noise are gated', () => {
    for (const f of [
      'src/web/server.ts', 'src/core/session-hooks/derive/session.ts', 'src/core/push-notification.ts',
      'src/core/session-auto-continue.ts', 'src/core/sessions/endpoint-wait.ts', 'src/core/org/thread-answers.ts',
      'src/core/sessions/thread-title.ts', 'src/core/sessions/thread-takeaway.ts', 'src/core/hints/hint-drift-live.ts',
      'src/core/time-tracking/agent-time.ts', 'src/core/triage/runs.ts', 'src/web/routes/quick-main-follow.ts',
      'src/core/user-status-sync.ts', 'src/core/phase.ts',
    ]) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).toMatch(/\bisQuietTurn\(/);
    }
  });
});
