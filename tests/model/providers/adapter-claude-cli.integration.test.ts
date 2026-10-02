/**
 * Integration test — spawns a FAKE `claude` binary through the real adapter
 * run() path, proving the full chain: spawn → stream-json parse → onTextDelta →
 * ModelResult (text + usage). No real subscription needed; a shell script stands
 * in for the CLI and emits the same stream-json shape the fork produces.
 *
 * The real `claude` binary against a real subscription is the live tier's job:
 * adapter-claude-cli.live.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCliAdapter } from '../../../src/model/providers/adapter-claude-cli.js';
import type { AdapterCallOptions } from '../../../src/model/providers/types.js';

let tmpDir: string;

/** Write a fake `claude` script that emits stream-json lines like the fork. */
function writeFakeClaude(body: string): string {
  const p = path.join(tmpDir, 'fake-claude.sh');
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return p;
}

function baseOpts(command: string, over: Partial<AdapterCallOptions> = {}): AdapterCallOptions {
  return {
    providerConfig: { api: 'claude-cli', claude_cli_command: command },
    model: 'default',
    maxTokens: 4096,
    system: 'You are the Personal AI.',
    messages: [{ role: 'user', content: 'say hi' }],
    ...over,
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-clicli-'));
});
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ClaudeCliAdapter.run — fake CLI subprocess', () => {
  it('streams text deltas and returns a text ModelResult with usage', async () => {
    // Emit a partial text delta, a final assistant line, and a result line w/ usage.
    const cmd = writeFakeClaude(`
cat <<'JSONL'
{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-8"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}}
{"type":"result","subtype":"success","result":"Hello there","total_cost_usd":0.0009,"usage":{"input_tokens":11,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}
JSONL
`);
    const adapter = new ClaudeCliAdapter();
    const deltas: string[] = [];
    const result = await adapter.sendMessageStream({
      ...baseOpts(cmd),
      onTextDelta: (d) => deltas.push(d),
    });

    // Streamed deltas arrived.
    expect(deltas.join('')).toContain('Hello');
    // Final content prefers the canonical result text.
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Hello there' });
    expect(result.stopReason).toBe('end_turn');
    // Usage came off the result line.
    expect(result.usage?.input_tokens).toBe(11);
    expect(result.usage?.output_tokens).toBe(3);
  });

  it('reads the prompt from stdin (the CLI receives our serialized messages)', async () => {
    // Echo whatever arrived on stdin back inside a result line so we can assert
    // the adapter actually piped the prompt in.
    const cmd = writeFakeClaude(`
IN="$(cat)"
printf '{"type":"result","subtype":"success","result":%s}\\n' "$(printf '%s' "$IN" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
`);
    const adapter = new ClaudeCliAdapter();
    const result = await adapter.sendMessage(baseOpts(cmd, {
      messages: [{ role: 'user', content: 'PROMPT_MARKER_42' }],
    }));
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toContain('PROMPT_MARKER_42');
  });

  it('rejects with an honest error when the CLI reports an error result', async () => {
    const cmd = writeFakeClaude(`
echo '{"type":"result","subtype":"error","error":"Not logged in"}'
exit 1
`);
    const adapter = new ClaudeCliAdapter();
    await expect(adapter.sendMessage(baseOpts(cmd))).rejects.toThrow(/Not logged in|error/i);
  });

  it('rejects (does not hang) when the binary does not exist', async () => {
    const adapter = new ClaudeCliAdapter();
    await expect(
      adapter.sendMessage(baseOpts('/nonexistent/definitely-not-claude-xyz')),
    ).rejects.toThrow(/spawn failed|ENOENT/i);
  });

  it('returns aborted result when the signal fires', async () => {
    // A CLI that sleeps so the abort lands mid-turn.
    const cmd = writeFakeClaude(`
echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}}'
sleep 5
echo '{"type":"result","subtype":"success","result":"too late"}'
`);
    const adapter = new ClaudeCliAdapter();
    const ac = new AbortController();
    const p = adapter.sendMessageStream({ ...baseOpts(cmd), signal: ac.signal });
    // Abort shortly after the first delta.
    setTimeout(() => ac.abort(), 300);
    const result = await p;
    expect(result.aborted).toBe(true);
  });
});

