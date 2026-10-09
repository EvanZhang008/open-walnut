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
    // The real CLI files the API message id it streamed; the stream→archive
    // convergence check (src/core/observability/stream-convergence.ts) compares
    // exactly those, so a made-up id here raised a false "never saved" alarm.
    { ...shared, type: 'assistant', uuid: assistantId, parentUuid: userId, message: { ...answer.message, id: answer.message?.id ?? assistantId } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  transcriptParent = assistantId;
}

/**
 * Opt-in per session (MOCK_CLAUDE_PERSIST_SESSIONS, comma list): a plain turn is
 * appended to the session's EXISTING transcript under MOCK_CLAUDE_PERSIST_DIR
 * (searched one level deep, so a realpath'd cwd cannot miss it), chained onto
 * its last line, with the user line's pre-assigned uuid the way the real CLI
 * files it. Lets a browser spec reload and find what it sent (N37).
 */
let lastInputUserUuid = null;
function persistFileOf(sid) {
  const root = process.env.MOCK_CLAUDE_PERSIST_DIR;
  const allow = (process.env.MOCK_CLAUDE_PERSIST_SESSIONS ?? '').split(',').filter(Boolean);
  if (!root || !sid || !allow.includes(sid)) return null;
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sid}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch { /* no transcript dir */ }
  return null;
}
// The user line of the turn in flight, once written (persistPlainUser).
let persistedUser = null;
/**
 * The user line on its own, when a slow turn STARTS, the way the real CLI writes
 * it before answering: a reload while the answer is still coming finds what was
 * sent (its row, so its question) instead of nothing until the turn ends.
 */
function persistPlainUser(sid, prompt) {
  const file = persistFileOf(sid);
  if (!file) return;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  let parent = null;
  try { parent = JSON.parse(lines[lines.length - 1]).uuid ?? null; } catch { /* torn tail */ }
  const userId = lastInputUserUuid || randomUUID();
  const shared = { sessionId: sid, cwd: process.cwd(), timestamp: new Date().toISOString(), isSidechain: false };
  fs.appendFileSync(file, JSON.stringify({ ...shared, type: 'user', uuid: userId, parentUuid: parent, message: { role: 'user', content: prompt } }) + '\n');
  persistedUser = { file, userId };
}
function persistPlainTurn(sid, prompt, assistantEvent) {
  if (!persistedUser) persistPlainUser(sid, prompt);
  if (!persistedUser) return;
  const { file, userId } = persistedUser;
  persistedUser = null;
  const shared = { sessionId: sid, cwd: process.cwd(), timestamp: new Date().toISOString(), isSidechain: false };
  // `MOCK_HEAVY_RESULTS:<n>x<kb>` in the prompt: the turn first makes n tool calls
  // whose results weigh kb KB each (a turn of screenshots), so one turn can append
  // more than a whale's tail window holds.
  const heavy = /MOCK_HEAVY_RESULTS:(\d+)x(\d+)/.exec(prompt ?? '');
  let parent = userId;
  // Each line its own time, as the CLI writes them (an older page ends at a timestamp).
  const t0 = Date.now();
  const at = (k) => new Date(t0 + k).toISOString();
  for (let i = 0; heavy && i < Number(heavy[1]); i++) {
    const callId = randomUUID();
    const resultId = randomUUID();
    const tu = `toolu_heavy_${process.pid.toString(36)}_${i}`;
    fs.appendFileSync(file, [
      { ...shared, timestamp: at(2 * i + 1), type: 'assistant', uuid: callId, parentUuid: parent, message: { id: `msg_heavy_${process.pid.toString(36)}_${i}`, role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'Bash', input: { command: `screenshot ${i}` } }] } },
      { ...shared, timestamp: at(2 * i + 2), type: 'user', uuid: resultId, parentUuid: callId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'i'.repeat(Number(heavy[2]) * 1024) }] } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    parent = resultId;
  }
  fs.appendFileSync(file, JSON.stringify({ ...shared, ...(heavy ? { timestamp: at(2 * Number(heavy[1]) + 1) } : {}), type: 'assistant', uuid: randomUUID(), parentUuid: parent, message: assistantEvent.message }) + '\n');
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
// User lines that arrive while a turn is in flight. The real CLI queues each and runs
// it after the turn; an interrupt with cancel_queued drops them and lists their uuids
// under `cancelled`, one without lists them under `still_queued` and they still run
// (live probe, CLI 2.1.280).
const queuedUserLines = [];
// A clean turn is "thinking" between its user line and its output. The real CLI
// queues a user line that lands then and runs it next; this mock used to drop
// it. Opt-in (MOCK_CLAUDE_QUEUE_MIDTURN=1) so suites written against the old
// behavior are unchanged: an E2E that sends twice in quick succession sets it.
const QUEUE_MIDTURN = process.env.MOCK_CLAUDE_QUEUE_MIDTURN === '1';
let cleanTurnThinking = false;
// The partial answer a long turn has streamed so far. On an interrupt the real CLI
// consolidates it into an `assistant` message before its interrupted marker.
let streamedPartial = null;

