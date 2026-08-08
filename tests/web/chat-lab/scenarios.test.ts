/**
 * Chat lab — replayable scenarios for the "stale thing pinned at the bottom /
 * refresh clears it" incident family.
 *
 * THE LOOP THIS ENABLES (the user's requirement): every production incident in
 * this family becomes a scenario here. Step 1 REPRODUCE: script the incident's
 * event order against the PRE-FIX contract (fault knobs on) and assert the
 * artifact IS present — proving the lab can replicate the bug. Step 2 PROVE:
 * run the same order against the shipped contract and assert the oracles hold.
 * A fix without a reproducing scenario is not accepted; a scenario that can't
 * reproduce its incident means the root cause is NOT understood yet.
 *
 * Every module under test is REAL production code (see headless-client.ts).
 * Runs headless in milliseconds — `npm run test:focus tests/web/chat-lab`
 * (vitest.integration.config.ts supplies the @ alias).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ScriptedServer, userRow, assistantRow, agentTool, resetRowSeq } from './scripted-server';
import { HeadlessChatClient } from './headless-client';
import { expectRefreshEquivalent, expectNothingVanished, refreshResiduals } from './oracles';

let server: ScriptedServer;
let client: HeadlessChatClient;

beforeEach(() => {
  resetRowSeq();
  server = new ScriptedServer();
  client = new HeadlessChatClient(server);
});

/** Convenience: run one plain turn (user asks, assistant streams, archive catches up). */
function plainTurn(n: number): void {
  const q = `question number ${n}`;
  const a = `answer number ${n} with enough words to be distinctive`;
  client.send(q);
  server.append(userRow(q));
  const msgId = `m_turn_${n}`;
  client.textDelta(a.slice(0, 10), { msgId });
  client.textDelta(a.slice(10), { msgId });
  server.append(assistantRow(a, { msgId }));
  client.result();
}

describe('chat-lab: incident d9df1a86 / inc-1786072428043 — subagent finishes after the turn ended', () => {
  /** The production event order, verified from the incident bundle:
   *  turn ends while a background Agent still runs → its lane blocks stream on
   *  → CLI appends the task-notification AFTER the client's last delta →
   *  bgTaskFinished lands on a row the client already holds. */
  function playIncident(c: HeadlessChatClient, s: ScriptedServer): void {
    c.send('please investigate the thing');
    s.append(userRow('please investigate the thing'));

    // Assistant launches a background agent, answers, and the turn ends.
    const agentToolId = 'toolu_lab_agent_1';
    c.textDelta('Launching an investigator agent.', { msgId: 'm_launch' });
    c.toolUse(agentToolId, 'Agent', { input: { description: 'investigate' } });
    c.toolResult(agentToolId, `agentId: abc123 launched`);
    s.append(assistantRow('Launching an investigator agent.', {
      msgId: 'm_launch',
      tools: [agentTool(agentToolId)], // NOT finished yet
    }));
    c.result(); // turn over — edge refetch syncs the un-finished Agent row

    // The background agent keeps streaming into its lane AFTER the turn ended.
    c.textDelta('lane finding one', { parentToolUseId: agentToolId, subagentType: 'lab-explorer' });
    c.toolUse('toolu_lab_child_1', 'Bash', { parentToolUseId: agentToolId, subagentType: 'lab-explorer' });
    c.toolResult('toolu_lab_child_1', 'child output');
    c.textDelta('lane finding two', { parentToolUseId: agentToolId, subagentType: 'lab-explorer' });

    // Much later the CLI appends the task-notification: the parser stamps
    // bgTaskFinished onto the ALREADY-SERVED row (prefix mutation). The CLI
    // then emits a task-notification-origin result ("bookkeeping only, no
    // turn-over" in the incident log) — the browser sees streaming end, which
    // is what closes the lane's live state.
    s.stampBgFinished('m_launch', agentToolId);
    c.batchCompleted();
    c.result();
  }

  it('REPRODUCES the phantom subagent box under the pre-fix contract (no unsettled loop)', () => {
    server.faults.noUnsettledStamp = true; // pre-fix: rows served without the flag
    playIncident(client, server);

    // The bug: the client's copy of the Agent row never gains bgTaskFinished,
    // so the lane blocks have no absorption proof and a subagent box sits in
    // the live region — exactly the screenshot. A refresh clears it.
    const residuals = refreshResiduals(client, server);
    expect(residuals.length, 'pre-fix contract must reproduce the pinned subagent box').toBeGreaterThan(0);
    expect(residuals.some(r => r.kind === 'task-group' || r.kind === 'orphan-group')).toBe(true);
  });

  it('PROVES the shipped contract clears it (unsettled stamp + client re-ask)', () => {
    playIncident(client, server);
    expectRefreshEquivalent(client, server);
    expectNothingVanished(client, server);
  });

  it('agent still RUNNING at quiescence keeps its box visible (not a false positive)', () => {
    client.send('please investigate the thing');
    server.append(userRow('please investigate the thing'));
    const agentToolId = 'toolu_lab_agent_2';
    client.toolUse(agentToolId, 'Agent', { input: { description: 'investigate' } });
    client.toolResult(agentToolId, 'agentId: def456 launched');
    server.append(assistantRow('Launching.', { msgId: 'm_l2', tools: [agentTool(agentToolId)] }));
    client.result();
    client.textDelta('still working', { parentToolUseId: agentToolId, subagentType: 'lab-explorer' });

    // No notification yet — the live agent's box SHOULD render; hiding it would
    // be the vanish direction. Refresh-equivalence is expected to differ here,
    // and that difference is the design (the fresh mount lazy-loads the box
    // from history; the live one shows streamed children).
    const live = client.liveRegion();
    expect(live.some(i => i.kind === 'task-group' || i.kind === 'orphan-group')).toBe(true);
  });
});

