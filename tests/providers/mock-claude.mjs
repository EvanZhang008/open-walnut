#!/usr/bin/env node

/**
 * Mock Claude CLI — simulates both output formats:
 *   `claude -p --output-format stream-json`  → JSONL streaming lines
 *   `claude -p --output-format json`         → single JSON blob (legacy)
 *
 * Usage: node mock-claude.mjs -p --output-format stream-json --verbose "message"
 *         node mock-claude.mjs -p --output-format stream-json --resume <session-id> "message"
 *
 * Behavior is controlled by the message content:
 *   - "error" → exits with code 1 (stderr output)
 *   - "parse-error" → outputs invalid JSON to stdout
 *   - "tool-test" → emits a tool_use + tool_result in stream-json mode
 *   - anything else → outputs a valid response
 *
 * Supports --resume <session-id> flag (session ID as value of --resume).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
let transcriptParent = null;

function persistMockTurn(sessionId, prompt, answer) {
  const root = process.env.MOCK_CLAUDE_TRANSCRIPT_DIR;
  if (!root) return;
  const cwd = process.cwd();
  const dir = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const userId = randomUUID();
  const assistantId = randomUUID();
  const shared = { sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false };
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), [
    { ...shared, type: 'user', uuid: userId, parentUuid: transcriptParent, message: { role: 'user', content: prompt } },
    { ...shared, type: 'assistant', uuid: assistantId, parentUuid: userId, message: { ...answer.message, id: assistantId } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  transcriptParent = assistantId;
}

// Parse flags
let sessionId = null;
let resume = false;
let message = '';
let permissionMode = null;
let appendSystemPrompt = null;
let outputFormat = 'json';
let inputFormat = null;
let modelFlag = null;
let effortFlag = null;
let dangerouslySkipPermissions = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--resume') {
    resume = true;
    // --resume can take a session ID as its value (UUID format)
    if (args[i + 1] && !args[i + 1].startsWith('-')) {
      sessionId = args[++i];
    }
  } else if (args[i] === '--permission-mode' && args[i + 1]) {
    permissionMode = args[++i];
  } else if (args[i] === '--append-system-prompt' && args[i + 1]) {
    appendSystemPrompt = args[++i];
  } else if (args[i] === '--output-format' && args[i + 1]) {
    outputFormat = args[++i];
  } else if (args[i] === '--input-format' && args[i + 1]) {
    inputFormat = args[++i];
  } else if (args[i] === '--model' && args[i + 1]) {
    modelFlag = args[++i];
  } else if (args[i] === '--effort' && args[i + 1]) {
    effortFlag = args[++i];
  } else if (args[i] === '--dangerously-skip-permissions' || args[i] === '--allow-dangerously-skip-permissions') {
    // Both spellings grant the bypass CAPABILITY. Walnut spawns the `--allow-`
    // form because the bare flag also SELECTS bypassPermissions and outranks
    // `--permission-mode`. The bare form is still accepted here so a session
    // recorded before that fix (whose stored argv has the bare flag) keeps
    // replaying identically.
    dangerouslySkipPermissions = true;
  } else if (args[i] === '--session-id' && args[i + 1]) {
    // Pre-assigned session id (init-only spawn) — adopt it like --resume does.
    sessionId = args[++i];
  } else if (args[i] === '-p' || args[i] === '--verbose') {
    // skip known flags
  } else {
    message = args[i];
  }
}

// Resolver for an init-only spawn awaiting its first FIFO user message (see below).
let pendingUserResolve = null;

// Mode hook for the multi-turn snapshot modes (snapshot-clean-turn,
// snapshot-whale-turn, snapshot-init-edge). Set by armSnapshotNextTurn; consulted
// by the persistent stdin listener so a LATER FIFO user line re-enters the mode
// dispatcher and drives the next turn on the SAME live process.
let onUserLine = null;
let onControlResponse = null;
// Abort hook for a mode whose turn is in flight (snapshot-long-turn). The stdin
// listener ACKs every `interrupt` control_request like the real CLI does; only a
// mode that registered this hook then emits the aborted-turn sequence.
let onInterrupt = null;

// When --input-format stream-json is used, read the message from stdin (FIFO pipe).
// The real CLI reads JSON lines like: {"type":"user","message":{"role":"user","content":"..."}}
// The FIFO is opened O_RDWR so it won't EOF — we read available data with a short timeout.
if (inputFormat === 'stream-json') {
  const stdinData = await new Promise((resolve) => {
    let data = '';
    let timer = null;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      // Got a complete line — resolve immediately
      if (data.includes('\n')) {
        if (timer) clearTimeout(timer);
        process.stdin.removeAllListeners();
        process.stdin.pause();
        resolve(data);
      }
    });
    // Timeout in case stdin is empty or no newline arrives.
    // Use 500ms to handle test parallelism where FIFOs may be slow under load.
    timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(data);
    }, 500);
  });

  // Lines that rode in with the first user message (a control_request written
  // right after the send) must reach the persistent listener below — the real
  // CLI never drops a line, and dropping one here made an early stop go unACKed.
  const leftoverLines = [];
  let adoptedFirstMessage = false;
  if (stdinData.trim()) {
    for (const line of stdinData.trim().split('\n')) {
      try {
        const parsed = JSON.parse(line);
        if (!adoptedFirstMessage && parsed.message?.content) {
          adoptedFirstMessage = true;
          message = typeof parsed.message.content === 'string'
            ? parsed.message.content
            : JSON.stringify(parsed.message.content);
          continue;
        }
        leftoverLines.push(line);
      } catch { /* skip non-JSON lines */ }
    }
  }

  // Persistent stdin listener — two jobs, mirroring the real FIFO-mode CLI:
  //  1. control_request{generate_session_title} → immediate control_response with
  //     a deterministic title derived from the description (fire-and-forget,
  //     same contract as fork print.ts), so tests can assert the full
  //     Walnut→CLI→Walnut round-trip.
  //  2. a `type:'user'` line resolves a pending init-only wait (see below) —
  //     the real CLI spawned with an empty first message idles on stdin and
  //     adopts the first FIFO user message as its turn.
  process.stdin.resume();
  process.stdin.on('error', () => {});
  let ctlBuf = '';
  process.stdin.on('data', (chunk) => {
    ctlBuf += chunk;
    let nl;
    while ((nl = ctlBuf.indexOf('\n')) !== -1) {
      const line = ctlBuf.slice(0, nl);
      ctlBuf = ctlBuf.slice(nl + 1);
      handleStdinLine(line);
    }
  });
  // Replay what the first read swallowed, once the mode dispatcher below has had
  // a tick to register its hooks (same ordering a late FIFO write would get).
  if (leftoverLines.length > 0) setTimeout(() => { for (const line of leftoverLines) handleStdinLine(line); }, 0);
  function handleStdinLine(line) {
    {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'control_request' && parsed.request?.subtype === 'interrupt') {
          // CLI 2.1.258 (live probe): the ACK is immediate and unconditional —
          // an idle CLI answers it too and emits nothing else. Only a mode with a
          // turn in flight (onInterrupt registered) then plays the abort sequence.
          process.stdout.write(JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: parsed.request_id, response: { still_queued: [] } },
          }) + '\n');
          if (onInterrupt) { const abort = onInterrupt; onInterrupt = null; abort(); }
        } else if (parsed.type === 'control_request' && parsed.request?.subtype === 'apply_flag_settings') {
          // Live model/effort switch (real CLI, verified 2.1.170): a blind success
          // ACK, and the NEXT turn on this same process answers under the new
          // value. Mirrored here so a switch no longer needs a kill + `--resume
          // --model` respawn to become visible in the result's [model:…] tag.
          const settings = parsed.request.settings ?? {};
          if (typeof settings.model === 'string') modelFlag = settings.model;
          if (typeof settings.effortLevel === 'string') effortFlag = settings.effortLevel;
          process.stdout.write(JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: parsed.request_id, response: {} },
          }) + '\n');
        } else if (parsed.type === 'control_request' && parsed.request?.subtype === 'side_question') {
          // side_question is auto-title's PRIMARY channel (main-model prompt we
          // author). Mirror the real CLI's 3-level nesting: response.response.response.
          // Deterministic title: "Side title: " + first five words of the user's
          // message line in the question envelope (same word logic as the titler).
          const q = String(parsed.request.question ?? '');
          const msgLine = q.match(/User's first message: ([\s\S]*?)(?:\nReply with|$)/);
          let src = (msgLine ? msgLine[1] : q).trim();
          src = src.replace(/^(?:(?:slow|chunk-delay):\d+\s+)+/, '');
          const five = src.split(/\s+/).slice(0, 5).join(' ');
          const response = q.includes('PHASE_SIGNAL:') && q.includes('EXEC_SUMMARY:')
            ? 'EXEC_SUMMARY: The fixture turn finished.\nUSER_REQUEST: Validate the session flow.\nCONTEXT: An isolated test session.\nPROGRESS: The turn finished.\nREFERENCES: unchanged\nWORK_LOG: append: Finished the fixture turn.\nTITLE: unchanged\nRECAP: The fixture turn finished.\nPHASE_SIGNAL: conversational(user-asked-question)\nSTATUS: succeeded\nWHAT_I_DID: Answered the fixture prompt.\nNEXT_STEPS: Continue the conversation.\nBLOCKERS: none\nUSER_INTENT: question-pending\nVERIFIED: not-applicable'
            : `Side title: ${five}`;
          process.stdout.write(JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: parsed.request_id, response: { response } },
          }) + '\n');
        } else if (parsed.type === 'control_request' && parsed.request?.subtype === 'generate_session_title') {
          // The auto-title caller wraps the message in a context envelope
          // ("Current session title: …\nUser's first message: <msg>") — unwrap
          // so asserted titles stay derived from the user's own words. Then
          // strip test-harness prefixes (slow:/chunk-delay:) so they never
          // leak into the asserted title, and take the first five words.
          let desc = String(parsed.request.description ?? '');
          const envelope = desc.match(/User's first message: ([\s\S]*)$/);
          if (envelope) desc = envelope[1];
          desc = desc.replace(/^(?:(?:slow|chunk-delay):\d+\s+)+/, '');
          const words = desc.trim().split(/\s+/).slice(0, 5).join(' ');
          process.stdout.write(JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: parsed.request_id, response: { title: `Mock title: ${words}` } },
          }) + '\n');
        } else if (parsed.type === 'control_response' && onControlResponse) {
          onControlResponse(parsed.response);
        } else if (parsed.type === 'user' && parsed.message?.content !== undefined && pendingUserResolve) {
          const c = parsed.message.content;
          const resolve = pendingUserResolve;
          pendingUserResolve = null;
          resolve(typeof c === 'string' ? c : JSON.stringify(c));
        } else if (parsed.type === 'user' && parsed.message?.content !== undefined && onUserLine) {
          const c = parsed.message.content;
          onUserLine(typeof c === 'string' ? c : JSON.stringify(c));
        }
      } catch { /* not JSON — ignore */ }
    }
  }
}

