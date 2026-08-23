#!/usr/bin/env node

// Text-only Claude CLI provider used by the Playwright test server. Consume the
// prompt so the caller can close stdin normally, then return one deterministic
// result without contacting an external model.
let prompt = ''
for await (const chunk of process.stdin) {
  prompt += chunk
}

// One scripted branch, for the `<suggest>` action-card spec: a message carrying
// `SUGGEST_CARD_FIXTURE <taskId>` is answered with a card offering a real
// registry op on that task. Only the NEWEST user turn is inspected — the adapter
// replays the whole conversation on every turn, so matching anywhere would keep
// answering with a card long after the spec that asked for one.
const lastTurn = prompt.slice(Math.max(0, prompt.lastIndexOf('User:')))
const asked = /SUGGEST_CARD_FIXTURE\s+(\S+)/.exec(lastTurn)

// Flush left: an indented body line would look like a markdown code block to the
// card parser and the syntax would render literally.
const reply = asked
  ? [
    'That task is not pinned yet.',
    '',
    '<suggest title="Pin this task">',
    'Pinning keeps it in the working set.',
    `<action tool="task_pin_set" args='{"id":"${asked[1]}","pinned":true}' label="Pin it" style="primary"/>`,
    '<action label="Not now"/>',
    '</suggest>',
    '',
    'Ask again if you want it unpinned.',
  ].join('\n')
  : 'Mock main-agent response.'

process.stdout.write(`${JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1,
  num_turns: 1,
  result: reply,
  session_id: `mock-main-agent-${process.pid}`,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
})}\n`)
