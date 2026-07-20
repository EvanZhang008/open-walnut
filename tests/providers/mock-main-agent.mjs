#!/usr/bin/env node

// Text-only Claude CLI provider used by the Playwright test server. Consume the
// prompt so the caller can close stdin normally, then return one deterministic
// result without contacting an external model.
for await (const _chunk of process.stdin) {
  // Intentionally ignored.
}

process.stdout.write(`${JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1,
  num_turns: 1,
  result: 'Mock main-agent response.',
  session_id: `mock-main-agent-${process.pid}`,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
})}\n`)