const outputSessionId = sessionId || 'mock-session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

// Simulate error — exit non-zero with stderr
if (message === 'error') {
  process.stderr.write('Mock error output\n');
  process.exit(1);
}

// Simulate parse error — output garbage to stdout
if (message === 'parse-error') {
  process.stdout.write('not valid json at all\n');
  process.exit(0);
}

// Parse "slow:<ms>" prefix — emits init immediately, then delays before result.
// Example: "slow:500 my message" → 500ms delay between init and result events.
// Recomputable: an init-only spawn (see the stream-json branch) adopts its first
// FIFO user message AFTER these were computed for the empty spawn message.
let slowDelayMs = 0;
let effectiveMessage = message;
let chunkDelayMs = 0;
let resultText = '';
function computeMessageParts() {
  slowDelayMs = 0;
  effectiveMessage = message;
  const slowMatch = message.match(/^slow:(\d+)\s+(.*)/);
  if (slowMatch) {
    slowDelayMs = parseInt(slowMatch[1], 10);
    effectiveMessage = slowMatch[2];
  }

  // Parse "chunk-delay:<ms>" prefix — inserts a real delay BETWEEN content_block_delta
  // emissions (currently wired into stream-partial-thinking-then-text only), so
  // browser tests can observe partial text mid-turn (the default burst is
  // synchronous and races any DOM poll). Composable after slow:, e.g.
  // "chunk-delay:250 stream-partial-thinking-then-text".
  chunkDelayMs = 0;
  const chunkDelayMatch = effectiveMessage.match(/^chunk-delay:(\d+)\s+(.*)/);
  if (chunkDelayMatch) {
    chunkDelayMs = parseInt(chunkDelayMatch[1], 10);
    effectiveMessage = chunkDelayMatch[2];
  }

  // Build result text
  const permPart = permissionMode ? ` [permission-mode:${permissionMode}]` : '';
  const cwdPart = ` [cwd:${process.cwd()}]`;
  const sysPart = appendSystemPrompt ? ` [has-system-prompt]` : '';
  const modelPart = modelFlag ? ` [model:${modelFlag}]` : '';
  const effortPart = effortFlag ? ` [effort:${effortFlag}]` : '';
  const bypassCapabilityPart = dangerouslySkipPermissions ? ' [dangerously-skip-permissions:true]' : '';
  resultText = `Hello! I processed your message: ${effectiveMessage}${permPart}${cwdPart}${sysPart}${modelPart}${effortPart}${bypassCapabilityPart}`;
}
computeMessageParts();

