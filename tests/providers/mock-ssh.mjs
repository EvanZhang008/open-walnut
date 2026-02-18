#!/usr/bin/env node

/**
 * Mock SSH script for testing remote session invocation.
 *
 * When ClaudeCodeSession.send() detects an SSH target, it spawns:
 *   ssh -o BatchMode=yes -o StrictHostKeyChecking=no [-p PORT] user@hostname "cd '/path' && CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude ..."
 *
 * This mock:
 *   1. Writes the full argument list and the remote command to stderr (for test verification).
 *   2. Outputs a valid JSONL stream to stdout (init, assistant, result) — same format as
 *      the real `claude -p --output-format stream-json --verbose`.
 *   3. Exits cleanly after a short delay (so the tailer can consume output).
 *
 * Because stdout is redirected to a JSONL file by the parent process,
 * the tailer will read these lines and emit the expected bus events.
 */

import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);

// Write all args to stderr so the test can read the .err file and verify them.
process.stderr.write(`SSH_ARGS:${JSON.stringify(args)}\n`);

// The remote command is the last positional argument (after user@hostname).
const remoteCmd = args[args.length - 1];
process.stderr.write(`REMOTE_CMD:${remoteCmd}\n`);

// Extract the user@hostname (the arg right before the remote command).
const hostArg = args[args.length - 2];
process.stderr.write(`HOST_ARG:${hostArg}\n`);

// Simulate JSONL stream output (same format as mock-claude.mjs)
const sessionId = randomUUID();

const lines = [
  // 1. System init
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: '/tmp/test-ssh',
    model: 'mock-model',
    tools: ['Read', 'Edit', 'Bash'],
    mcp_servers: [],
    permissionMode: 'default',
  }),
  // 2. Assistant message
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_mock_ssh_001',
      type: 'message',
      role: 'assistant',
      model: 'mock-model',
      content: [{ type: 'text', text: 'Working on remote task via SSH...' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    session_id: sessionId,
  }),
  // 3. Final result
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1000,
    num_turns: 1,
    result: `Remote session completed successfully [session:${sessionId}]`,
    session_id: sessionId,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50 },
  }),
];

for (const line of lines) {
  process.stdout.write(line + '\n');
}

// Give the tailer time to read, then exit cleanly.
setTimeout(() => process.exit(0), 500);
