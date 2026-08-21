#!/usr/bin/env node

/**
 * Mock ACP agent — a scripted stdio ACP server standing in for codex-acp.
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (the ACP transport).
 *
 * Behavior is keyed off the prompt text (mirroring mock-claude.mjs):
 *   - "permission-test" → issues session/request_permission, then finishes the
 *     turn (reply text reflects the chosen option id)
 *   - "status-slow-tool"→ emits a tool call while a real child process runs
 *   - "slow"            → streams 3 chunks with 150ms gaps (interrupt window)
 *   - "error"           → responds to session/prompt with a JSON-RPC error
 *   - "self-report-test"→ streams a deterministic labeled private report
 *   - anything else     → streams 2 message chunks then end_turn
 *
 * session/load replays one historical message chunk (marker: "replayed:") so
 * tests can assert suppression/handling, then succeeds.
 * Set MOCK_ACP_FAIL_LOAD=1 to make every session/load fail.
 * Set MOCK_ACP_FAIL_LOAD_FILE to a marker path consumed on the next load only.
 * Set MOCK_ACP_LOAD_DELAY_MS and optional MOCK_ACP_LOAD_DELAY_SESSION_ID to delay load.
 * Set MOCK_ACP_SESSION_LOG to record every session/new + session/load request
 * (method + mcpServers + cwd), so tests can assert what the CLIENT actually
 * sent — the only honest check for MCP mount wiring.
 * Set MOCK_ACP_EXIT_ON_STDIN_CLOSE_MS to delay exit after stdin closes
 * (default 50ms — models codex-acp's ~2s app-server teardown, shortened).
 */

import readline from 'node:readline';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

let nextOutId = 1000;
const pendingServerRequests = new Map(); // id -> {resolve}
let sessionCounter = 0;
let cancelled = false;
let ignoreCancel = false;
let turnRunning = false;          // a session/prompt turn is streaming
const steeredTexts = [];          // texts injected mid-turn via _session/steering
const sessionModels = new Map();
const sessionModes = new Map();
const sessionCollaborationModes = new Map();
const availableModels = [
  { modelId: 'mock-gpt-best', name: 'Mock GPT Best', description: 'Best mock model' },
  { modelId: 'mock-gpt-fast', name: 'Mock GPT Fast', description: 'Fast mock model' },
];

if (process.env.MOCK_ACP_STDERR_SECRET) {
  process.stderr.write(`adapter auth diagnostic: ${process.env.MOCK_ACP_STDERR_SECRET}\n`);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function modelState(sessionId) {
  return {
    availableModels,
    currentModelId: sessionModels.get(sessionId) ?? 'mock-gpt-best',
  };
}

function modelConfigOption(sessionId) {
  const models = modelState(sessionId);
  return {
    id: 'model',
    name: 'Model',
    description: 'Model used by the mock ACP session',
    category: 'model',
    type: 'select',
    currentValue: models.currentModelId,
    options: models.availableModels.map((model) => ({
      value: model.modelId,
      name: model.name,
      description: model.description,
    })),
  };
}

function modeConfigOption(sessionId) {
  return {
    id: 'mode',
    name: 'Approval mode',
    description: 'Controls filesystem and command access',
    category: 'permissions',
    type: 'select',
    currentValue: sessionModes.get(sessionId) ?? 'agent',
    options: [
      { value: 'read-only', name: 'Read only' },
      { value: 'agent', name: 'Agent' },
      { value: 'agent-full-access', name: 'Agent full access' },
    ],
  };
}

function collaborationModeConfigOption(sessionId) {
  return {
    id: 'collaboration_mode',
    name: 'Collaboration mode',
    description: 'Controls planning behavior',
    category: 'behavior',
    type: 'select',
    currentValue: sessionCollaborationModes.get(sessionId) ?? 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
    ],
  };
}