// ── stream-json mode: emit JSONL lines ──
if (outputFormat === 'stream-json') {
  // 1. Init event
  const initEvent = {
    type: 'system',
    subtype: 'init',
    session_id: outputSessionId,
    cwd: process.cwd(),
    model: modelFlag || 'mock-model',
    tools: ['Read', 'Edit', 'Bash'],
    mcp_servers: [],
    permissionMode: permissionMode || 'default',
    // Mirrors CLI 2.1.240: the command set THIS process accepts (names only) and
    // the terminal-only ones the palette must hide. `__internal-thing` stands in
    // for the CLI's `__remote-workflow`-style internal names.
    slash_commands: ['compact', 'clear', 'mock-skill-alpha', 'mock-skill-beta', 'doctor', 'color', '__internal-thing'],
    terminal_slash_commands: ['doctor', 'color'],
  };
  process.stdout.write(JSON.stringify(initEvent) + '\n');

  // 1b. For "mode-change:<from>-to-<to>" messages, emit a second system event
  //     with a different permissionMode to simulate EnterPlanMode / mode transitions.
  //     Example: "mode-change:bypass-to-plan" starts in bypassPermissions, then emits plan.
  const modeChangeMatch = effectiveMessage.match(/^mode-change:(\w+)-to-(\w+)/);
  if (modeChangeMatch) {
    const modeMap = {
      bypass: 'bypassPermissions',
      accept: 'acceptEdits',
      plan: 'plan',
      default: 'default',
    };
    const targetMode = modeMap[modeChangeMatch[2]] || modeChangeMatch[2];
    // Emit the mode-change system event after a short delay (simulates EnterPlanMode)
    setTimeout(() => {
      const modeChangeEvent = {
        type: 'system',
        subtype: 'status',
        session_id: outputSessionId,
        permissionMode: targetMode,
      };
      process.stdout.write(JSON.stringify(modeChangeEvent) + '\n');
    }, 100);
  }

  // ── Multi-turn support for the snapshot-* modes ──
  // Every other mode is single-turn: it either exits at `result` or parks
  // forever. The snapshot modes must survive several turns on ONE process (the
  // real FIFO-mode CLI does, and an E2E that spawns a fresh CLI per turn can't
  // reproduce the mid-turn shapes at all). armSnapshotNextTurn re-enters this
  // dispatcher when the NEXT FIFO user line arrives, so turn 2 can select a
  // different snapshot mode than turn 1. Only the snapshot modes arm it, so no
  // existing mode's behavior changes.
  let snapshotTurnSeq = 0;
  // Cumulative session cost, like the real CLI's `total_cost_usd` (which is the
  // running total for the SESSION, not the turn). Load-bearing for any mode that
  // runs MORE THAN ONE turn on one process: Walnut treats "cumulative cost
  // identical to the previous turn's" as proof the CLI made zero API calls and
  // replayed old JSONL, so it kills the FIFO and forces a cold --resume
  // (claude-code-session.ts, "stale result detected"). A flat per-turn cost
  // therefore makes every turn after the first look replayed — measured: 5 of 6
  // concurrent sessions went to 'stopped' mid-suite. Grow it per turn.
  let snapshotCostUsd = 0;
  function nextSnapshotCost(increment) {
    snapshotCostUsd = Math.round((snapshotCostUsd + increment) * 1e6) / 1e6;
    return snapshotCostUsd;
  }
  function armSnapshotNextTurn() {
    onUserLine = (content) => {
      onUserLine = null;
      message = content;
      computeMessageParts();
      emitRemainingEvents();
    };
  }
  // The aborted-turn tail of CLI 2.1.258 (live probe 2026-09-11), emitted AFTER
  // the stdin listener's ACK: the CLI-inserted user line, an is_error result with
  // only an [ede_diagnostic] error and no text, then idle. The process then arms
  // the next FIFO user line as a new turn — it never exits on an interrupt.
  function emitAbortedTurnTail() {
    const sid = outputSessionId;
    const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n');
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, session_id: sid, parent_tool_use_id: null });
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 300, duration_api_ms: 250, num_turns: 2, stop_reason: null, session_id: sid, total_cost_usd: nextSnapshotCost(0.001), usage: { input_tokens: 10, output_tokens: 0 }, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'] });
    emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
    armSnapshotNextTurn();
  }

  // Emit remaining events (optionally delayed for "slow:N" messages)
  function emitRemainingEvents() {
    if (effectiveMessage.startsWith('status-permission-test:')) {
      const toolName = effectiveMessage.match(/^status-permission-test:(\w+)/)?.[1];
      const requestId = `req-status-${outputSessionId}-${++snapshotTurnSeq}`;
      const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n');
      const input = toolName === 'AskUserQuestion'
        ? { questions: [{ question: 'Which validation target?', header: 'Target', multiSelect: false, options: [
            { label: 'Staging', description: 'Validate the staging fixture' },
            { label: 'Local', description: 'Validate the local fixture' },
          ] }] }
        : toolName === 'ExitPlanMode' ? { plan: 'Validate the isolated status fixture.' }
        : { command: 'pwd', description: 'Inspect the fixture directory' };
      onControlResponse = (response) => {
        if (response.request_id !== requestId) return;
        onControlResponse = null;
        const decision = response.response;
        const answer = decision?.updatedInput?.answers?.['Which validation target?'];
        const text = `${toolName} decision received: ${answer || decision?.behavior || 'missing'}`;
        emit({ type: 'system', subtype: 'session_state_changed', session_id: outputSessionId, state: 'running' });
        emit({ type: 'assistant', session_id: outputSessionId, message: {
          id: `msg_${requestId}`, type: 'message', role: 'assistant', model: 'mock-model',
          content: [{ type: 'text', text }], stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 8 },
        } });
        emit({ type: 'result', subtype: 'success', is_error: false, session_id: outputSessionId,
          result: text, num_turns: 1, total_cost_usd: nextSnapshotCost(0.001),
          usage: { input_tokens: 20, output_tokens: 8 },
        });
        emit({ type: 'system', subtype: 'session_state_changed', session_id: outputSessionId, state: 'idle' });
        armSnapshotNextTurn();
      };
      emit({ type: 'system', subtype: 'session_state_changed', session_id: outputSessionId, state: 'requires_action' });
      emit({ type: 'control_request', request_id: requestId,
        request: { subtype: 'can_use_tool', tool_name: toolName, input },
      });
      return;
    }

    // 2a.-2. "compaction-test[:<keepAliveCount>[:<gapMs>]]" — an AUTO-COMPACTION
    //        exactly as the real CLI streams one (shapes copied from this machine's
    //        stream files, 2026-09-18):
    //          text → status{compacting} × N → compact_boundary → text → result
    //        N defaults to 5 because `status: compacting` is a 30-SECOND TRANSPORT
    //        KEEP-ALIVE the CLI re-emits for the whole compaction, and a real
    //        auto-compaction runs 147-539s. All N must collapse into ONE timeline
    //        row that ends as the outcome (the reported bug rendered all six).
    //
    //        gapMs stretches the keep-alives over real time, which is the only way
    //        a spec can watch the LIVE reducer hold one placeholder across repeats:
    //        emitted in one burst, the whole compaction is over before the browser
    //        paints and only the history parser gets tested.
    if (effectiveMessage.startsWith('compaction-test')) {
      // Parse the numbers with an anchored regex, NOT split(':'): the delivered
      // message carries trailing decoration (the "[Rich output mode enabled…]"
      // suffix), which made `Number(gapArg)` NaN → every keep-alive fired in one
      // burst → the spec could only ever see the finished state.
      const args = effectiveMessage.match(/^compaction-test(?::(\d+))?(?::(\d+))?/);
      const keepAlives = Number(args?.[1]) || 5;
      const gapMs = Number(args?.[2]) || 0;
      const sid = outputSessionId;
      // Deliberately no canonical-transcript write: history for this scenario comes
      // from the daemon's stream file, which is the dialect that carries
      // `compact_metadata` (snake_case) in the first place.
      const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n');
      const say = (id, text) => emit({ type: 'assistant', session_id: sid, message: {
        id, type: 'message', role: 'assistant', model: 'mock-model',
        content: [{ type: 'text', text }], stop_reason: 'end_turn',
        usage: { input_tokens: 400000, output_tokens: 12 },
      } });
      const finish = () => {
        emit({ type: 'system', subtype: 'compact_boundary', session_id: sid, uuid: 'mock-boundary-1',
          compact_metadata: {
            trigger: 'auto', pre_tokens: 443847, post_tokens: 49108,
            cumulative_dropped_tokens: 17494300, duration_ms: 181769,
          } });
        say('msg_postcompact', 'Compaction done; carrying on with the task.');
        emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid,
          result: 'Compaction done; carrying on with the task.', num_turns: 2,
          total_cost_usd: nextSnapshotCost(0.001), usage: { input_tokens: 49108, output_tokens: 12 },
        });
        emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
        armSnapshotNextTurn();
      };
      emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'running' });
      say('msg_precompact', 'Context is nearly full; compacting before I continue.');
      const keepAlive = (i) => emit({
        type: 'system', subtype: 'status', status: 'compacting', session_id: sid, uuid: `mock-ka-${i}`,
      });
      if (gapMs <= 0) {
        for (let i = 0; i < keepAlives; i++) keepAlive(i);
        finish();
      } else {
        for (let i = 0; i < keepAlives; i++) setTimeout(() => keepAlive(i), gapMs * (i + 1));
        setTimeout(finish, gapMs * (keepAlives + 2));
      }
      return;
    }

    // 2a.-1. "snapshot-clean-turn[:<text>]" — ONE clean turn then STAY ALIVE
    //         (real FIFO-mode CLI behavior), so the daemon's fold sees the
    //         canonical settle sequence and the session converges to idle
    //         without the process dying:
    //           assistant → result → session_state_changed{idle}
    //         The trailing idle is what daemon-fold needs to mark the turn
    //         settled (a result alone leaves turnActive=true). Every other
    //         success mode either exits at `result` (killing the process, so
    //         the snapshot projects 'stopped' not 'idle') or omits the idle.
    //
    //         Multi-turn: a LATER FIFO user line re-enters the dispatcher (see
    //         armSnapshotNextTurn), so a follow-up send can select a different
    //         snapshot mode on the SAME live process — that's how the real CLI
    //         behaves and it keeps an E2E to one CLI process for several turns.
    if (effectiveMessage === 'snapshot-clean-turn' || effectiveMessage.startsWith('snapshot-clean-turn:')) {
      const text = effectiveMessage.includes(':')
        ? effectiveMessage.split('\n\n[Rich output mode enabled')[0].split(':').slice(1).join(':')
        : 'Clean turn done; process stays alive.';
      const sid = outputSessionId;
      const emit = (line) => {
        if (line.type === 'assistant') persistMockTurn(sid, effectiveMessage, line);
        process.stdout.write(JSON.stringify(line) + '\n');
      };
      const body = () => {
        emit({ type: 'assistant', message: { id: 'msg_snap_clean_' + (++snapshotTurnSeq), type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }, session_id: sid });
        emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 40, num_turns: 1, result: text, session_id: sid, total_cost_usd: nextSnapshotCost(0.001), usage: { input_tokens: 20, output_tokens: 8 } });
        emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
        armSnapshotNextTurn();
      };
      // Minimum "think time" before the turn's output. NOT cosmetic — it is
      // ordering fidelity for the turn-start MARKER. Walnut delivers a send by
      // writing the FIFO and, SEPARATELY (fire-and-forget RPC), asking the
      // daemon to append a `user/walnut-injected` anchor line to the stream file
      // (RemoteSessionManager.writeSyntheticUserEvent). A real CLI takes
      // hundreds of ms to seconds per turn, so the anchor always lands BEFORE
      // that turn's assistant/result/idle. Emitting synchronously here wins the
      // race instead, producing a line order production never emits — anchor
      // AFTER settle — which the fold correctly reads as "a new turn just
      // started and never finished": turnActive sticks true forever and the
      // record projects 'running' with the CLI idle. Measured on the stress
      // suite: all 6 concurrent sessions wedged at 'running' this way.
      const THINK_MS = Number(process.env.MOCK_SNAPSHOT_TURN_DELAY_MS ?? 300);
      if (THINK_MS > 0) setTimeout(body, THINK_MS);
      else body();
      // Do NOT exit: stream-json FIFO mode stays alive between turns.
      return;
    }

    // 2a.-0.9. "snapshot-long-turn[:<ms>[:text[:sticky]]]" — a turn that keeps RUNNING for
    //          <ms> (default 60s) unless an `interrupt` control_request arrives,
    //          then STAYS ALIVE for the next FIFO turn either way. With the `text`
    //          suffix it first streams one partial sentence (stop-while-streaming);
    //          without it nothing has streamed yet when the stop lands — the shape
    //          Walnut must not mistake for a failed turn.
    //
    //          The abort sequence is CLI 2.1.258 verbatim (live probe 2026-09-11,
    //          after the ACK the stdin listener already sent):
    //            user "[Request interrupted by user]"
    //            result{subtype:'error_during_execution', is_error:true, stop_reason:null,
    //                   errors:['[ede_diagnostic] …'], output_tokens:0, no result text}
    //            session_state_changed{idle}
    //          The natural end (no interrupt) is a plain success result + idle.
    if (effectiveMessage === 'snapshot-long-turn' || effectiveMessage.startsWith('snapshot-long-turn:')) {
      // Only the first line carries the mode; a queued send appends Walnut's
      // rich-output trailer after a blank line.
      const parts = effectiveMessage.split('\n')[0].split(':');
      const holdMs = Number(parts[1]) || 60000;
      const streamsText = parts[2] === 'text' || parts[2] === 'dense';
      const partialText = parts[2] === 'dense'
        ? Array.from({ length: 80 }, (_, i) => `Section ${i + 1}: ${'The current turn retains its context and pending work. '.repeat(8)}`).join('\n\n')
        : 'Starting a long answer that will be cut short';
      // `:sticky` — the CLI ACKs the interrupt but the turn does not end (a tool
      // ignoring its abort signal). Pins the repeat-Stop escalation.
      const sticky = parts[3] === 'sticky';
      const abortDelay = Number(parts[3]) || 0;
      const sid = outputSessionId;
      const seq = ++snapshotTurnSeq;
      const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n');
      emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'running' });
      if (streamsText) {
        const msgId = `msg_long_${seq}`;
        const wrap = (ev) => ({ type: 'stream_event', event: ev, session_id: sid, parent_tool_use_id: null });
        emit(wrap({ type: 'message_start', message: { id: msgId, role: 'assistant', content: [], model: 'mock-model', usage: { input_tokens: 10, output_tokens: 0 } } }));
        emit(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
        emit(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: partialText } }));
      }
      const natural = setTimeout(() => {
        onInterrupt = null;
        const text = `Long turn ${seq} ran to completion.`;
        emit({ type: 'assistant', message: { id: `msg_long_done_${seq}`, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }, session_id: sid });
        emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: holdMs, num_turns: 1, result: text, session_id: sid, total_cost_usd: nextSnapshotCost(0.001), usage: { input_tokens: 20, output_tokens: 8 } });
        emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
        armSnapshotNextTurn();
      }, holdMs);
      if (!sticky) {
        onInterrupt = () => {
          clearTimeout(natural);
          if (abortDelay) setTimeout(emitAbortedTurnTail, abortDelay);
          else emitAbortedTurnTail();
        };
      }
      // Do NOT exit: stream-json FIFO mode stays alive between turns.
      return;
    }

    // 2a.-0.75. "snapshot-whale-turn[:<kb>]" — a WHALE turn: ~<kb> KB (default
    //         2048 = 2MB) of assistant lines, then result → idle, then STAY
    //         ALIVE like every other snapshot mode. Exercises the daemon
    //         tailer + incremental fold at whale volume through the REAL chain,
    //         where the unit/integration whale tests only append to disk.
    //
    //         TORN TAIL: the first MOCK_SNAPSHOT_WHALE_TORN (default 3) lines
    //         are written in TWO writes with a real pause between them, so the
    //         100ms tailer poll lands INSIDE the line and must park the
    //         fragment in its carry. process.stdout for a FILE fd is
    //         synchronous in Node on POSIX, and the daemon hands the CLI an
    //         O_APPEND fd on the jsonl — so the half-line is genuinely on disk
    //         before the pause. Without the carry, `v` would advance past the
    //         fragment and the tailer's `v > foldState.v` guard would skip the
    //         real line forever (the wedge tests/providers/
    //         daemon-snapshot-wiring.test.ts scenario 7 covers synthetically).
    //
    //         Knobs: MOCK_SNAPSHOT_WHALE_KB (total, default 2048),
    //                MOCK_SNAPSHOT_WHALE_LINE_KB (per line, default 64),
    //                MOCK_SNAPSHOT_WHALE_TORN (torn line count, default 3),
    //                MOCK_SNAPSHOT_WHALE_TEAR_MS (pause mid-line, default 250).
    //         An explicit ":<kb>" in the message wins over the env default so a
    //         smoke run can shrink the whale without touching the daemon env.
    if (effectiveMessage === 'snapshot-whale-turn' || effectiveMessage.startsWith('snapshot-whale-turn:')) {
      const arg = effectiveMessage.includes(':')
        ? effectiveMessage.split(':').slice(1).join(':').trim()
        : '';
      const argKb = parseInt(arg, 10);
      const totalKb = Number.isFinite(argKb) && argKb > 0
        ? argKb
        : Number(process.env.MOCK_SNAPSHOT_WHALE_KB || 2048);
      const lineKb = Math.max(1, Number(process.env.MOCK_SNAPSHOT_WHALE_LINE_KB || 64));
      const tornLines = Math.max(0, Number(process.env.MOCK_SNAPSHOT_WHALE_TORN ?? 3));
      const tearMs = Math.max(1, Number(process.env.MOCK_SNAPSHOT_WHALE_TEAR_MS || 250));
      const sid = outputSessionId;
      const seq = ++snapshotTurnSeq;
      const lineCount = Math.max(1, Math.ceil(totalKb / lineKb));
      const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      (async () => {
        let emitted = 0;
        for (let i = 0; i < lineCount; i++) {
          const payload = JSON.stringify({
            type: 'assistant',
            message: {
              id: `msg_snap_whale_${seq}_${i}`, type: 'message', role: 'assistant',
              model: modelFlag || 'mock-model',
              content: [{ type: 'text', text: 'w'.repeat(lineKb * 1024) }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: lineKb * 256 },
            },
            session_id: sid,
          });
          if (i < tornLines) {
            // Split mid-JSON (never on a newline) and pause ≥2 tailer ticks.
            const half = Math.floor(payload.length / 2);
            process.stdout.write(payload.slice(0, half));
            await sleep(tearMs);
            process.stdout.write(payload.slice(half) + '\n');
          } else {
            process.stdout.write(payload + '\n');
          }
          emitted += Buffer.byteLength(payload, 'utf8') + 1;
        }
        emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1, result: `whale turn ${seq}: ${emitted} bytes in ${lineCount} lines`, session_id: sid, total_cost_usd: nextSnapshotCost(0.01), usage: { input_tokens: 10, output_tokens: lineCount * lineKb * 256 } });
        emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
        armSnapshotNextTurn();
      })();
      // Do NOT exit: stream-json FIFO mode stays alive between turns.
      return;
    }

    // 2a.-0.5. "snapshot-init-edge" — reproduce incident ed347bde (2026-08-05):
    //         the CLI picks up a QUEUED send the instant the previous turn's
    //         result lands and emits a fresh `init` with NO
    //         session_state_changed{running} anywhere — the bare init is the
    //         ONLY evidence the new turn began (Fix E's init-after-result edge:
    //         bump _turnGen, flip process_status to running, pull the task phase
    //         back to IN_PROGRESS). Without Fix E the record reads idle and the
    //         task reads NEED_ACTION while the CLI visibly streams.
    //
    //         Emission order (deliberately NOT all in one tick):
    //           assistant → result → idle          ← turn A settles COMPLETELY
    //           …SETTLE_MS…                        ← walnut converges: idle + NEED_ACTION
    //           init → streaming deltas (heartbeat)← turn B, Fix E's ONLY signal
    //           …HOLD_MS…
    //           assistant → result → idle          ← turn B converges
    //
    //         The SETTLE_MS gap is load-bearing for a revert-proof assertion:
    //         it lets the observer first see the fully-settled state, so a later
    //         "running / IN_PROGRESS" reading cannot be the leftover of the
    //         send-time write — it can ONLY have come from the init edge.
    //         Knobs: MOCK_SNAPSHOT_EDGE_SETTLE_MS (default 5000),
    //                MOCK_SNAPSHOT_EDGE_HOLD_MS   (default 8000).
    //
    //         Both results go through nextSnapshotCost: this mode runs TWO turns
    //         on ONE process, so a flat per-turn total_cost_usd would make turn B
    //         look replayed and trip walnut's "stale result (cost unchanged)"
    //         kill-switch (see the nextSnapshotCost comment above).
    if (effectiveMessage === 'snapshot-init-edge' || effectiveMessage.startsWith('snapshot-init-edge:')) {
      const tag = effectiveMessage.includes(':')
        ? effectiveMessage.split(':').slice(1).join(':')
        : 'edge';
      const sid = outputSessionId;
      const seq = ++snapshotTurnSeq;
      const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n');
      const SETTLE_MS = Number(process.env.MOCK_SNAPSHOT_EDGE_SETTLE_MS || 5000);
      const HOLD_MS = Number(process.env.MOCK_SNAPSHOT_EDGE_HOLD_MS || 8000);

      // ── Turn A: normal answer, terminal result, companion idle. Fully settles.
      emit({ type: 'assistant', message: { id: `msg_edge_a_${seq}`, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: `turnA ${tag}` }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 10 } }, session_id: sid });
      emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 50, num_turns: 1, result: `turnA ${tag}`, session_id: sid, total_cost_usd: nextSnapshotCost(0.002), usage: { input_tokens: 30, output_tokens: 10 } });
      emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });

      let beat = null;
      setTimeout(() => {
        // ── Turn B: a BARE init. No {running}, no user line, no marker — this
        //    is the whole incident. Streaming follows immediately.
        emit({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model: modelFlag || 'mock-model', tools: ['Read'], mcp_servers: [], permissionMode: permissionMode || 'default' });
        emit({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'message_start', message: { id: `msg_edge_b_${seq}`, role: 'assistant', content: [], model: modelFlag || 'mock-model', usage: { input_tokens: 40, output_tokens: 0 } } } });
        emit({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
        emit({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'turnB ' } } });
        // Heartbeat deltas keep the stream visibly alive across the hold window,
        // so an observer sees a genuinely-running turn rather than a still frame.
        beat = setInterval(() => {
          emit({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '.' } } });
        }, 1000);
        beat.unref?.();
      }, SETTLE_MS);

      setTimeout(() => {
        if (beat) clearInterval(beat);
        emit({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } });
        emit({ type: 'assistant', message: { id: `msg_edge_b_${seq}`, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: `turnB ${tag} done` }], stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 20 } }, session_id: sid });
        emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: HOLD_MS, num_turns: 2, result: `turnB ${tag} done`, session_id: sid, total_cost_usd: nextSnapshotCost(0.003), usage: { input_tokens: 40, output_tokens: 20 } });
        emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
        armSnapshotNextTurn();
      }, SETTLE_MS + HOLD_MS);
      // Do NOT exit: stream-json FIFO mode stays alive between turns.
      return;
    }

    // 2a.0. "truncated-success" — reproduce the 2026-06-04 session 1fc886da bug:
    //        the stream cuts off mid-message (message_delta carries
    //        stop_reason:null) yet the CLI still reports result subtype=success.
    //        This is the headline forensic-observability fingerprint: the
    //        truncated-success invariant must auto-open an incident for it.
    if (effectiveMessage === 'truncated-success') {
      const msgId = 'msg_mock_trunc_' + outputSessionId.slice(0, 6);
      function emitTrunc(line) { process.stdout.write(JSON.stringify(line) + '\n'); }
      function wrapTrunc(ev) { return { type: 'stream_event', event: ev, session_id: outputSessionId, parent_tool_use_id: null }; }

      // Some real text streams in, then the stream is cut.
      emitTrunc(wrapTrunc({ type: 'message_start', message: { id: msgId, role: 'assistant', content: [], model: modelFlag || 'mock-model', usage: { input_tokens: 10, output_tokens: 0 } } }));
      emitTrunc(wrapTrunc({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      emitTrunc(wrapTrunc({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working on it' } }));
      // The cut: message_delta with stop_reason:null (NOT 'end_turn') — sets _lastStopReason=null.
      emitTrunc(wrapTrunc({ type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 3 } }));

      // …yet the CLI reports a clean success. This is the silent-success bug.
      const resultEvent = {
        type: 'result', subtype: 'success', is_error: false,
        duration_ms: 50, num_turns: 1, result: 'Working on it',
        session_id: outputSessionId, total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 3 },
      };
      process.stdout.write(JSON.stringify(resultEvent) + '\n', () => process.exit(0));
      return;
    }

    // 2a.0b. "timeout-error" — reproduce upstream retry exhaustion (b12): the turn
    //        ends with an is_error result whose text contains "Request timed out"
    //        (what the CLI surfaces when it burns through its finite API retries
    //        during a region-wide Bedrock degradation window). No assistant text is
    //        emitted, so this is a real hard error (not a soft ede downgrade). Drives
    //        the auto-continue scheduler. The optional "timeout-error:<tag>" form lets
    //        a test distinguish successive turns in the echoed result of the FIRST turn.
    // WALNUT_MOCK_CONTINUE_TIMEOUT=1 makes a resumed `continue` turn ALSO time out —
    // used only by the auto-continue hourly-cap integration test to drive repeated
    // retry-exhaustion results without affecting any other test.
    const continueAlwaysTimesOut = process.env.WALNUT_MOCK_CONTINUE_TIMEOUT === '1'
      && resume && effectiveMessage === 'continue';
    if (effectiveMessage === 'timeout-error' || effectiveMessage.startsWith('timeout-error:') || continueAlwaysTimesOut) {
      const tag = effectiveMessage.includes(':') ? effectiveMessage.split(':').slice(1).join(':') : '';
      const resultEvent = {
        type: 'result', subtype: 'error_during_execution', is_error: true,
        duration_ms: 50, num_turns: 1,
        result: `API Error: Request timed out${tag ? ` [${tag}]` : ''}`,
        session_id: outputSessionId, total_cost_usd: 0.0,
        usage: { input_tokens: 10, output_tokens: 0 },
      };
      process.stdout.write(JSON.stringify(resultEvent) + '\n', () => process.exit(0));
      return;
    }

    // 2a.0c. "replayed-turn" — reproduce upstream ACP issue #453 (fix #858): a
    //        cache-replayed turn answers on the `result` line ALONE. Zero output
    //        tokens, no stream_event deltas, no consolidated `assistant` message.
    //        Without the result-text fallback the UI renders an empty turn, since
    //        session:result is only a turn boundary and history keeps no result
    //        lines. The optional "replayed-turn:<text>" form sets the answer text.
    if (effectiveMessage === 'replayed-turn' || effectiveMessage.startsWith('replayed-turn:')) {
      const answer = effectiveMessage.includes(':')
        ? effectiveMessage.split(':').slice(1).join(':')
        : 'This answer arrived on the result line only.';
      const resultEvent = {
        type: 'result', subtype: 'success', is_error: false,
        duration_ms: 20, num_turns: 1, result: answer,
        session_id: outputSessionId, total_cost_usd: 0,
        usage: { input_tokens: 12, output_tokens: 0 },
      };
      process.stdout.write(JSON.stringify(resultEvent) + '\n', () => process.exit(0));
      return;
    }

    if (effectiveMessage === 'resumed-background-agent-test') {
      const sid = outputSessionId;
      const emit = line => process.stdout.write(JSON.stringify({ ...line, session_id: sid }) + '\n');
      const task = (subtype, toolUseId, extra = {}) => emit({ type: 'system', subtype, task_id: 'resumed-agent', tool_use_id: toolUseId, ...extra });
      const answer = (id, text) => emit({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } } });
      emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
      task('task_started', 'call-first', { task_type: 'local_agent', is_backgrounded: true, description: 'First verification pass' });
      task('task_updated', undefined, { patch: { status: 'completed' } });
      task('task_notification', 'call-first', { status: 'completed' });
      task('task_started', 'call-second', { task_type: 'local_agent', is_backgrounded: true, description: 'Second verification pass' });
      answer('msg_resumed_main', 'The same background agent is running its second verification pass.');
      emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'Second pass continues.', total_cost_usd: 0 });
      emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
      setTimeout(() => {
        task('task_progress', 'call-second', { usage: { total_tokens: 100, tool_uses: 2 } });
        task('task_notification', 'call-first', { status: 'completed' });
        task('task_progress', 'call-first', { usage: { total_tokens: 80 } });
      }, 2500);
      setTimeout(() => {
        task('task_updated', undefined, { patch: { status: 'completed' } });
        task('task_notification', 'call-second', { status: 'completed' });
        emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
        emit({ type: 'system', subtype: 'session_state_changed', state: 'running' });
        answer('msg_resumed_done', 'The second verification pass is complete.');
        emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'The second verification pass is complete.', origin: { kind: 'task-notification' }, total_cost_usd: 0 });
        emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
      }, 12000);
      return;
    }

    // 2a.0d. "hold-turn-test[:<summary>]" — reproduce upstream ACP #870: a turn
    //        launches an async SUBAGENT and its terminal `result` (plus the CLI's
    //        immediate trailing idle) arrives while the subagent is still live.
    //        Real-CLI-verified cycle (2.1.206):
    //          user result → idle → (subagent works) → task_notification →
    //          followup summary → result(origin task-notification)
    //        The turn must stay open (no SESSION_RESULT) across the early result
    //        AND the early idle, and complete when the followup result lands —
    //        with the followup summary as the answer. No trailing idle after the
    //        followup result is emitted (that's the lost-idle wedge #870 heals).
    if (effectiveMessage === 'hold-turn-test' || effectiveMessage.startsWith('hold-turn-test:')) {
      const summary = effectiveMessage.includes(':')
        ? effectiveMessage.split(':').slice(1).join(':')
        : 'The background agent finished and produced its report.';
      const sid = outputSessionId;
      function emitHold(line) { process.stdout.write(JSON.stringify(line) + '\n'); }
      emitHold({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'running' });
      emitHold({ type: 'assistant', message: { id: 'msg_hold_main', type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: 'Launching a background agent — will report back.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 25 } }, session_id: sid });
      emitHold({ type: 'system', subtype: 'task_started', session_id: sid, task_id: 'hold-sub-1', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Background reader agent' });
      emitHold({ type: 'system', subtype: 'background_tasks_changed', session_id: sid, tasks: [{ task_id: 'hold-sub-1', task_type: 'local_agent', description: 'Background reader agent' }] });
      // The user turn's terminal result + immediate idle — subagent still live: HELD.
      emitHold({ type: 'result', subtype: 'success', is_error: false, duration_ms: 900, num_turns: 1, result: 'Launching a background agent — will report back.', session_id: sid, total_cost_usd: 0.003, usage: { input_tokens: 100, output_tokens: 25 } });
      emitHold({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
      // Hold window sized for BROWSER assertions: the spec must observe the
      // held-open state (status still 'running') AFTER the early result+idle
      // batch — page load + panel render costs seconds, so a sub-second window
      // is unobservable. Unit tests cover the same lanes with zero delay.
      const HOLD_MS = Number(process.env.MOCK_HOLD_TURN_MS || 10000);
      setTimeout(() => {
        // Subagent works (progress heartbeat), then reaches terminal.
        emitHold({ type: 'system', subtype: 'task_progress', session_id: sid, task_id: 'hold-sub-1', summary: 'reading files', usage: { total_tokens: 800 } });
        emitHold({ type: 'system', subtype: 'task_updated', session_id: sid, task_id: 'hold-sub-1', patch: { status: 'completed' } });
        emitHold({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: 'hold-sub-1', status: 'completed' });
        emitHold({ type: 'system', subtype: 'background_tasks_changed', session_id: sid, tasks: [] });
      }, HOLD_MS);
      setTimeout(() => {
        // The promised followup summary streams, then its result (task-notification
        // origin) lands. Deliberately NO trailing idle afterwards.
        emitHold({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'running' });
        emitHold({ type: 'assistant', message: { id: 'msg_hold_followup', type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: summary }], stop_reason: 'end_turn', usage: { input_tokens: 60, output_tokens: 40 } }, session_id: sid });
        emitHold({ type: 'result', subtype: 'success', is_error: false, duration_ms: 700, num_turns: 1, result: summary, session_id: sid, total_cost_usd: 0.006, origin: { kind: 'task-notification' }, usage: { input_tokens: 60, output_tokens: 40 } });
      }, HOLD_MS + 4000);
      // Do NOT exit: FIFO-mode CLI stays alive between turns.
      return;
    }

    // 2a. For "plan-test" messages, emit Write (to plans/) + ExitPlanMode tool_use
    if (effectiveMessage === 'plan-test' || effectiveMessage.startsWith('plan-test:')) {
      // Extract optional plan file path from "plan-test:/path/to/plan.md"
      const planPath = effectiveMessage.includes(':')
        ? effectiveMessage.split(':').slice(1).join(':')
        : `${process.env.HOME || '/tmp'}/.claude/plans/mock-plan-${outputSessionId.slice(0, 8)}.md`;

      // Write tool_use — simulates Claude writing the plan file
      const writeEvent = {
        type: 'assistant',
        slug: 'mock-planning-slug',
        message: {
          id: 'msg_mock_plan_write',
          type: 'message',
          role: 'assistant',
          model: 'mock-model',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_mock_write_plan',
              name: 'Write',
              input: { file_path: planPath, content: '# Plan\n\nStep 1: Do the thing\nStep 2: Verify the thing' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 200, output_tokens: 100 },
        },
        session_id: outputSessionId,
      };
      process.stdout.write(JSON.stringify(writeEvent) + '\n');

      // ExitPlanMode tool_use — signals plan is complete
      const exitPlanEvent = {
        type: 'assistant',
        slug: 'mock-planning-slug',
        message: {
          id: 'msg_mock_plan_exit',
          type: 'message',
          role: 'assistant',
          model: 'mock-model',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_mock_exit_plan',
              name: 'ExitPlanMode',
              input: {},
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 10 },
        },
        session_id: outputSessionId,
      };
      process.stdout.write(JSON.stringify(exitPlanEvent) + '\n');
    }

    // 2a.5. Stream-partial test — mimics `--include-partial-messages` output.
    //       Emits the same shape the real Claude CLI produces so we exercise the
    //       stream_event parse path, dedup with final assistant, thinking/delta
    //       variants, and the unknown catch-all.
    //
    //   Triggers (exact message or prefix):
    //     "stream-partial-test"           → text_delta stream + full assistant
    //     "stream-partial-thinking"       → thinking_delta stream
    //     "stream-partial-tool"           → content_block_start (tool_use) +
    //                                       input_json_delta stream + final assistant
    //     "stream-partial-unknown"        → includes a made-up stream_event type
    //                                       and a made-up top-level JSONL type
    //     "stream-partial-tool-progress"  → tool_progress heartbeat (must NOT reach UI)
    //     "stream-partial-command-lifecycle" → command_lifecycle started/completed
    //                                       bracket (CLI 2.1.25x; must NOT reach UI)
    //     "stream-partial-signature"      → signature_delta (must NOT reach UI)
    //
    //   The full text streamed is 'Hello, world!' split into small deltas.
    if (effectiveMessage.startsWith('stream-partial-')) {
      const mode = effectiveMessage.slice('stream-partial-'.length) || 'test';
      const msgId = 'msg_mock_stream_' + outputSessionId.slice(0, 6);

      function emitStream(line) { process.stdout.write(JSON.stringify(line) + '\n'); }
      function wrap(ev) { return { type: 'stream_event', event: ev, session_id: outputSessionId, parent_tool_use_id: null }; }

      // CLI 2.1.25x brackets every turn: `started` lands before the turn's own
      // events, `completed` AFTER the result line (real order, captured from a
      // 2.1.258 stream). Neither is conversation content.
      const commandUuid = 'cmd-mock-' + outputSessionId.slice(0, 6);
      const lifecycle = (state) => ({
        type: 'command_lifecycle', command_uuid: commandUuid, state,
        uuid: `mock-lifecycle-${state}`, session_id: outputSessionId,
      });
      if (mode === 'command-lifecycle') emitStream(lifecycle('started'));

      // message_start
      emitStream(wrap({ type: 'message_start', message: { id: msgId, role: 'assistant', content: [], model: modelFlag || 'mock-model', usage: { input_tokens: 10, output_tokens: 0 } } }));

      if (mode === 'unknown-top-level') {
        // Emit a completely new top-level JSONL type (not wrapped in stream_event)
        emitStream({ type: 'never_seen_before', payload: { ping: 'pong' }, session_id: outputSessionId });
      }

      if (mode === 'tool-progress') {
        emitStream({
          type: 'tool_progress',
          tool_use_id: 'toolu_mock_long_running',
          tool_name: 'Bash',
          parent_tool_use_id: null,
          elapsed_time_seconds: 30,
          heartbeat: true,
          session_id: outputSessionId,
          uuid: 'mock-tool-progress-uuid',
        });
      }

      if (mode === 'unknown' || mode === 'unknown-stream-event') {
        // Unknown stream_event subtype — should go through unknown catch-all
        emitStream(wrap({ type: 'future_sse_event_xyz', payload: { x: 1 } }));
      }

      // A reply long enough to DRAG A SELECTION INSIDE while it is still
      // growing: 'Hello, world!' is three words, so a mouse drag over it can't
      // tell "the pill survived the stream" from "the pill was never placed".
      // Honours chunk-delay: so the paragraph arrives over seconds.
      if (mode === 'long-text') {
        (async () => {
          const pause = () => chunkDelayMs > 0
            ? new Promise((r) => setTimeout(r, chunkDelayMs))
            : Promise.resolve();
          // Deliberately shares no phrase with the seeded fixture transcripts: a
          // test that drags over the STREAMING reply must not be able to match
          // the same words in an already-persisted message instead.
          const sentences = [
            'The scheduler drains one queue at a time and never blocks on a slow writer. ',
            'Every batch is fenced by its own token, so a retry cannot double-apply it. ',
            'Metrics are emitted per batch rather than per record, which keeps the log small. ',
            'The last pass verifies checksums and then flips the read path over. ',
          ];
          emitStream(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
          for (const s of sentences) {
            emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: s } }));
            await pause();
          }
          emitStream(wrap({ type: 'content_block_stop', index: 0 }));
          emitStream({
            type: 'assistant',
            message: {
              id: msgId, role: 'assistant', model: 'mock-model',
              content: [{ type: 'text', text: sentences.join('') }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 40 },
            },
            session_id: outputSessionId,
          });
          emitStream(wrap({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }));
          emitStream(wrap({ type: 'message_stop' }));
          process.stdout.write(JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
            duration_ms: 50, num_turns: 1, result: sentences.join(''),
            session_id: outputSessionId, total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 40 },
          }) + '\n', () => process.exit(0));
        })();
        return;
      }

      if (mode === 'thinking-then-text') {
        // Realistic extended-thinking flow:
        //   SSE: index=0 thinking block → index=1 text block
        //   assistant: content only carries the text block
        // This used to cause text duplication because the dedup trackingKey
        // didn't match between paths. Regression test for that bug.
        // With a chunk-delay: prefix the deltas are spaced out (async IIFE) so
        // browser tests can observe partial text mid-turn; the event SEQUENCE
        // is identical either way.
        (async () => {
          const pause = () => chunkDelayMs > 0
            ? new Promise((r) => setTimeout(r, chunkDelayMs))
            : Promise.resolve();
          emitStream(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
          for (const t of ['Hmm ', 'let me ', 'think']) {
            emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } }));
            await pause();
          }
          emitStream(wrap({ type: 'content_block_stop', index: 0 }));

          emitStream(wrap({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
          for (const chunk of ['Hel', 'lo,', ' wor', 'ld', '!']) {
            emitStream(wrap({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: chunk } }));
            await pause();
          }
          emitStream(wrap({ type: 'content_block_stop', index: 1 }));

          // Final assistant carries ONLY the text (not thinking) — Claude Code
          // strips thinking from the persisted message. This is where dedup
          // was breaking: blockIdx=0 in the loop, but stream used index=1.
          emitStream({
            type: 'assistant',
            message: {
              id: msgId, role: 'assistant', model: 'mock-model',
              content: [{ type: 'text', text: 'Hello, world!' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 5 },
            },
            session_id: outputSessionId,
          });

          emitStream(wrap({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }));
          emitStream(wrap({ type: 'message_stop' }));
          const resultEvent = {
            type: 'result', subtype: 'success', is_error: false,
            duration_ms: 50, num_turns: 1, result: 'Hello, world!',
            session_id: outputSessionId, total_cost_usd: 0.001,
            usage: { input_tokens: 10, output_tokens: 5 },
          };
          process.stdout.write(JSON.stringify(resultEvent) + '\n', () => process.exit(0));
        })();
        return;
      }

      if (mode === 'tool') {
        // Tool use — content_block_start yields tool id+name; input streams via input_json_delta
        emitStream(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_mock_stream', name: 'Bash', input: {} } }));
        emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"comm' } }));
        emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'and":"ls' } }));
        emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' -la"}' } }));
        emitStream(wrap({ type: 'content_block_stop', index: 0 }));

        // Final full assistant (what the real CLI writes once the block completes)
        emitStream({
          type: 'assistant',
          message: {
            id: msgId, role: 'assistant', model: 'mock-model',
            content: [{ type: 'tool_use', id: 'toolu_mock_stream', name: 'Bash', input: { command: 'ls -la' } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 50, output_tokens: 10 },
          },
          session_id: outputSessionId,
        });
      } else {
        // Text or thinking streaming
        emitStream(wrap({ type: 'content_block_start', index: 0, content_block: { type: mode === 'thinking' ? 'thinking' : 'text', text: '' } }));

        if (mode === 'thinking') {
          for (const chunk of ['Let ', 'me ', 'think ', 'about ', 'this…']) {
            emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: chunk } }));
          }
        } else if (mode === 'signature') {
          // signature_delta should be DROPPED (not reach UI)
          emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc123def' } }));
          // And a normal text_delta so the test has at least one visible delta
          emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }));
        } else {
          // text: emit 'Hello, world!' as 5 deltas
          for (const chunk of ['Hel', 'lo,', ' wor', 'ld', '!']) {
            emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }));
          }
        }

        emitStream(wrap({ type: 'content_block_stop', index: 0 }));

        // Final full assistant — must dedup against accumulated deltas above
        const finalText = mode === 'thinking' ? ''
          : mode === 'signature' ? 'OK'
          : 'Hello, world!';
        if (finalText || mode === 'thinking') {
          emitStream({
            type: 'assistant',
            message: {
              id: msgId, role: 'assistant', model: 'mock-model',
              content: mode === 'thinking'
                ? [{ type: 'thinking', thinking: 'Let me think about this…' }]
                : [{ type: 'text', text: finalText }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 5 },
            },
            session_id: outputSessionId,
          });
        }
      }

      // message_stop + message_delta for usage/stop_reason
      emitStream(wrap({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }));
      emitStream(wrap({ type: 'message_stop' }));

      // Final result
      const resultEvent = {
        type: 'result', subtype: 'success', is_error: false,
        duration_ms: 50, num_turns: 1,
        result: mode === 'tool' ? 'Done.' : (mode === 'thinking' ? 'Let me think about this…' : (mode === 'signature' ? 'OK' : 'Hello, world!')),
        session_id: outputSessionId,
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 10 },
      };
      const tail = JSON.stringify(resultEvent) + '\n'
        + (mode === 'command-lifecycle' ? JSON.stringify(lifecycle('completed')) + '\n' : '');
      process.stdout.write(tail, () => process.exit(0));
      return; // skip default assistant+result tail
    }

    // 2a.7. "workflow-test" — reproduce a dynamic-workflow turn: the main turn
    //        emits its own `result` ("launched in background") while N background
    //        subagents are still running, then drains them via task_notification,
    //        and only AFTER all are done emits the authoritative
    //        session_state_changed{idle}. This is the exact shape that used to be
    //        misread as turn-over on the first `result`. The session must stay
    //        running until idle, and emit session:background-tasks snapshots.
    if (effectiveMessage === 'workflow-test') {
      function emitWf(line) { process.stdout.write(JSON.stringify(line) + '\n'); }
      const sid = outputSessionId;

      // Main turn's text + its own result (NOT a turn boundary — bg work pending).
      emitWf({
        type: 'assistant',
        message: {
          id: 'msg_wf_main', type: 'message', role: 'assistant', model: 'mock-model',
          content: [{ type: 'text', text: 'Workflow launched in background' }],
          stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 30 },
        },
        session_id: sid,
      });
      // The dynamic workflow opens as ONE top-level task carrying the generated
      // script (prompt) + name. The N parallel subagents ride inside task_progress's
      // workflow_progress[] — NOT as separate task_started events (matches real CLI).
      emitWf({
        type: 'system', subtype: 'task_started', session_id: sid, task_id: 'wf-top',
        task_type: 'local_workflow', workflow_name: 'review-changes',
        description: 'Review changes across two dimensions',
        prompt: "export const meta = { name: 'review-changes', phases: [{title:'Fan out'},{title:'Synthesize'}] }\nphase('Fan out')\nawait parallel([() => agent('review bugs'), () => agent('review perf')])",
      });
      // The main turn's own result — must NOT complete the turn.
      emitWf({ type: 'result', subtype: 'success', is_error: false, duration_ms: 200, num_turns: 1, result: 'Workflow launched in background', session_id: sid, total_cost_usd: 0.002, usage: { input_tokens: 100, output_tokens: 30 } });

      // Progress heartbeats carry workflow_progress[] snapshots. The CLI sends only
      // the CURRENTLY ACTIVE agents per snapshot, plus "ghost" entries (no agentId)
      // that the backend must skip. Then completions, then the authoritative idle —
      // spaced out so the E2E can observe the "still running" window.
      setTimeout(() => {
        emitWf({ type: 'system', subtype: 'task_progress', session_id: sid, task_id: 'wf-top', summary: 'Fan out', usage: { total_tokens: 4600 }, workflow_progress: [
          { type: 'workflow_phase', index: 1, title: 'Fan out' },
          { type: 'workflow_phase', index: 2, title: 'Synthesize' },
          // ghost placeholders (no agentId) — must be ignored by the parser:
          { type: 'workflow_agent', index: 1, label: 'bugs', phaseIndex: 1, phaseTitle: 'Fan out', state: 'start' },
          { type: 'workflow_agent', index: 2, label: 'perf', phaseIndex: 1, phaseTitle: 'Fan out', state: 'start' },
          // real agents with ids:
          { type: 'workflow_agent', index: 1, label: 'bugs', phaseIndex: 1, phaseTitle: 'Fan out', agentId: 'wfa-bugs', model: 'global.anthropic.claude-opus-4-8[1m]', state: 'start', startedAt: 1, promptPreview: 'Review bugs in the diff' },
          { type: 'workflow_agent', index: 2, label: 'perf', phaseIndex: 1, phaseTitle: 'Fan out', agentId: 'wfa-perf', model: 'global.anthropic.claude-opus-4-8[1m]', state: 'start', startedAt: 1, promptPreview: 'Review perf in the diff' },
        ] });
      }, 150);
      setTimeout(() => {
        // An intermediate result the CLI feeds back from a subagent completion — origin marks it noise.
        emitWf({ type: 'result', subtype: 'success', is_error: false, duration_ms: 100, num_turns: 1, result: 'Subagent A found 2 issues', session_id: sid, total_cost_usd: 0.004, origin: { kind: 'task-notification' }, usage: { input_tokens: 40, output_tokens: 15 } });
        // Later snapshot: the agents are now terminal (per-phase active set) with resultPreview.
        emitWf({ type: 'system', subtype: 'task_progress', session_id: sid, task_id: 'wf-top', summary: 'Synthesize', usage: { total_tokens: 9000 }, workflow_progress: [
          { type: 'workflow_phase', index: 1, title: 'Fan out' },
          { type: 'workflow_phase', index: 2, title: 'Synthesize' },
          { type: 'workflow_agent', index: 1, label: 'bugs', phaseIndex: 1, phaseTitle: 'Fan out', agentId: 'wfa-bugs', state: 'done', tokens: 1200, durationMs: 1800, resultPreview: 'Found 2 bugs' },
          { type: 'workflow_agent', index: 2, label: 'perf', phaseIndex: 1, phaseTitle: 'Fan out', agentId: 'wfa-perf', state: 'done', tokens: 3400, durationMs: 2100, resultPreview: 'Found 1 perf issue' },
        ] });
        // The whole workflow task terminates (drains the in-flight counter to 0).
        emitWf({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: 'wf-top', status: 'completed' });
      }, 300);
      setTimeout(() => {
        // Authoritative turn-over — fires once, strictly after all bg work done.
        emitWf({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
        // Give the runner a tick to process idle before the process would exit;
        // keep the process alive (FIFO mode) — the daemon reaps it on idle timer.
      }, 450);
      // Do NOT exit: in stream-json FIFO mode the CLI stays alive between turns.
      return;
    }

    // 2a.8. "workflow-test-big" — a LARGE fan-out (10 subagents in one phase) so the
    //        panel's density-bar Level-of-Detail path (>DENSITY_THRESHOLD) is exercised
    //        by the Playwright UI verification. Same lifecycle shape as workflow-test.
    if (effectiveMessage === 'workflow-test-big') {
      function emitWf(line) { process.stdout.write(JSON.stringify(line) + '\n'); }
      const sid = outputSessionId;
      const N = 10;
      const mkAgents = (state) => Array.from({ length: N }, (_, i) => ({
        type: 'workflow_agent', index: i + 1, label: `review:file-${i + 1}`,
        phaseIndex: 1, phaseTitle: 'Review', agentId: `wfa-big-${i + 1}`,
        model: 'global.anthropic.claude-sonnet-4-6', state,
        startedAt: 1, ...(state === 'done' ? { tokens: 1500 + i * 10, durationMs: 2000 + i * 50, resultPreview: `Reviewed file-${i + 1}` } : { promptPreview: `Review file-${i + 1}` }),
      }));

      emitWf({ type: 'assistant', message: { id: 'msg_wf_big', type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: 'Big workflow launched' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 30 } }, session_id: sid });
      emitWf({ type: 'system', subtype: 'task_started', session_id: sid, task_id: 'wf-big', task_type: 'local_workflow', workflow_name: 'review-all-files', description: 'Review 10 files in parallel', prompt: "export const meta = { name: 'review-all-files' }\nphase('Review')\nawait parallel(files.map(f => () => agent('review '+f)))" });
      emitWf({ type: 'result', subtype: 'success', is_error: false, duration_ms: 200, num_turns: 1, result: 'Big workflow launched', session_id: sid, total_cost_usd: 0.002, usage: { input_tokens: 100, output_tokens: 30 } });

      setTimeout(() => {
        emitWf({ type: 'system', subtype: 'task_progress', session_id: sid, task_id: 'wf-big', summary: 'Review', usage: { total_tokens: 12000 }, workflow_progress: [
          { type: 'workflow_phase', index: 1, title: 'Review' },
          ...mkAgents('start'),
        ] });
      }, 150);
      setTimeout(() => {
        emitWf({ type: 'system', subtype: 'task_progress', session_id: sid, task_id: 'wf-big', summary: 'Review done', usage: { total_tokens: 30000 }, workflow_progress: [
          { type: 'workflow_phase', index: 1, title: 'Review' },
          ...mkAgents('done'),
        ] });
        emitWf({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: 'wf-big', status: 'completed' });
      }, 300);
      setTimeout(() => {
        emitWf({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
      }, 450);
      return;
    }

    // 2a.9. "backgrounded-test" — reproduce incident 07fffbe5: a turn spawns a
    //        local_bash task, the CLI detaches it via task_updated{is_backgrounded:true}
    //        and then ends the turn (result + idle) WITHOUT ever emitting a terminal
    //        event for that task. The turn must complete anyway: gating turn-over on
    //        the backgrounded task held a finished turn "Running" for the task's full
    //        lifetime (a 16-min backgrounded grep in production). Unlike workflow-test,
    //        this scenario deliberately NEVER drains 'bg-detached'.
    if (effectiveMessage === 'backgrounded-test' || effectiveMessage === 'backgrounded-error-test') {
      function emitBg(line) { process.stdout.write(JSON.stringify(line) + '\n'); }
      const sid = outputSessionId;
      const isError = effectiveMessage === 'backgrounded-error-test';
      let backgroundCost = 0.002;
      if (isError) {
        onUserLine = (message) => {
          const stillRunning = message.startsWith('check background status');
          const reply = stillRunning ? 'Status checked; background command is still running.' : 'Background check finished; followup received.';
          if (!stillRunning) emitBg({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: 'bg-detached', status: 'completed' });
          emitBg({ type: 'assistant', session_id: sid, message: {
            id: stillRunning ? 'msg_bg_status' : 'msg_bg_followup', type: 'message', role: 'assistant', model: 'mock-model',
            content: [{ type: 'text', text: reply }],
            stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 10 },
          } });
          emitBg({ type: 'result', subtype: 'success', session_id: sid, is_error: false,
            result: reply, num_turns: 1,
            total_cost_usd: (backgroundCost += 0.002), usage: { input_tokens: 20, output_tokens: 10 },
          });
          emitBg({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
        };
      }

      emitBg({
        type: 'assistant',
        message: {
          id: 'msg_bg_main', type: 'message', role: 'assistant', model: 'mock-model',
          content: [{ type: 'text', text: 'Started a detached background command' }],
          stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 },
        },
        session_id: sid,
      });
      // The bash task opens like any background task…
      emitBg({
        type: 'system', subtype: 'task_started', session_id: sid, task_id: 'bg-detached',
        task_type: 'local_bash', description: 'long-running grep (backgrounded)',
      });
      setTimeout(() => {
        // …then the CLI detaches it from the turn. NO terminal event will EVER follow
        // for 'bg-detached' — the CLI's own turn-end does not wait for it.
        emitBg({ type: 'system', subtype: 'task_updated', session_id: sid, task_id: 'bg-detached', patch: { is_backgrounded: true } });
      }, 150);
      setTimeout(() => {
        // The turn's real result — must complete despite the live backgrounded task.
        emitBg({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, duration_ms: 200, num_turns: 1, result: isError ? 'Foreground check failed; background check is still running' : 'Command backgrounded; moving on', session_id: sid, total_cost_usd: 0.002, usage: { input_tokens: 100, output_tokens: 20 } });
      }, 300);
      setTimeout(() => {
        emitBg({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
      }, 450);
      // Do NOT exit (stream-json FIFO mode stays alive between turns) and do NOT
      // drain 'bg-detached' — that non-terminal task is the whole point.
      return;
    }

    // 2a.10. "title-test[:<text>]" — a normal successful turn that KEEPS THE
    //         PROCESS ALIVE afterwards (real FIFO-mode CLI behavior), so the
    //         persistent control-protocol listener above can answer a
    //         generate_session_title control_request that Walnut sends after
    //         the turn (session-auto-title hook e2e). Every other mock mode
    //         exits at result, which would kill the control round-trip.
    if (effectiveMessage === 'title-test' || effectiveMessage.startsWith('title-test:')) {
      const text = effectiveMessage.includes(':')
        ? effectiveMessage.split(':').slice(1).join(':')
        : 'Turn done; staying alive for control requests.';
      process.stdout.write(JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_mock_title', type: 'message', role: 'assistant', model: 'mock-model',
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: outputSessionId,
      }) + '\n');
      process.stdout.write(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false,
        duration_ms: 30, num_turns: 1, result: text,
        session_id: outputSessionId, total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5 },
      }) + '\n');
      // Do NOT exit: stream-json FIFO mode stays alive between turns; the
      // stdin control listener answers generate_session_title requests.
      return;
    }

    // 2b. For "tool-test" messages, emit a tool_use + tool_result before the text
    if (effectiveMessage === 'tool-test') {
      const toolUseEvent = {
        type: 'assistant',
        message: {
          id: 'msg_mock_001',
          type: 'message',
          role: 'assistant',
          model: 'mock-model',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_mock_001',
              name: 'Read',
              input: { file_path: '/tmp/test.txt' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 20 },
        },
        session_id: outputSessionId,
      };
      process.stdout.write(JSON.stringify(toolUseEvent) + '\n');

      const toolResultEvent = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_mock_001',
              content: 'File contents here',
            },
          ],
        },
        session_id: outputSessionId,
      };
      process.stdout.write(JSON.stringify(toolResultEvent) + '\n');
    }

    // 3. Assistant message with text content.
    //
    // The id must be UNIQUE PER TURN, the way the real CLI's `msg_…` is unique per
    // API response — several layers treat a message id as a global identity, and a
    // constant here emits a shape production cannot produce. Concretely: the web
    // client absorbs a streaming block as soon as its msgId appears ANYWHERE in
    // history (web/src/cache/promote-blocks.ts), and session-history merges same-id
    // lines into ONE message (src/core/session-history.ts). While this was the
    // constant `msg_mock_002`, a SECOND turn on the same session (this path exits
    // after `result`, so turn 2 is a fresh process that reused the constant) had
    // its reply absorbed by turn 1's history row and folded into turn 1's message:
    // the answer never rendered live, and a reload showed it glued onto the first
    // reply. pid + ms is enough — one process runs one plain turn. The multi-turn
    // snapshot modes already mint per-turn ids for the same reason.
    const assistantEvent = {
      type: 'assistant',
      message: {
        id: `msg_mock_002_${process.pid.toString(36)}${Date.now().toString(36)}`,
        type: 'message',
        role: 'assistant',
        model: 'mock-model',
        content: [{ type: 'text', text: resultText }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      session_id: outputSessionId,
    };
    process.stdout.write(JSON.stringify(assistantEvent) + '\n');

    // 4. Final result event
    const resultEvent = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1500,
      num_turns: 1,
      result: resultText,
      session_id: outputSessionId,
      total_cost_usd: 0.003,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    // Flush stdout before exiting to prevent truncated output
    process.stdout.write(JSON.stringify(resultEvent) + '\n', () => process.exit(0));
  }

  // Init-only spawn (empty first message, FIFO mode): the real CLI idles on
  // stdin after init and adopts the first FIFO user message as its turn — it
  // does NOT emit an empty-turn result and exit. Mirror that: wait for the
  // persistent stdin listener to hand us the first user line, adopt it, then
  // run the normal turn for it. Without this, an init-only mock exited ~2s in,
  // and every later send raced a cold --resume respawn (flaky control round-trips).
  if (inputFormat === 'stream-json' && !message) {
    // Orphan guards — this branch parks on stdin indefinitely (real-CLI
    // behavior), which a SIGKILLed test run would leak forever (this machine
    // has wedged on leaked test processes before). Self-exit when the parent
    // (mock daemon) dies or after a hard 5-min ceiling.
    const orphanCheck = setInterval(() => {
      try { process.kill(process.ppid, 0); } catch { process.exit(0); }
      if (process.ppid === 1) process.exit(0);
    }, 5000);
    orphanCheck.unref?.();
    const hardStop = setTimeout(() => process.exit(0), 5 * 60_000);
    hardStop.unref?.();
    (async () => {
      message = await new Promise((resolve) => { pendingUserResolve = resolve; });
      computeMessageParts();
      // Known limits of the adopted-message path (extend when a test needs one):
      // mode-change:* (matched before adoption), slow:'s delay (computed but not
      // awaited here), and error/parse-error (checked at top level) don't apply
      // when they arrive as the adopted first FIFO message.
      emitRemainingEvents();
    })();
  } else {
    // For mode-change messages, ensure remaining events fire AFTER the mode-change system event
    const effectiveDelay = modeChangeMatch ? Math.max(slowDelayMs, 200) : slowDelayMs;
    if (effectiveDelay > 0) {
      // A slow turn is a turn in flight: an `interrupt` control_request aborts
      // it (real CLI) instead of letting the delayed result land later.
      const pending = setTimeout(() => { onInterrupt = null; emitRemainingEvents(); }, effectiveDelay);
      onInterrupt = () => { clearTimeout(pending); emitAbortedTurnTail(); };
    } else {
      emitRemainingEvents();
    }
  }
} else {
  // ── json mode: single JSON blob (original behavior) ──
  const result = {
    type: 'result',
    result: resultText,
    session_id: outputSessionId,
    cost_usd: 0.003,
    total_cost_usd: 0.003,
    duration_ms: 1500,
    is_error: false,
    usage: { input_tokens: 100, output_tokens: 50 },
    // Echo parsed flags back so tests can verify they were passed correctly
    _flags: {
      permissionMode: permissionMode,
      resume: resume,
      hasSystemPrompt: !!appendSystemPrompt,
    },
  };

  process.stdout.write(JSON.stringify(result));
}