describe('ClaudeCliAdapter — pseudo-tool protocol round-trip (fake CLI)', () => {
  const TOOLS = [{
    name: 'task_create',
    description: 'Create a task',
    input_schema: { type: 'object' as const, properties: { title: { type: 'string' } } },
  }];

  it('parses protocol tool_calls into synthetic tool_use blocks (stopReason tool_use)', async () => {
    const cmd = writeFakeClaude(`
cat > /dev/null
echo '{"type":"result","subtype":"success","result":"{\\"tool_calls\\": [{\\"name\\": \\"task_create\\", \\"input\\": {\\"title\\": \\"Buy milk\\"}}]}","usage":{"input_tokens":50,"output_tokens":20}}'
`);
    const adapter = new ClaudeCliAdapter();
    const result = await adapter.sendMessage(baseOpts(cmd, { tools: TOOLS }));
    expect(result.stopReason).toBe('tool_use');
    const toolUse = result.content.find((b) => b.type === 'tool_use') as
      { type: string; id: string; name: string; input: Record<string, unknown> } | undefined;
    expect(toolUse).toBeTruthy();
    expect(toolUse!.name).toBe('task_create');
    expect(toolUse!.input).toEqual({ title: 'Buy milk' });
    expect(toolUse!.id).toMatch(/^clitool_/);
  });

  it('parses a protocol reply into plain text (stopReason end_turn)', async () => {
    const cmd = writeFakeClaude(`
cat > /dev/null
echo '{"type":"result","subtype":"success","result":"{\\"reply\\": \\"All done, boss.\\"}"}'
`);
    const adapter = new ClaudeCliAdapter();
    const deltas: string[] = [];
    const result = await adapter.sendMessageStream({
      ...baseOpts(cmd, { tools: TOOLS }),
      onTextDelta: (d) => deltas.push(d),
    });
    expect(result.stopReason).toBe('end_turn');
    expect((result.content[0] as { text: string }).text).toBe('All done, boss.');
    // In tools mode the raw protocol JSON is never streamed — only the parsed reply.
    expect(deltas.join('')).toBe('All done, boss.');
    expect(deltas.join('')).not.toContain('tool_calls');
  });

  it('resumes ONE CLI session across turns of a conversation (--resume with only the tail)', async () => {
    // The fake CLI logs argv + stdin per invocation so we can assert the chaining.
    const logFile = path.join(tmpDir, 'invocations.log');
    const cmd = writeFakeClaude(`
IN="$(cat | tr '\\n' ' ')"
ARGS="$(printf '%s' "$*" | tr '\\n' ' ')"
printf '%s\\t%s\\n' "$ARGS" "$IN" >> ${JSON.stringify(logFile)}
echo '{"type":"result","subtype":"success","result":"{\\"reply\\": \\"ok\\"}"}'
`);
    const adapter = new ClaudeCliAdapter();
    const system = 'You are the Personal AI.';
    const turn1: AdapterCallOptions['messages'] = [{ role: 'user', content: 'FIRST_MSG' }];
    await adapter.sendMessage(baseOpts(cmd, { system, messages: turn1, tools: TOOLS }));

    const turn2: AdapterCallOptions['messages'] = [
      ...turn1,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'clitool_x', name: 'task_create', input: { title: 't' } }] as never },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'clitool_x', content: 'created #7' }] as never },
    ];
    await adapter.sendMessage(baseOpts(cmd, { system, messages: turn2, tools: TOOLS }));

    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    const [firstArgs, firstStdin] = lines[0].split('\t');
    const [secondArgs, secondStdin] = lines[1].split('\t');
    // Turn 1 minted a session id; turn 2 resumed that SAME id.
    expect(firstArgs).toContain('--session-id');
    expect(secondArgs).toContain('--resume');
    const sid = firstArgs.match(/--session-id ([0-9a-f-]{36})/)?.[1];
    expect(sid).toBeTruthy();
    expect(secondArgs).toContain(sid!);
    // Turn 2 sent ONLY the tool-result envelope, not the replayed history.
    expect(firstStdin).toContain('FIRST_MSG');
    expect(secondStdin).toContain('created #7');
    expect(secondStdin).not.toContain('FIRST_MSG');
  });

  it('retries once with the corrective nudge on malformed protocol output', async () => {
    // First invocation emits broken protocol JSON; second emits a valid reply.
    const countFile = path.join(tmpDir, 'retry-count');
    fs.writeFileSync(countFile, '0');
    const cmd = writeFakeClaude(`
IN="$(cat)"
N=$(cat ${JSON.stringify(countFile)})
echo $((N+1)) > ${JSON.stringify(countFile)}
if [ "$N" = "0" ]; then
  echo '{"type":"result","subtype":"success","result":"{\\"tool_calls\\": [{\\"name\\": broken}]}"}'
else
  echo '{"type":"result","subtype":"success","result":"{\\"reply\\": \\"recovered\\"}"}'
fi
`);
    const adapter = new ClaudeCliAdapter();
    const result = await adapter.sendMessage(baseOpts(cmd, { tools: TOOLS, messages: [{ role: 'user', content: 'go' }] }));
    expect(fs.readFileSync(countFile, 'utf-8').trim()).toBe('2');
    expect((result.content[0] as { text: string }).text).toBe('recovered');
  });

  it('falls back to a fresh session when --resume fails (dead CLI session)', async () => {
    const logFile = path.join(tmpDir, 'fallback.log');
    const cmd = writeFakeClaude(`
IN="$(cat)"
ARGS="$(printf '%s' "$*" | tr '\\n' ' ')"
printf '%s\\n' "$ARGS" >> ${JSON.stringify(logFile)}
case "$*" in
  *--resume*) echo "No conversation found" >&2; exit 1 ;;
  *) echo '{"type":"result","subtype":"success","result":"{\\"reply\\": \\"fresh ok\\"}"}' ;;
esac
`);
    const adapter = new ClaudeCliAdapter();
    const system = 'Personal AI';
    const t1: AdapterCallOptions['messages'] = [{ role: 'user', content: 'hello world' }];
    await adapter.sendMessage(baseOpts(cmd, { system, messages: t1, tools: TOOLS }));
    const t2: AdapterCallOptions['messages'] = [...t1, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'again' }];
    const result = await adapter.sendMessage(baseOpts(cmd, { system, messages: t2, tools: TOOLS }));
    expect((result.content[0] as { text: string }).text).toBe('fresh ok');
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    // spawn1: --session-id; spawn2: --resume (fails); spawn3: fresh --session-id fallback
    expect(lines.length).toBe(3);
    expect(lines[1]).toContain('--resume');
    expect(lines[2]).toContain('--session-id');
  });
});