describe('chat-lab: incident ec058eb7 / inc-1785993576822 — whale sliding window drops the newest rows', () => {
  function playIncident(c: HeadlessChatClient, s: ScriptedServer): void {
    // A long transcript the client has fully synced.
    for (let i = 0; i < 30; i++) s.append(assistantRow(`old content row ${i}`));
    c.reload();

    // Next turn: the user sends, the CLI appends BOTH rows, but the file
    // crossed the byte ceiling — the served window slides: 3 old rows evicted.
    c.send('the whale question');
    const msgId = 'm_whale_answer';
    c.textDelta('the whale answer streamed live', { msgId });
    s.append(userRow('the whale question'));
    s.append(assistantRow('the whale answer streamed live', { msgId }));
    // The production shape (verified cursor trace 1773→1764→…): the turn
    // appends 2 rows while the window evicts 1, so total grows by only 1 and
    // `since <= total` STILL PASSES — slice(since) then returns only the last
    // row, silently omitting the user's echo (it slid below the slice point).
    s.evict(1);
    c.result();
  }

  it('REPRODUCES the stuck bubble under the pre-fix count-only delta', () => {
    server.faults.legacyCountDelta = true;
    playIncident(client, server);

    // The bug: slice(since) with since minted before the slide omits the NEWEST
    // rows — the user's echo never reaches the client, the bubble has no
    // absorption evidence, and it pins at the bottom. Refresh clears it.
    const stuck = client.staleBubbles();
    expect(stuck.length, 'pre-fix contract must reproduce the pinned bubble').toBeGreaterThan(0);
    const residuals = refreshResiduals(client, server);
    expect(residuals.some(r => r.kind === 'bubble')).toBe(true);
  });

  it('PROVES the shipped contract heals it (windowed read + identity anchor → rebuild)', () => {
    playIncident(client, server);
    expectRefreshEquivalent(client, server);
    expectNothingVanished(client, server);
    // And the mechanism: the server must have declined the unsafe delta.
    const declined = server.requests.some(r => r.since !== undefined);
    expect(declined).toBe(true);
  });
});