/** Append a session/new | session/load request to MOCK_ACP_SESSION_LOG (if set). */
function logSessionRequest(method, params) {
  if (!process.env.MOCK_ACP_SESSION_LOG) return;
  fs.appendFileSync(process.env.MOCK_ACP_SESSION_LOG, JSON.stringify({
    method,
    cwd: params?.cwd,
    sessionId: params?.sessionId,
    mcpServers: params?.mcpServers,
  }) + '\n');
}

function sessionConfigOptions(sessionId) {
  return [
    modeConfigOption(sessionId),
    collaborationModeConfigOption(sessionId),
    modelConfigOption(sessionId),
  ];
}
/** Agent→client request; returns a promise for the client's response. */
function request(method, params) {
  const id = nextOutId++;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(sessionId, text) {
  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
}

async function handlePrompt(id, params) {
  cancelled = false;
  ignoreCancel = false;
  turnRunning = true;
  const sessionId = params.sessionId;
  const text = (params.prompt || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ');

  if (process.env.MOCK_ACP_PROMPT_LOG) {
    fs.appendFileSync(process.env.MOCK_ACP_PROMPT_LOG, JSON.stringify({ sessionId, text }) + '\n');
  }

  if (text.includes('error')) {
    replyError(id, 'mock agent: scripted prompt failure');
    return;
  }

  if (text.includes('self-report-test')) {
    chunk(sessionId, 'RECAP: deterministic ');
    chunk(sessionId, 'self report');
    reply(id, { stopReason: 'end_turn' });
    return;
  }

  if (text.includes('EXEC_SUMMARY:') && text.includes('PHASE_SIGNAL:')) {
    chunk(sessionId, [
      'EXEC_SUMMARY: Codex browser session completed and persisted its latest work.',
      'GOAL: Request: verify Codex session behavior. Objective: preserve ordered history and recovery state.',
      'CONTEXT: Open Walnut renders the same ACP journal on Homepage and Sessions.',
      'PROGRESS: DONE Browser verification - real routes and journal were exercised.',
      'WORK_LOG: append: Verified persisted Codex history, status, and recovery.',
      'RECAP: Verified persisted Codex history and recovery.',
      'PHASE_SIGNAL: verify-pass',
      'STATUS: succeeded - Browser and API state agree.',
      'WHAT_I_DID: Exercised the real Codex session pipeline.',
      'NEXT_STEPS: none.',
      'BLOCKERS: none.',
      'USER_INTENT: autonomous - verify Codex behavior.',
      'VERIFIED: ran-and-saw-pass.',
    ].join('\n'));
    reply(id, { stopReason: 'end_turn' });
    return;
  }

  if (text.includes('status-slow-tool')) {
    const toolCallId = `status-slow-tool-${Date.now()}`;
    chunk(sessionId, 'starting status subprocess');
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Status slow subprocess',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'node -e "setTimeout(() => process.exit(0), delay)"' },
      },
    });
    const holdMs = text.includes('status-slow-tool-long')
      ? 30000
      : Number(process.env.MOCK_ACP_STATUS_TOOL_MS ?? 10000);
    const child = spawn(process.execPath, [
      '-e',
      `setTimeout(() => process.exit(0), ${holdMs})`,
    ], {
      stdio: 'ignore',
      env: process.env,
    });
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: exitCode === 0 ? 'completed' : 'failed',
        rawOutput: `status subprocess exited ${exitCode}`,
      },
    });
    chunk(sessionId, 'status subprocess complete');
    reply(id, { stopReason: 'end_turn' });
    return;
  }

  if (text.includes('ordered-tool')) {
    chunk(sessionId, 'before tool');
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'ordered-tool-1',
        title: 'Ordered tool',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'printf ordered' },
      },
    });
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'ordered-tool-1',
        status: 'completed',
        rawOutput: 'ordered result',
      },
    });
    chunk(sessionId, 'after tool');
    reply(id, { stopReason: 'end_turn' });
    return;
  }

  if (text.includes('ignored-cancel-child')) {
    ignoreCancel = true;
    const child = spawn(process.execPath, [
      '-e',
      "const fs=require('fs');const p=process.env.MOCK_ACP_CHILD_HEARTBEAT;setInterval(()=>{if(p)fs.appendFileSync(p,Date.now()+'\\n')},25);setTimeout(()=>process.exit(0),10000)",
    ], {
      stdio: 'ignore',
      env: process.env,
    });
    if (process.env.MOCK_ACP_CHILD_PID_FILE) {
      fs.writeFileSync(process.env.MOCK_ACP_CHILD_PID_FILE, String(child.pid));
    }
    chunk(sessionId, 'child started');
    for (let i = 0; i < 200; i++) {
      await sleep(25);
      chunk(sessionId, `child tick ${i}`);
    }
    reply(id, { stopReason: 'end_turn' });
    return;
  }

  if (text.includes('permission-test')) {
    chunk(sessionId, 'about to ask permission');
    const resp = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'tc-1', title: 'Write file /tmp/mock.txt', kind: 'edit', status: 'pending' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = resp?.outcome ?? {};
    if (outcome.outcome === 'selected') {
      chunk(sessionId, `permission granted: ${outcome.optionId}`);
      reply(id, { stopReason: 'end_turn' });
    } else {
      chunk(sessionId, 'permission cancelled');
      reply(id, { stopReason: 'cancelled' });
    }
    return;
  }

  if (text.includes('steer-window')) {
    // A long streaming turn (~5s) that leaves a window for _session/steering.
    // Steered texts are echoed into the SAME turn as "steered:<text>" chunks.
    chunk(sessionId, 'steer window open ');
    for (let i = 0; i < 50; i++) {
      if (cancelled) { reply(id, { stopReason: 'cancelled' }); return; }
      while (steeredTexts.length > 0) {
        chunk(sessionId, `steered:${steeredTexts.shift()} `);
      }
      chunk(sessionId, `tick${i} `);
      await sleep(100);
    }
    chunk(sessionId, 'steer window closed');
    reply(id, { stopReason: 'end_turn' });
    return;
  }

  const gaps = text.includes('lifecycle-slow-mobile') ? 3000
    : text.includes('lifecycle-slow') ? 1000
      : text.includes('slow') ? 150 : 5;
  const parts = text.includes('slow')
    ? ['thinking...', 'still working...', 'done: slow reply']
    : text.includes('mobile FIFO')
      ? [`hello from mock-acp (you said: ${text})`]
      : ['hello from mock-acp ', `(you said: ${text})`];
  for (const p of parts) {
    if (cancelled) { reply(id, { stopReason: 'cancelled' }); return; }
    chunk(sessionId, p);
    await sleep(gaps);
  }
  reply(id, { stopReason: cancelled ? 'cancelled' : 'end_turn' });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Response to one of OUR requests (e.g. permission)?
  if (msg.id !== undefined && msg.method === undefined && pendingServerRequests.has(msg.id)) {
    pendingServerRequests.get(msg.id)(msg.result);
    pendingServerRequests.delete(msg.id);
    return;
  }

  switch (msg.method) {
    case 'initialize':
      reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: {
            list: {},
            close: {},
            additionalDirectories: {},
          },
        },
        agentInfo: { name: 'mock-acp-agent', version: '1.0.0' },
        authMethods: [],
        // codex-acp ≥1.2 advertises mid-turn steering here. Suppress with
        // MOCK_ACP_NO_STEERING=1 to model an old adapter (fallback path).
        ...(process.env.MOCK_ACP_NO_STEERING === '1'
          ? {}
          : { _meta: { steering: { supported: true } } }),
      });
      break;
    case '_session/steering': {
      // codex-acp extension: inject into the live turn, else start a new turn.
      if (process.env.MOCK_ACP_NO_STEERING === '1') {
        replyError(msg.id, 'mock agent: unsupported method _session/steering');
        break;
      }
      const text = (msg.params?.prompt || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ');
      if (turnRunning && !cancelled) {
        steeredTexts.push(text);
        reply(msg.id, { outcome: 'injected' });
      } else {
        reply(msg.id, { outcome: 'failed' });
      }
      break;
    }
    case 'session/new':
      sessionCounter++;
      logSessionRequest('session/new', msg.params);
      {
        // Every adapter process starts its own counter. Include the PID so
        // multiple independent ACP sessions in one server test cannot all
        // overwrite the same durable "mock-session-1" record.
        const sessionId = `mock-session-${process.pid}-${sessionCounter}`;
        sessionModels.set(sessionId, 'mock-gpt-best');
        sessionModes.set(sessionId, 'agent');
        sessionCollaborationModes.set(sessionId, 'default');
        const models = modelState(sessionId);
        reply(msg.id, {
          sessionId,
          configOptions: sessionConfigOptions(sessionId),
          _meta: { models },
          models,
        });
      }
      break;
    case 'session/load': {
      logSessionRequest('session/load', msg.params);
      const failOnceFile = process.env.MOCK_ACP_FAIL_LOAD_FILE;
      const failOnce = Boolean(failOnceFile && fs.existsSync(failOnceFile));
      if (failOnce && failOnceFile) fs.unlinkSync(failOnceFile);
      if (process.env.MOCK_ACP_FAIL_LOAD === '1' || failOnce) {
        replyError(msg.id, 'mock agent: scripted load failure');
        break;
      }
      // Simulate a cold app-server replaying a long thread: session/load can be
      // slow. The daemon budgets it at 120s (OP_TIMEOUT_MS); the fix is that the
      // WALNUT-SIDE acpStart RPC waits past its old flat 30s ceiling for it.
      const loadDelayMs = Number(process.env.MOCK_ACP_LOAD_DELAY_MS ?? 0);
      const loadDelaySessionId = process.env.MOCK_ACP_LOAD_DELAY_SESSION_ID;
      const sid = msg.params?.sessionId;
      if (loadDelayMs > 0 && (!loadDelaySessionId || loadDelaySessionId === sid)) {
        await sleep(loadDelayMs);
      }
      if (!sessionModels.has(sid)) sessionModels.set(sid, 'mock-gpt-best');
      if (!sessionModes.has(sid)) sessionModes.set(sid, 'agent');
      if (!sessionCollaborationModes.has(sid)) sessionCollaborationModes.set(sid, 'default');
      // Historical replay (clients typically suppress these during load).
      notify('session/update', {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed: earlier reply' } },
      });
      reply(msg.id, {
        configOptions: sessionConfigOptions(sid),
        _meta: { models: modelState(sid) },
      });
      break;
    }
    case 'session/set_config_option': {
      const sid = msg.params?.sessionId;
      const configId = msg.params?.configId;
      const value = msg.params?.value;
      if (configId === 'model' && availableModels.some((model) => model.modelId === value)) {
        sessionModels.set(sid, value);
      } else if (configId === 'mode' && ['read-only', 'agent', 'agent-full-access'].includes(value)) {
        sessionModes.set(sid, value);
      } else if (configId === 'collaboration_mode' && ['default', 'plan'].includes(value)) {
        sessionCollaborationModes.set(sid, value);
      } else {
        replyError(msg.id, 'mock agent: unsupported config option');
        break;
      }
      reply(msg.id, { configOptions: sessionConfigOptions(sid) });
      break;
    }
    case 'session/prompt':
      void handlePrompt(msg.id, msg.params ?? {}).finally(() => { turnRunning = false; });
      break;
    case 'session/cancel':
      // Notification (no id). Mark cancelled; in-flight prompt loop observes it.
      if (!ignoreCancel) cancelled = true;
      for (const [id, resolve] of pendingServerRequests) {
        resolve({ outcome: { outcome: 'cancelled' } });
        pendingServerRequests.delete(id);
      }
      break;
    default:
      if (msg.id !== undefined) replyError(msg.id, `mock agent: unsupported method ${msg.method}`);
  }
});

rl.on('close', async () => {
  // Model codex-acp: teardown of the provider runtime shortly after stdin closes.
  await sleep(Number(process.env.MOCK_ACP_EXIT_ON_STDIN_CLOSE_MS ?? 50));
  process.exit(0);
});
