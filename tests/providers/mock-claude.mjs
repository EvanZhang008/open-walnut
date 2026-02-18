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

// Build result text
const permPart = permissionMode ? ` [permission-mode:${permissionMode}]` : '';
const cwdPart = ` [cwd:${process.cwd()}]`;
const sysPart = appendSystemPrompt ? ` [has-system-prompt]` : '';
const modelPart = modelFlag ? ` [model:${modelFlag}]` : '';
const resultText = `Hello! I processed your message: ${effectiveMessage}${permPart}${cwdPart}${sysPart}${modelPart}`;

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