describe('chat-lab: steady-state and stress orderings', () => {
  it('ten plain turns end refresh-equivalent with nothing vanished', () => {
    client.reload();
    for (let i = 0; i < 10; i++) plainTurn(i);
    expectRefreshEquivalent(client, server);
    expectNothingVanished(client, server);
  });

  it('batch-completed AND result both firing (the 20-50ms bus race) stays clean', () => {
    client.reload();
    client.send('race question');
    server.append(userRow('race question'));
    client.textDelta('race answer content here', { msgId: 'm_race' });
    server.append(assistantRow('race answer content here', { msgId: 'm_race' }));
    // Production order: batch-completed lands BEFORE session:result.
    client.batchCompleted();
    client.result();
    expectRefreshEquivalent(client, server);
    expectNothingVanished(client, server);
  });

  it('archive lag: history lands only AFTER several empty deltas (slow SSH)', () => {
    client.reload();
    client.send('slow question');
    client.textDelta('slow answer still only streamed', { msgId: 'm_slow' });
    client.result();          // edge refetch → EMPTY delta (archive lagging)
    client.batchCompleted();  // still empty
    // Block must still render (never vanish) while history is behind.
    expect(client.liveRegion().some(i => i.label.startsWith('text:slow answer'))).toBe(true);

    // Archive catches up; the next signal collapses the duplicate.
    server.append(userRow('slow question'));
    server.append(assistantRow('slow answer still only streamed', { msgId: 'm_slow' }));
    client.batchCompleted();
    expectRefreshEquivalent(client, server);
    expectNothingVanished(client, server);
  });

  it('compaction shrink mid-session degrades to a rebuild, never a duplicate', () => {
    client.reload();
    for (let i = 0; i < 6; i++) plainTurn(i);
    // /compact rewrote the transcript: fewer, different rows (fresh ids).
    resetRowSeq();
    server.canonical = [
      assistantRow('[compact summary of earlier conversation]', { msgId: 'm_compact_sum' }),
      userRow('question number 5'),
      assistantRow('answer number 5 with enough words to be distinctive', { msgId: 'm_after_compact' }),
    ];
    server.windowStart = 0;
    plainTurn(6);
    expectRefreshEquivalent(client, server);
  });

  it('sleep/wake: a batch of turn-end signals arrives at once after the laptop reopens', () => {
    client.reload();
    client.send('pre-sleep question');
    server.append(userRow('pre-sleep question'));
    client.textDelta('pre-sleep answer text', { msgId: 'm_sleep' });
    server.append(assistantRow('pre-sleep answer text', { msgId: 'm_sleep' }));
    // Wake: coalesced signals replay back-to-back (reconnect sweep + result +
    // batch-completed all in one tick).
    client.result();
    client.batchCompleted();
    client.batchCompleted();
    client.deltaFetch();
    expectRefreshEquivalent(client, server);
    expectNothingVanished(client, server);
  });

  it('redacted thinking is a DESIGNED residual — allowlisted, everything else clean', () => {
    client.reload();
    client.send('think question');
    server.append(userRow('think question'));
    client.thinkingDelta('private reasoning the archive redacts', { msgId: 'm_think' });
    client.textDelta('the visible answer', { msgId: 'm_think' });
    // History preserved the text but NOT the thinking.
    server.append(assistantRow('the visible answer', { msgId: 'm_think' }));
    client.result();
    expectRefreshEquivalent(client, server, {
      allowResiduals: i => i.kind === 'block' && i.label.startsWith('thinking:'),
    });
    expectNothingVanished(client, server);
  });
});