// Orphan guard (opt-in: MOCK_CLAUDE_EXIT_WITH_PARENT=1, set by the in-process
// MockDaemon, whose process is the test worker itself). The FIFO stdin is our own
// O_RDWR fd, so it never reaches EOF, and a mode that stays alive between turns
// outlived every test whose teardown never stopped it (a timed-out afterAll left
// dozens behind). Exit once the spawner is gone. Opt-in because a real daemon's
// CLI must survive that daemon's death (restart adoption).
if (process.env.MOCK_CLAUDE_EXIT_WITH_PARENT === '1') {
  const spawnedBy = process.ppid;
  const parentCheck = setInterval(() => {
    if (process.ppid !== spawnedBy) process.exit(0);
    try { process.kill(spawnedBy, 0); } catch { process.exit(0); }
  }, 2000);
  parentCheck.unref?.();
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
          lastInputUserUuid = parsed.uuid ?? null;
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
        // The user line a snapshot-write-turn turn files under (its rewind point).
        if (parsed.type === 'user' && typeof parsed.uuid === 'string') writeTurnUuidNext = parsed.uuid;
        if (parsed.type === 'control_request' && parsed.request?.subtype === 'rewind_files') {
          process.stdout.write(JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: parsed.request_id, response: answerRewindFiles(parsed.request) },
          }) + '\n');
          return;
        }
        if (parsed.type === 'control_request' && parsed.request?.subtype === 'interrupt') {
          // CLI 2.1.258 (live probe): the ACK is immediate and unconditional —
          // an idle CLI answers it too and emits nothing else. Only a mode with a
          // turn in flight (onInterrupt registered) then plays the abort sequence.
          const uuids = queuedUserLines.map((q) => q.uuid).filter(Boolean);
          const cancel = parsed.request.cancel_queued === true;
          if (cancel) {
            queuedUserLines.length = 0;
            for (const uuid of uuids) process.stdout.write(JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled', session_id: outputSessionId }) + '\n');
          }
          process.stdout.write(JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: parsed.request_id, response: cancel ? { still_queued: [], cancelled: uuids } : { still_queued: uuids } },
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
          lastInputUserUuid = parsed.uuid ?? null;
          const c = parsed.message.content;
          const resolve = pendingUserResolve;
          pendingUserResolve = null;
          resolve(typeof c === 'string' ? c : JSON.stringify(c));
        } else if (parsed.type === 'user' && parsed.message?.content !== undefined && (onInterrupt || (QUEUE_MIDTURN && cleanTurnThinking))) {
          queuedUserLines.push(parsed);
          if (parsed.uuid) process.stdout.write(JSON.stringify({ type: 'command_lifecycle', command_uuid: parsed.uuid, state: 'queued', session_id: outputSessionId }) + '\n');
        } else if (parsed.type === 'user' && parsed.message?.content !== undefined && onUserLine) {
          const c = parsed.message.content;
          onUserLine(typeof c === 'string' ? c : JSON.stringify(c));
        }
      } catch { /* not JSON — ignore */ }
    }
  }
}

