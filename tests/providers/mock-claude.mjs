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

const args = process.argv.slice(2);

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
  } else if (args[i] === '--dangerously-skip-permissions') {
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

  if (stdinData.trim()) {
    for (const line of stdinData.trim().split('\n')) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.message?.content) {
          message = typeof parsed.message.content === 'string'
            ? parsed.message.content
            : JSON.stringify(parsed.message.content);
          break;
        }
      } catch { /* skip non-JSON lines */ }
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
let slowDelayMs = 0;
let effectiveMessage = message;
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
let chunkDelayMs = 0;
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
const resultText = `Hello! I processed your message: ${effectiveMessage}${permPart}${cwdPart}${sysPart}${modelPart}${effortPart}${bypassCapabilityPart}`;

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

  // Emit remaining events (optionally delayed for "slow:N" messages)
  function emitRemainingEvents() {
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
    //     "stream-partial-signature"      → signature_delta (must NOT reach UI)
    //
    //   The full text streamed is 'Hello, world!' split into small deltas.
    if (effectiveMessage.startsWith('stream-partial-')) {
      const mode = effectiveMessage.slice('stream-partial-'.length) || 'test';
      const msgId = 'msg_mock_stream_' + outputSessionId.slice(0, 6);

      function emitStream(line) { process.stdout.write(JSON.stringify(line) + '\n'); }
      function wrap(ev) { return { type: 'stream_event', event: ev, session_id: outputSessionId, parent_tool_use_id: null }; }

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
      process.stdout.write(JSON.stringify(resultEvent) + '\n', () => process.exit(0));
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
    if (effectiveMessage === 'backgrounded-test') {
      function emitBg(line) { process.stdout.write(JSON.stringify(line) + '\n'); }
      const sid = outputSessionId;

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
        emitBg({ type: 'result', subtype: 'success', is_error: false, duration_ms: 200, num_turns: 1, result: 'Command backgrounded; moving on', session_id: sid, total_cost_usd: 0.002, usage: { input_tokens: 100, output_tokens: 20 } });
      }, 300);
      setTimeout(() => {
        emitBg({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
      }, 450);
      // Do NOT exit (stream-json FIFO mode stays alive between turns) and do NOT
      // drain 'bg-detached' — that non-terminal task is the whole point.
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

    // 3. Assistant message with text content
    const assistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_mock_002',
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

  // For mode-change messages, ensure remaining events fire AFTER the mode-change system event
  const effectiveDelay = modeChangeMatch ? Math.max(slowDelayMs, 200) : slowDelayMs;
  if (effectiveDelay > 0) {
    setTimeout(emitRemainingEvents, effectiveDelay);
  } else {
    emitRemainingEvents();
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