describe('chat-lab: seeded random interleavings (property mode)', () => {
  // mulberry32 — same deterministic PRNG as the daemon snapshot simulator.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SEEDS = Array.from({ length: 25 }, (_, i) => 0xC0FFEE + i);

  for (const seed of SEEDS) {
    it(`seed ${seed.toString(16)}: random turn/agent/lag interleaving converges`, () => {
      const rnd = mulberry32(seed);
      resetRowSeq();
      const s = new ScriptedServer();
      const c = new HeadlessChatClient(s);
      c.reload();

      const pendingAgents: Array<{ toolId: string; msgId: string }> = [];
      let turn = 0;
      const steps = 12 + Math.floor(rnd() * 10);
      for (let step = 0; step < steps; step++) {
        const dice = rnd();
        if (dice < 0.45) {
          // A plain turn; archive may lag behind (writes happen post-result half the time).
          turn++;
          const q = `q${seed % 1000}-${turn}`;
          const a = `a${seed % 1000}-${turn} distinctive answer body`;
          c.send(q);
          const early = rnd() < 0.5;
          if (early) { s.append(userRow(q)); }
          c.textDelta(a, { msgId: `m_${seed % 1000}_${turn}` });
          if (early) s.append(assistantRow(a, { msgId: `m_${seed % 1000}_${turn}` }));
          c.result();
          if (!early) {
            s.append(userRow(q));
            s.append(assistantRow(a, { msgId: `m_${seed % 1000}_${turn}` }));
            c.batchCompleted();
          }
        } else if (dice < 0.7) {
          // Launch a background agent mid-turn.
          turn++;
          const toolId = `toolu_${seed % 1000}_${turn}`;
          const msgId = `m_agent_${seed % 1000}_${turn}`;
          c.send(`launch ${turn}`);
          s.append(userRow(`launch ${turn}`));
          c.toolUse(toolId, 'Agent', { input: { description: `agent ${turn}` } });
          c.toolResult(toolId, `agentId: ${turn}00 launched`);
          s.append(assistantRow(`Launching agent ${turn}.`, { msgId, tools: [agentTool(toolId)] }));
          c.result();
          c.textDelta(`agent ${turn} lane output`, { parentToolUseId: toolId, subagentType: 'lab-explorer' });
          pendingAgents.push({ toolId, msgId });
        } else if (dice < 0.85 && pendingAgents.length > 0) {
          // A pending agent finishes (late prefix mutation + notification).
          const done = pendingAgents.splice(Math.floor(rnd() * pendingAgents.length), 1)[0];
          s.stampBgFinished(done.msgId, done.toolId);
          c.batchCompleted();
        } else {
          // Spurious signals (reconnect sweeps, duplicate batch-completed).
          c.batchCompleted();
          c.deltaFetch();
        }
      }

      // Drain: finish every pending agent, then quiesce. Production quiescence
      // is a task-notification-origin result ("bookkeeping only, no turn-over"
      // in the incident log) — lane deltas re-mark streaming, so without the
      // result edge the live-tail guard rightly keeps protecting the last block
      // and the state is NOT quiescent yet.
      for (const done of pendingAgents) {
        s.stampBgFinished(done.msgId, done.toolId);
      }
      c.batchCompleted();
      c.result();

      expectRefreshEquivalent(c, s);
      expectNothingVanished(c, s);
    });
  }
});

describe('chat-lab: phantom orphan box — hidden parent + visible children (defense in depth)', () => {
  /** The exact asymmetry from inc-1785965937858's amplifier: history absorbs
   *  the Agent parent tool_call by toolUseId while its lane children have no
   *  proof yet (agent still running) → the children re-box as an ANONYMOUS
   *  orphan-group at the bottom. The honest shape is the labeled Agent
   *  task-group (worst case a brief duplicate of the history card — the safe
   *  direction); a phantom "Subagent (continued)" box is the incident shape. */
  it('a RUNNING agent whose parent is in history renders a LABELED task-group, never an orphan box', () => {
    client.reload();
    client.send('launch the investigator');
    server.append(userRow('launch the investigator'));
    const agentToolId = 'toolu_lab_phantom_1';
    client.toolUse(agentToolId, 'Agent', { input: { description: 'investigate' } });
    client.toolResult(agentToolId, 'agentId: fedc98 launched');
    // History catches up: the Agent row (NOT finished) is persisted, so the
    // parent streaming block gets an id twin while the agent still runs.
    server.append(assistantRow('Launching the investigator.', {
      msgId: 'm_phantom', tools: [agentTool(agentToolId)],
    }));
    client.result();
    // The agent keeps streaming lane output — no completion proof exists yet.
    client.textDelta('lane progress line', { parentToolUseId: agentToolId, subagentType: 'lab-explorer' });

    const live = client.liveRegion();
    const orphans = live.filter(i => i.kind === 'orphan-group');
    expect(orphans, 'hidden parent + visible children must not synthesize a phantom orphan box').toEqual([]);
    expect(live.some(i => i.kind === 'task-group'), 'the live lane must render under the labeled Agent box').toBe(true);
  });
});