// ── snapshot-write-turn support: file checkpoints + the transcript a Write files ──
// The real CLI backs a file up before a turn first edits it and answers
// `rewind_files` from those backups; the turn's Write is filed in the session
// transcript as tool_use + tool_result (with toolUseResult). Only the
// snapshot-write-turn mode uses any of this.
const writeTurnCheckpoints = new Map(); // user uuid -> Map(abs path -> content | null)
const writeTurnTracked = new Set();
let writeTurnUuidNext = null;
let writeTurnCount = 0;
function readOrNull(abs) {
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}
function writeTurnUserUuid() {
  const u = writeTurnUuidNext ?? (writeTurnCount === 0 ? lastInputUserUuid : null) ?? randomUUID();
  writeTurnUuidNext = null;
  writeTurnCount++;
  return u;
}
function writeTurnCheckpoint(uuid) {
  const cp = new Map();
  for (const abs of writeTurnTracked) cp.set(abs, readOrNull(abs));
  writeTurnCheckpoints.set(uuid, cp);
}
function writeTurnWrite(abs, content) {
  const before = readOrNull(abs);
  for (const cp of writeTurnCheckpoints.values()) if (!cp.has(abs)) cp.set(abs, before);
  writeTurnTracked.add(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return before;
}
function answerRewindFiles(request) {
  const cp = writeTurnCheckpoints.get(request.user_message_id);
  if (!cp) return { canRewind: false, error: 'No file checkpoint found for this message.' };
  const filesChanged = [];
  let insertions = 0;
  let deletions = 0;
  for (const [abs, was] of cp) {
    const now = readOrNull(abs);
    if (now === was) continue;
    filesChanged.push(abs);
    const wasLines = new Set((was ?? '').split('\n').filter(Boolean));
    const nowLines = new Set((now ?? '').split('\n').filter(Boolean));
    for (const l of wasLines) if (!nowLines.has(l)) insertions++;
    for (const l of nowLines) if (!wasLines.has(l)) deletions++;
    if (request.dry_run !== true) {
      if (was === null) { try { fs.unlinkSync(abs); } catch { /* already gone */ } }
      else fs.writeFileSync(abs, was);
    }
  }
  return { canRewind: true, filesChanged, insertions, deletions };
}
function persistWriteTurn(sid, prompt, userUuid, lines) {
  const root = process.env.MOCK_CLAUDE_TURN_TRANSCRIPT_DIR;
  if (!root || !sid) return;
  const cwd = process.cwd();
  const dir = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const file = path.join(dir, `${sid}.jsonl`);
  fs.mkdirSync(dir, { recursive: true });
  let parent = null;
  try {
    const prior = fs.readFileSync(file, 'utf8').trim().split('\n');
    parent = JSON.parse(prior[prior.length - 1]).uuid ?? null;
  } catch { /* first turn of this transcript */ }
  const shared = { sessionId: sid, cwd, timestamp: new Date().toISOString(), isSidechain: false, userType: 'external' };
  const rows = [{ ...shared, type: 'user', uuid: userUuid, parentUuid: parent, message: { role: 'user', content: prompt } }];
  let prev = userUuid;
  for (const line of lines) {
    const uuid = randomUUID();
    rows.push({ ...shared, ...line, uuid, parentUuid: prev });
    prev = uuid;
  }
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
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
// Walnut opens some sends with machine banners (`[Name]\n…\n[/Name]`): a
// question's send carries `[Question Q<n>]`, which asks the reply to begin with
// the line `[Q<n>]`. Peel the banners off before the test prefixes (slow:,
// chunk-delay:) are matched, and answer the tag the way a real model does, so
// the client's tag-based filing runs in these fixtures too.
let questionSeq = null;
function stripBanners(text) {
  questionSeq = null;
  let body = text;
  for (;;) {
    const m = body.match(/^\s*\[([^\]\n]+)\]\n[\s\S]*?\n\[\/\1\]\s*/);
    if (!m) break;
    const q = m[1].match(/^Question Q(\d+)$/);
    if (q) questionSeq = Number(q[1]);
    body = body.slice(m[0].length);
  }
  return body;
}
// The rest of what Walnut wraps around the user's words, which a real model reads
// and never repeats: the output-mode instruction and standing reminder lines
// (`[Rich output mode …]`), the reference-card block, the thread-switch lines
// (`(Back to …)`), and the `> quote` block a question's send opens with. Peeled
// off the echo so a fixture reply reads like a model's, not like a dump of the
// prompt (2026-10-01: a demo card showed the reminder and the quote).
function stripInputDecorations(text, hadQuestion) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---walnut-refs---') {
      while (i < lines.length && lines[i].trim() !== '---/walnut-refs---') i++;
      continue;
    }
    if (t.startsWith('[Rich output mode')) continue;
    if (/^\(Back to (the main conversation|the earlier (thread|question) about)/.test(t)) continue;
    out.push(lines[i]);
  }
  let body = out.join('\n').trim();
  // A question's opening: the file it is about (`About \`path\`:`), then the quote.
  if (hadQuestion) body = body.replace(/^About `[^`\n]+`:\s*\n+/, '').replace(/^(?:>.*\n?)+\s*/, '');
  // Never strip a message down to nothing: someone quoting the literal text.
  return body.trim() === '' ? text : body.trim();
}
// `MOCK_CLAUDE_PLAIN_ECHO=1` (the browser fixture) drops the spawn-flag suffixes
// (`[permission-mode:…] [cwd:…] …`), which only the provider and e2e node tests
// read; a UI test or a demo then sees a reply shaped like a model's.
const plainEcho = process.env.MOCK_CLAUDE_PLAIN_ECHO === '1';
// `echo-input` anywhere in the user's words: the reply quotes the input VERBATIM,
// decorations included. A fixture that must prove what the agent was handed (the
// reference card appended to a launch or a send) reads it from this reply.
let rawEcho = false;
// `MOCK_TAG_SWITCH:<n>:<ms>` in a slow question's words: the turn answers its own
// question first, then moves on to question n after ms (one turn, two `[Qn]`
// tags, the way a CLI that took a second question mid-turn answers both).
let tagSwitch = null;
function computeMessageParts() {
  slowDelayMs = 0;
  const bare = stripInputDecorations(stripBanners(message), questionSeq !== null);
  rawEcho = /(^|\s)echo-input(\s|$)/.test(bare);
  const sw = /\s*MOCK_TAG_SWITCH:(\d+):(\d+)\s*/.exec(bare);
  tagSwitch = sw ? { seq: Number(sw[1]), ms: Number(sw[2]) } : null;
  const words = sw ? bare.replace(sw[0], ' ').trim() : bare;
  effectiveMessage = words;
  const slowMatch = words.match(/^slow:(\d+)\s+(.*)/);
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
  const tagPart = tagSwitch ? `[Q${tagSwitch.seq}]\n` : questionSeq ? `[Q${questionSeq}]\n` : '';
  const flags = plainEcho ? '' : `${permPart}${cwdPart}${sysPart}${modelPart}${effortPart}${bypassCapabilityPart}`;
  resultText = `${tagPart}Hello! I processed your message: ${rawEcho ? message : effectiveMessage}${flags}`;
}
computeMessageParts();

/** A tag switch's first two texts: the turn's own question now, question n after ms. */
function startTagSwitch() {
  if (!tagSwitch || !questionSeq) return () => {};
  const say = (text) => process.stdout.write(JSON.stringify({
    type: 'assistant',
    message: {
      id: `msg_mock_switch_${process.pid.toString(36)}${Date.now().toString(36)}`,
      type: 'message', role: 'assistant', model: 'mock-model',
      content: [{ type: 'text', text }], stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    session_id: outputSessionId,
  }) + '\n');
  say(`[Q${questionSeq}]\nFirst, this question: ${effectiveMessage}`);
  const t = setTimeout(() => say(`[Q${tagSwitch.seq}]\nNow back to question ${tagSwitch.seq}.`), tagSwitch.ms);
  return () => clearTimeout(t);
}

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
    const queued = queuedUserLines.shift();
    if (queued) {
      if (queued.uuid) process.stdout.write(JSON.stringify({ type: 'command_lifecycle', command_uuid: queued.uuid, state: 'started', session_id: outputSessionId }) + '\n');
      const c = queued.message.content;
      setTimeout(() => onUserLine?.(typeof c === 'string' ? c : JSON.stringify(c)), 0);
    }
  }
  // The aborted-turn tail of CLI 2.1.258 (live probe 2026-09-11; 2.1.280 on
  // 2026-09-25), emitted AFTER the stdin listener's ACK: the streamed partial as a
  // consolidated assistant message, the CLI-inserted user line, an is_error result
  // (terminal_reason aborted_streaming) with only an [ede_diagnostic] error and no
  // text, then idle. The process then arms the next FIFO user line as a new turn:
  // it never exits on an interrupt.
  function emitAbortedTurnTail() {
    const sid = outputSessionId;
    const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n');
    if (streamedPartial) {
      emit({ type: 'assistant', message: { id: streamedPartial.msgId, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: streamedPartial.text }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } }, session_id: sid, parent_tool_use_id: null });
      streamedPartial = null;
    }
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, session_id: sid, parent_tool_use_id: null });
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', duration_ms: 300, duration_api_ms: 250, num_turns: 2, stop_reason: null, session_id: sid, total_cost_usd: nextSnapshotCost(0.001), usage: { input_tokens: 10, output_tokens: 0 }, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'] });
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

    // 2a.-1.5. "rate-limit-event:<json>" — the subscription limit line(s) the
    //          real CLI writes for a claude.ai sign-in, then one clean turn, then
    //          STAY ALIVE like snapshot-clean-turn (multi-turn included). <json> is
    //          one rate_limit_info object or an array (one line each). `resetsIn`
    //          / `overageResetsIn` are seconds from now (negative = already
    //          passed) and become the epoch-SECOND resetsAt the CLI sends, inside
    //          unifiedWindows entries too.
    if (effectiveMessage.startsWith('rate-limit-event:')) {
      const sid = outputSessionId;
      const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n');
      const nowSec = Math.floor(Date.now() / 1000);
      const absolute = (o) => {
        if (!o || typeof o !== 'object') return o;
        const out = {};
        for (const [k, v] of Object.entries(o)) {
          if (k === 'resetsIn' && typeof v === 'number') out.resetsAt = nowSec + v;
          else if (k === 'overageResetsIn' && typeof v === 'number') out.overageResetsAt = nowSec + v;
          else if (k === 'unifiedWindows' && v && typeof v === 'object') out.unifiedWindows = Object.fromEntries(Object.entries(v).map(([wk, wv]) => [wk, absolute(wv)]));
          else out[k] = v;
        }
        return out;
      };
      let infos = [];
      try {
        const parsed = JSON.parse(effectiveMessage.split('\n')[0].slice('rate-limit-event:'.length));
        infos = Array.isArray(parsed) ? parsed : [parsed];
      } catch { /* not JSON: the turn still runs, with no limit line */ }
      const body = () => {
        infos.forEach((info, i) => emit({ type: 'rate_limit_event', rate_limit_info: absolute(info), uuid: `mock-rl-${process.pid}-${++snapshotTurnSeq}-${i}`, session_id: sid }));
        const text = `Rate limit lines sent: ${infos.length}.`;
        emit({ type: 'assistant', message: { id: 'msg_rate_limit_' + (++snapshotTurnSeq) + '_' + process.pid, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }, session_id: sid });
        emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 40, num_turns: 1, result: text, session_id: sid, total_cost_usd: nextSnapshotCost(0.001), usage: { input_tokens: 20, output_tokens: 8 } });
        emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
        armSnapshotNextTurn();
      };
      // Same think time as snapshot-clean-turn, for the same turn-start ordering reason.
      const THINK_MS = Number(process.env.MOCK_SNAPSHOT_TURN_DELAY_MS ?? 300);
      if (THINK_MS > 0) setTimeout(body, THINK_MS);
      else body();
      return;
    }

    // 2a.-1.4. "file-edit-turn:<json>" — a turn that REALLY edits files the way
    //          the CLI's Edit/Write tools do, then STAYS ALIVE like
    //          snapshot-clean-turn (multi-turn included). <json> (first line only)
    //          is { edits: [{ file, old, new } | { file, write }], text? }; a
    //          relative file is resolved against the cwd. Each edit is applied on
    //          disk, streamed as tool_use + tool_result (is_error when `old` is
    //          not found exactly once, and the file is left alone), and written
    //          to the canonical transcript under MOCK_CLAUDE_TRANSCRIPT_DIR with
    //          a parentUuid chain, so the Changed tab and the commit view read
    //          this session's ops exactly as they read a real one's.
    if (effectiveMessage.startsWith('file-edit-turn:')) {
      const sid = outputSessionId;
      const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n');
      let spec = { edits: [] };
      try { spec = JSON.parse(effectiveMessage.split('\n')[0].slice('file-edit-turn:'.length)); } catch { /* no edits */ }
      const turn = ++snapshotTurnSeq;
      const rows = [];
      const body = () => {
        emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'running' });
        (spec.edits || []).forEach((e, i) => {
          const file = path.resolve(process.cwd(), String(e.file));
          const id = `toolu_fe_${process.pid}_${turn}_${i}`;
          let isError = false;
          let resultText = '';
          let toolUseResult;
          let input;
          if (typeof e.write === 'string') {
            input = { file_path: file, content: e.write };
            let original = null;
            try { original = fs.readFileSync(file, 'utf8'); } catch { /* a create */ }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, e.write);
            toolUseResult = original === null ? { type: 'create', filePath: file, content: e.write } : { type: 'update', filePath: file, content: e.write, originalFile: original };
            resultText = `File ${original === null ? 'created' : 'updated'} successfully at: ${file}`;
          } else {
            input = { file_path: file, old_string: String(e.old), new_string: String(e.new), replace_all: false };
            let text = null;
            try { text = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
            const count = text === null ? 0 : text.split(String(e.old)).length - 1;
            if (count !== 1) {
              isError = true;
              resultText = text === null ? 'File does not exist.' : count === 0 ? 'String to replace not found in file.' : `Found ${count} matches of the string to replace.`;
            } else {
              fs.writeFileSync(file, text.replace(String(e.old), () => String(e.new)));
              resultText = `The file ${file} has been updated successfully.`;
              toolUseResult = { filePath: file, oldString: String(e.old), newString: String(e.new) };
            }
          }
          const assistant = { type: 'assistant', session_id: sid, parent_tool_use_id: null, message: {
            id: `msg_fe_${process.pid}_${turn}_${i}`, type: 'message', role: 'assistant', model: 'mock-model',
            content: [{ type: 'tool_use', id, name: typeof e.write === 'string' ? 'Write' : 'Edit', input }],
            stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 },
          } };
          const user = { type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: id, content: resultText, ...(isError ? { is_error: true } : {}) },
          ] }, ...(toolUseResult ? { tool_use_result: toolUseResult } : {}) };
          emit(assistant);
          emit(user);
          rows.push({ type: 'assistant', message: assistant.message }, { type: 'user', message: user.message, ...(toolUseResult ? { toolUseResult } : {}) });
        });
        const text = spec.text || `Edited ${(spec.edits || []).length} file(s).`;
        const final = { type: 'assistant', session_id: sid, message: { id: `msg_fe_${process.pid}_${turn}_done`, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } } };
        emit(final);
        rows.push({ type: 'assistant', message: final.message });
        const root = process.env.MOCK_CLAUDE_TRANSCRIPT_DIR;
        if (root) {
          const dir = path.join(root, process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
          fs.mkdirSync(dir, { recursive: true });
          const shared = { sessionId: sid, cwd: process.cwd(), isSidechain: false };
          const promptId = randomUUID();
          const out = [{ ...shared, type: 'user', uuid: promptId, parentUuid: transcriptParent, timestamp: new Date().toISOString(), message: { role: 'user', content: effectiveMessage.split('\n')[0] } }];
          let parent = promptId;
          for (const r of rows) {
            const uuid = randomUUID();
            out.push({ ...shared, ...r, uuid, parentUuid: parent, timestamp: new Date().toISOString() });
            parent = uuid;
          }
          transcriptParent = parent;
          fs.appendFileSync(path.join(dir, `${sid}.jsonl`), out.map((row) => JSON.stringify(row)).join('\n') + '\n');
        }
        emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 40, num_turns: 1, result: text, session_id: sid, total_cost_usd: nextSnapshotCost(0.001), usage: { input_tokens: 20, output_tokens: 8 } });
        emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
        armSnapshotNextTurn();
      };
      // Same think time as snapshot-clean-turn, for the same turn-start ordering reason.
      const THINK_MS = Number(process.env.MOCK_SNAPSHOT_TURN_DELAY_MS ?? 300);
      if (THINK_MS > 0) setTimeout(body, THINK_MS);
      else body();
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
      // `{env:NAME}` in the text becomes that variable as this CLI sees it
      // (`<unset>` when absent), so a test can check what a spawn passed down.
      const text = (effectiveMessage.includes(':')
        ? effectiveMessage.split('\n\n[Rich output mode')[0].split(':').slice(1).join(':')
        : 'Clean turn done; process stays alive.')
        .replace(/\{env:([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? '<unset>');
      const sid = outputSessionId;
      const emit = (line) => {
        if (line.type === 'assistant') persistMockTurn(sid, effectiveMessage, line);
        process.stdout.write(JSON.stringify(line) + '\n');
      };
      const body = () => {
        cleanTurnThinking = false;
        // Unique per process as a real API id is: a resumed process restarts
        // the counter, and its turns share one transcript with the old ones.
        emit({ type: 'assistant', message: { id: 'msg_snap_clean_' + (++snapshotTurnSeq) + '_' + process.pid, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }, session_id: sid });
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
      if (THINK_MS > 0) { cleanTurnThinking = true; setTimeout(body, THINK_MS); }
      else body();
      // Do NOT exit: stream-json FIFO mode stays alive between turns.
      return;
    }

    // 2a.-0.95. "snapshot-write-turn:<relpath>:<content>" — a turn that WRITES
    //          <relpath> (under the cwd) with <content> + newline through a Write
    //          tool call, then STAYS ALIVE like snapshot-clean-turn (multi-turn
    //          too). The per-turn snapshot and rewind guard specs drive files
    //          with it. With MOCK_CLAUDE_TURN_TRANSCRIPT_DIR set the turn is also
    //          filed in the session transcript the way the real CLI files a Write,
    //          and the turn's file checkpoint answers `rewind_files`. The write
    //          waits MOCK_SNAPSHOT_WRITE_DELAY_MS (default 1000), so the daemon's
    //          baseline snapshot at spawn is taken before it.
    if (effectiveMessage.startsWith('snapshot-write-turn:')) {
      const spec = effectiveMessage.split('\n')[0].slice('snapshot-write-turn:'.length);
      const colon = spec.indexOf(':');
      const rel = colon >= 0 ? spec.slice(0, colon) : spec;
      const content = (colon >= 0 ? spec.slice(colon + 1) : 'written') + '\n';
      const prompt = effectiveMessage.split('\n')[0];
      const sid = outputSessionId;
      const userUuid = writeTurnUserUuid();
      const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n');
      const body = () => {
        const abs = path.resolve(process.cwd(), rel);
        const seq = ++snapshotTurnSeq;
        const toolId = `toolu_mock_write_${seq}_${process.pid}`;
        const text = `Wrote ${rel}.`;
        if (!abs.startsWith(process.cwd() + path.sep)) {
          emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 40, num_turns: 1, result: 'Refused a path outside the folder.', session_id: sid, total_cost_usd: nextSnapshotCost(0.001), usage: { input_tokens: 20, output_tokens: 8 } });
          emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
          armSnapshotNextTurn();
          return;
        }
        writeTurnCheckpoint(userUuid);
        const original = writeTurnWrite(abs, content);
        const useMsg = { id: `msg_mock_write_${seq}_${process.pid}`, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'tool_use', id: toolId, name: 'Write', input: { file_path: abs, content } }], stop_reason: 'tool_use', usage: { input_tokens: 20, output_tokens: 8 } };
        const resultMsg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: `File ${original === null ? 'created' : 'updated'} successfully at: ${abs}` }] };
        const toolUseResult = original === null
          ? { type: 'create', filePath: abs, content }
          : { type: 'update', filePath: abs, content, originalFile: original };
        const textMsg = { id: `msg_mock_write_text_${seq}_${process.pid}`, type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } };
        emit({ type: 'assistant', message: useMsg, session_id: sid, parent_tool_use_id: null });
        emit({ type: 'user', message: resultMsg, session_id: sid, parent_tool_use_id: null, tool_use_result: toolUseResult });
        emit({ type: 'assistant', message: textMsg, session_id: sid, parent_tool_use_id: null });
        persistWriteTurn(sid, prompt, userUuid, [
          { type: 'assistant', message: useMsg },
          { type: 'user', message: resultMsg, toolUseResult },
          { type: 'assistant', message: textMsg },
        ]);
        emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 40, num_turns: 2, result: text, session_id: sid, total_cost_usd: nextSnapshotCost(0.001), usage: { input_tokens: 20, output_tokens: 8 } });
        emit({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
        armSnapshotNextTurn();
      };
      setTimeout(body, Number(process.env.MOCK_SNAPSHOT_WRITE_DELAY_MS ?? 1000));
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
        streamedPartial = { msgId, text: partialText };
      }
      const natural = setTimeout(() => {
        onInterrupt = null;
        streamedPartial = null;
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
    //     "stream-partial-speed"          → two messages with per-message usage and a
    //                                       tool gap between them (speed readout)
    //     "stream-partial-work"           → reasoning + a Bash call that runs, reasoning
    //                                       + a Read that runs, reasoning + the answer
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

      // Two API messages with a tool-shaped gap between them, each with the
      // real CLI's usage bookkeeping (message_delta.usage.output_tokens per
      // message, result.usage for the turn). Drives the speed readout: the gap
      // must not count as generation time, the tokens must be the CLI's counts.
      // Honours chunk-delay: (default 150ms) so the windows have real width.
      // A working turn the way a real one streams: three API messages, each
      // opening with reasoning; the first two end in a call that RUNS for
      // chunk-delay x 20 (default 3s) before its result lands, the last one in
      // the answer. Lets a client be looked at while a call is in flight and
      // while reasoning streams between calls (the closed-run check, 2026-10-04).
      if (mode === 'work') {
        (async () => {
          const gap = chunkDelayMs > 0 ? chunkDelayMs : 150;
          const pause = (ms = gap) => new Promise((r) => setTimeout(r, ms));
          const model = modelFlag || 'mock-model';
          const steps = [
            { think: ['Checking ', 'what the ', 'folder holds.'], tool: { id: 'toolu_mock_work_1', name: 'Bash', input: { command: 'ls -la' } }, result: 'README.md\nsrc' },
            { think: ['Now the ', 'readme.'], tool: { id: 'toolu_mock_work_2', name: 'Read', input: { file_path: '/tmp/mock-work/README.md' } }, result: '# Mock' },
            { think: ['That is ', 'enough to ', 'answer.'], text: ['The folder ', 'has a readme ', 'and a src folder.'] },
          ];
          for (let s = 0; s < steps.length; s++) {
            const step = steps[s];
            const id = `${msgId}_w${s + 1}`;
            emitStream(wrap({ type: 'message_start', message: { id, role: 'assistant', content: [], model, usage: { input_tokens: 10, output_tokens: 1 } } }));
            emitStream(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
            for (const t of step.think) {
              emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } }));
              await pause();
            }
            emitStream(wrap({ type: 'content_block_stop', index: 0 }));
            // The CLI writes each finished block as its own assistant line under
            // the message's id, reasoning included.
            emitStream({
              type: 'assistant',
              message: { id, role: 'assistant', model, content: [{ type: 'thinking', thinking: step.think.join(''), signature: 'mock-signature' }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 } },
              session_id: outputSessionId,
            });
            if (step.tool) {
              emitStream(wrap({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: step.tool.id, name: step.tool.name, input: {} } }));
              emitStream(wrap({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.input) } }));
              emitStream(wrap({ type: 'content_block_stop', index: 1 }));
              emitStream({
                type: 'assistant',
                message: { id, role: 'assistant', model, content: [{ type: 'tool_use', ...step.tool }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } },
                session_id: outputSessionId,
              });
              emitStream(wrap({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }));
              emitStream(wrap({ type: 'message_stop' }));
              await pause(gap * 20);
              emitStream({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: step.tool.id, content: step.result }] }, session_id: outputSessionId });
              continue;
            }
            emitStream(wrap({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
            for (const t of step.text) {
              emitStream(wrap({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } }));
              await pause();
            }
            emitStream(wrap({ type: 'content_block_stop', index: 1 }));
            const answer = step.text.join('');
            emitStream({
              type: 'assistant',
              message: { id, role: 'assistant', model, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } },
              session_id: outputSessionId,
            });
            emitStream(wrap({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }));
            emitStream(wrap({ type: 'message_stop' }));
            process.stdout.write(JSON.stringify({
              type: 'result', subtype: 'success', is_error: false,
              duration_ms: gap * 50, num_turns: 3, result: answer, session_id: outputSessionId,
              total_cost_usd: 0.002, usage: { input_tokens: 30, output_tokens: 60 },
            }) + '\n', () => process.exit(0));
          }
        })();
        return;
      }

      if (mode === 'speed') {
        (async () => {
          const gap = chunkDelayMs > 0 ? chunkDelayMs : 150;
          const pause = (ms = gap) => new Promise((r) => setTimeout(r, ms));
          const model = modelFlag || 'mock-model';
          const first = ['Measuring ', 'the first ', 'message of ', 'this turn. '];
          const second = ['Then a ', 'second message ', 'after the tool ', 'ran.'];
          const msg1 = `${msgId}_1`;
          const msg2 = `${msgId}_2`;
          // Message 1: text, then a tool call.
          emitStream(wrap({ type: 'message_start', message: { id: msg1, role: 'assistant', content: [], model, usage: { input_tokens: 12, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 1 } } }));
          await pause();
          emitStream(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
          for (const t of first) {
            emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }));
            await pause();
          }
          emitStream(wrap({ type: 'content_block_stop', index: 0 }));
          emitStream({
            type: 'assistant',
            message: { id: msg1, role: 'assistant', model, content: [{ type: 'text', text: first.join('') }, { type: 'tool_use', id: 'toolu_mock_speed', name: 'Bash', input: { command: 'true' } }], stop_reason: 'tool_use', usage: { input_tokens: 12, output_tokens: 30 } },
            session_id: outputSessionId,
          });
          emitStream(wrap({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 12, cache_read_input_tokens: 800, output_tokens: 30 } }));
          emitStream(wrap({ type: 'message_stop' }));
          // The tool runs: no model output for a while. Much longer than the two
          // generation windows (~10 pauses), so the gap's exclusion shows even
          // when a loaded machine stretches every timer.
          await pause(gap * 20);
          emitStream({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mock_speed', content: 'ok' }] }, session_id: outputSessionId });
          // Message 2: the answer.
          emitStream(wrap({ type: 'message_start', message: { id: msg2, role: 'assistant', content: [], model, usage: { input_tokens: 14, cache_read_input_tokens: 812, cache_creation_input_tokens: 0, output_tokens: 1 } } }));
          await pause();
          emitStream(wrap({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
          for (const t of second) {
            emitStream(wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }));
            await pause();
          }
          emitStream(wrap({ type: 'content_block_stop', index: 0 }));
          emitStream({
            type: 'assistant',
            message: { id: msg2, role: 'assistant', model, content: [{ type: 'text', text: second.join('') }], stop_reason: 'end_turn', usage: { input_tokens: 14, output_tokens: 20 } },
            session_id: outputSessionId,
          });
          emitStream(wrap({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 14, cache_read_input_tokens: 812, output_tokens: 20 } }));
          emitStream(wrap({ type: 'message_stop' }));
          process.stdout.write(JSON.stringify({
            type: 'result', subtype: 'success', is_error: false,
            duration_ms: gap * 30, duration_api_ms: gap * 10, num_turns: 2,
            result: second.join(''), session_id: outputSessionId, total_cost_usd: 0.0123,
            usage: { input_tokens: 26, cache_read_input_tokens: 1612, cache_creation_input_tokens: 0, output_tokens: 50 },
          }) + '\n', () => process.exit(0));
        })();
        return;
      }

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

    // 2a.8b. "workflow-test-live[:unitMs]": a five-phase workflow on a real clock,
    //        shaped like a real deep-research run, so the stage graph is watched
    //        LIVE: Scope splits into 5 searches; each search hands 3 pages to Fetch
    //        the moment it finishes (a stream, with one fetch failing, and a gap
    //        where every fetch is done while the last search still runs); Verify
    //        waits for all 15 fetches, then checks 20 claims 8 at a time (queued
    //        ones are ghosts until they start, as in the CLI); Synthesize merges.
    //        Fields and clocks are the CLI's (epoch ms queuedAt/startedAt,
    //        durationMs, state start/done/error). One unit defaults to 400 ms
    //        (~9s run); `workflow-test-live:1000` slows it down for a recording.
    if (/^workflow-test-live(:\d+)?$/.test(effectiveMessage)) {
      function emitWf(line) { process.stdout.write(JSON.stringify(line) + '\n'); }
      const sid = outputSessionId;
      const UNIT = Number(effectiveMessage.split(':')[1]) || 400;
      const PHASES = ['Scope', 'Search', 'Fetch', 'Verify', 'Synthesize'];
      const MODEL = 'global.anthropic.claude-sonnet-4-6';
      // Each agent: phase, label, queued / started / duration in units.
      const plan = [{ phase: 1, label: 'scope the question', q: 0, s: 0, d: 3 }];
      const searchD = [3, 4, 5, 6, 12];
      searchD.forEach((d, i) => plan.push({ phase: 2, label: `search angle ${i + 1}`, q: 3, s: 3, d }));
      searchD.forEach((d, i) => {
        for (let j = 0; j < 3; j++) {
          plan.push({ phase: 3, label: `fetch page ${i + 1}.${j + 1}`, q: 3 + d, s: 3 + d, d: 2 + j * 0.75, fail: i === 1 && j === 2 });
        }
      });
      const endOf = (phase) => Math.max(...plan.filter(a => a.phase === phase).map(a => a.s + a.d));
      const vq = endOf(3) + 0.5;
      for (let k = 0; k < 20; k++) plan.push({ phase: 4, label: `verify claim ${k + 1}`, q: vq, s: vq + Math.floor(k / 8) * 1.5, d: 1.5 });
      const sq = endOf(4) + 0.5;
      plan.push({ phase: 5, label: 'write the report', q: sq, s: sq, d: 3 });
      const t0 = Date.now();
      const at = (u) => t0 + Math.round(u * UNIT);
      plan.forEach((a, i) => { a.index = i + 1; a.agentId = `wfl-${String(i + 1).padStart(2, '0')}`; });
      const phaseRows = PHASES.map((title, i) => ({ type: 'workflow_phase', index: i + 1, title }));
      const base = (a) => ({ type: 'workflow_agent', index: a.index, label: a.label, phaseIndex: a.phase, phaseTitle: PHASES[a.phase - 1] });
      const TOOLS = ['WebSearch', 'WebFetch', 'Read'];
      let tokens = 0;

      // Every change at one instant rides one task_progress snapshot, like the CLI's.
      const events = new Map();
      const on = (u, entry) => { const list = events.get(u) ?? []; list.push(entry); events.set(u, list); };
      for (const a of plan) {
        if (a.s > a.q) on(a.q, () => ({ ...base(a), state: 'start' })); // ghost: queued, no id yet
        on(a.s, () => ({ ...base(a), agentId: a.agentId, model: MODEL, state: 'start', queuedAt: at(a.q), startedAt: at(a.s), attempt: 1, promptPreview: `Task: ${a.label}` }));
        for (let u = a.s + 1; u < a.s + a.d; u++) {
          on(u, () => ({ ...base(a), agentId: a.agentId, state: 'start', toolCalls: Math.round(u - a.s), lastToolName: TOOLS[(a.index + Math.round(u)) % TOOLS.length], lastProgressAt: at(u) }));
        }
        on(a.s + a.d, () => {
          const used = 1800 + a.index * 37;
          tokens += used;
          return a.fail
            ? { ...base(a), agentId: a.agentId, state: 'error', durationMs: Math.round(a.d * UNIT), tokens: used, toolCalls: Math.ceil(a.d), error: 'Fetch failed: the page answered 403 Forbidden' }
            : { ...base(a), agentId: a.agentId, state: 'done', durationMs: Math.round(a.d * UNIT), tokens: used, toolCalls: Math.ceil(a.d) + 1, lastToolName: 'StructuredOutput', resultPreview: `Finished: ${a.label}` };
        });
      }

      emitWf({ type: 'assistant', message: { id: 'msg_wf_live', type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: 'Research workflow launched in background' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 30 } }, session_id: sid });
      emitWf({
        type: 'system', subtype: 'task_started', session_id: sid, task_id: 'wf-live',
        task_type: 'local_workflow', workflow_name: 'deep-research',
        description: 'Research a question: search, fetch, verify, then write it up',
        prompt: "export const meta = { name: 'deep-research', phases: [{title:'Scope'},{title:'Search'},{title:'Fetch'},{title:'Verify'},{title:'Synthesize'}] }",
      });
      emitWf({ type: 'result', subtype: 'success', is_error: false, duration_ms: 200, num_turns: 1, result: 'Research workflow launched in background', session_id: sid, total_cost_usd: 0.002, usage: { input_tokens: 100, output_tokens: 30 } });

      const times = [...events.keys()].sort((x, y) => x - y);
      for (const u of times) {
        setTimeout(() => {
          const entries = events.get(u).map(make => make());
          emitWf({ type: 'system', subtype: 'task_progress', session_id: sid, task_id: 'wf-live', summary: 'Running', usage: { total_tokens: tokens }, workflow_progress: [...phaseRows, ...entries] });
        }, 150 + Math.round(u * UNIT));
      }
      const last = 150 + Math.round(times[times.length - 1] * UNIT);
      setTimeout(() => {
        emitWf({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: 'wf-live', status: 'completed' });
      }, last + 100);
      setTimeout(() => {
        emitWf({ type: 'system', subtype: 'session_state_changed', session_id: sid, state: 'idle' });
      }, last + 250);
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
    persistPlainTurn(outputSessionId, message, assistantEvent);

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
      // mode-change:* (matched before adoption) and error/parse-error (checked at
      // top level) don't apply when they arrive as the adopted first FIFO message.
      // slow: does: a send that respawns the CLI arrives this way, and a test that
      // looks at a question while its answer is coming needs the turn to last
      // (2026-10-04: the answer landed at once and the live state was never seen).
      if (slowDelayMs > 0) {
        persistPlainUser(outputSessionId, message);
        const stopSwitch = startTagSwitch();
        const pending = setTimeout(() => { onInterrupt = null; emitRemainingEvents(); }, slowDelayMs);
        onInterrupt = () => { clearTimeout(pending); stopSwitch(); emitAbortedTurnTail(); };
      } else {
        emitRemainingEvents();
      }
    })();
  } else {
    // For mode-change messages, ensure remaining events fire AFTER the mode-change system event
    const effectiveDelay = modeChangeMatch ? Math.max(slowDelayMs, 200) : slowDelayMs;
    if (effectiveDelay > 0) {
      // A slow turn is a turn in flight: an `interrupt` control_request aborts
      // it (real CLI) instead of letting the delayed result land later.
      if (slowDelayMs > 0) persistPlainUser(outputSessionId, message);
      const stopSwitch = slowDelayMs > 0 ? startTagSwitch() : () => {};
      const pending = setTimeout(() => { onInterrupt = null; emitRemainingEvents(); }, effectiveDelay);
      onInterrupt = () => { clearTimeout(pending); stopSwitch(); emitAbortedTurnTail(); };
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
