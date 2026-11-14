#!/usr/bin/env node

/**
 * Mock Claude CLI with replay — simulates daemon reconnect replaying JSONL N times.
 *
 * Usage (test harness): Spawned by ClaudeCodeSession with FIFO stdin.
 *   MOCK_REPLAY_COUNT=4 → replay message events 4 times
 *
 * Behavior:
 *   - init event: emitted once (real daemon sends 1 init per session)
 *   - assistant/user messages: emitted N times (simulates fromOffset:0 replay)
 *   - result event: emitted once
 *
 * Message modes:
 *   - "tool-test" → text + tool_use + tool_result + post-tool text
 *   - "two-texts" → single message with 2 different text blocks
 *   - anything else → simple text response
 */

const args = process.argv.slice(2);
const replayCount = parseInt(process.env.MOCK_REPLAY_COUNT || '1', 10);

let message = '';
let sessionId = null;
let inputFormat = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--resume' && args[i + 1] && !args[i + 1].startsWith('-')) {
    sessionId = args[++i];
  } else if (args[i] === '--input-format' && args[i + 1]) {
    inputFormat = args[++i];
  } else if (args[i] === '--output-format' && args[i + 1]) {
    i++; // skip value
  } else if (args[i] === '--permission-mode' || args[i] === '--model' || args[i] === '--append-system-prompt') {
    i++; // skip value
  } else if (args[i] === '-p' || args[i] === '--verbose') {
    // skip
  } else if (!args[i].startsWith('-')) {
    message = args[i];
  }
}

// Read message from stdin when using FIFO mode (same as mock-claude.mjs)
if (inputFormat === 'stream-json') {
  const stdinData = await new Promise((resolve) => {
    let data = '';
    let timer = null;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        if (timer) clearTimeout(timer);
        process.stdin.removeAllListeners();
        process.stdin.pause();
        resolve(data);
      }
    });
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
      } catch { /* skip */ }
    }
  }
}

const outputSessionId = sessionId || 'mock-replay-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
const resultText = `Processed: ${message}`;

// 1. Init event — always exactly once
process.stdout.write(JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: outputSessionId,
  cwd: process.cwd(),
  model: 'mock-model',
  tools: ['Read', 'Edit', 'Bash'],
  mcp_servers: [],
  permissionMode: 'default',
}) + '\n');

// 2. Build the message events that will be replayed N times
const messageEvents = [];

if (message === 'tool-test') {
  // Pre-tool text + tool_use (same message)
  messageEvents.push({
    type: 'assistant',
    message: {
      id: 'msg_mock_001',
      type: 'message',
      role: 'assistant',
      model: 'mock-model',
      content: [
        { type: 'text', text: 'Let me read that file.' },
        { type: 'tool_use', id: 'toolu_mock_001', name: 'Read', input: { file_path: '/tmp/test.txt' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 20 },
    },
    session_id: outputSessionId,
  });

  // Tool result
  messageEvents.push({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_mock_001', content: 'File contents here' },
      ],
    },
    session_id: outputSessionId,
  });

  // Post-tool assistant text
  messageEvents.push({
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
  });
} else if (message === 'two-texts') {
  // Single message with 2 distinct text blocks
  messageEvents.push({
    type: 'assistant',
    message: {
      id: 'msg_mock_001',
      type: 'message',
      role: 'assistant',
      model: 'mock-model',
      content: [
        { type: 'text', text: 'First distinct text.' },
        { type: 'text', text: 'Second distinct text.' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    session_id: outputSessionId,
  });
} else {
  // Simple text response
  messageEvents.push({
    type: 'assistant',
    message: {
      id: 'msg_mock_001',
      type: 'message',
      role: 'assistant',
      model: 'mock-model',
      content: [{ type: 'text', text: resultText }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    session_id: outputSessionId,
  });
}

// 3. Replay message events N times
for (let r = 0; r < replayCount; r++) {
  for (const evt of messageEvents) {
    process.stdout.write(JSON.stringify(evt) + '\n');
  }
}

// 4. Result event — always exactly once
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1500,
  num_turns: 1,
  result: resultText,
  session_id: outputSessionId,
  total_cost_usd: 0.003,
  usage: { input_tokens: 100, output_tokens: 50 },
}) + '\n', () => process.exit(0));
