/**
 * claude-cli protocol adapter — spawns `claude -p` as an inference engine, so a
 * machine with Claude Code on it needs no key of its own: whatever the user's
 * `claude` signs in with (subscription, Bedrock, Vertex, an API key) is what
 * Walnut's background work uses. This is the default provider when the binary
 * is installed (see default-provider.ts).
 *
 * TOOLS work via the PSEUDO-TOOL PROTOCOL (claude-cli-protocol.ts): the CLI
 * never returns un-executed tool_use blocks, so instead the system prompt
 * embeds Walnut's tool schemas + a strict JSON output contract, and this
 * adapter parses the text back into synthetic tool_use ContentBlocks. loop.ts
 * then executes tools exactly as with a native provider. Consecutive turns of
 * one conversation ride ONE CLI session via --session-id/--resume, which also
 * gives prefix-cache hits (subscription limits burn slower).
 *
 * HARD CONSTRAINTS (verified against the Claude Code fork v2.1.88):
 *  - `--tools ""` disables EVERY built-in CLI tool (the fork turns an empty
 *    base-tool set into a deny-all — Bash/Edit/Write/… never run). We rely on
 *    this rather than `--disallowedTools "*"` (a `*` wildcard matches nothing).
 *  - Auth is left EXACTLY as the user's own `claude` has it: the spawn inherits
 *    the environment untouched and reads ~/.claude/settings.json like any other
 *    Claude Code process (Bedrock users keep CLAUDE_CODE_USE_BEDROCK + AWS creds
 *    there; subscription users have the OAuth store). An earlier version stripped
 *    every AWS/Anthropic variable and forced the subscription via --settings,
 *    which made the provider unusable for everyone whose Claude Code runs on
 *    Bedrock. Only CLAUDECODE (the nested-session marker) is removed.
 *  - NEVER `--bare` (that forces API-key-only and never reads the subscription).
 *  - We never read a credential VALUE anywhere — auth is entirely the CLI's job.
 *  - At most MAX_CONCURRENT_CLI turns run at once: each is a whole `claude`
 *    process (seconds to start, hundreds of MB), and background callers can
 *    fan out (titles, summaries, subagents) faster than a laptop can absorb.
 *
 * The CLI runs its OWN agent loop and executes its own tools; it never returns
 * un-executed tool_use blocks. With tools disabled it simply emits text. We
 * serialize Walnut's Anthropic-shaped messages into one text prompt, stream the
 * reply back via onTextDelta, and read the final `result` line for real usage.
 */
import { spawn } from 'node:child_process';
import type {
  ApiProtocol, ProtocolAdapter, AdapterCallOptions, ModelResult, ContentBlock,
  MessageParam, TextBlockParam, UsageStats,
} from './types.js';
import { parseClaudeJsonlLine, type ClaudeStreamResult } from '../../providers/claude-stream-parser.js';
import { WALNUT_UTILITY_ENTRYPOINT } from '../../providers/inline-subagent.js';
import { abortedResult } from './retry.js';
import { log } from '../../logging/index.js';
import { resolveClaudeCliExecutable } from '../../core/claude-cli-detect.js';
import { randomUUID } from 'node:crypto';
import {
  buildToolProtocolSection, parseProtocolReply, synthesizeToolUseBlocks,
  serializeToolResults, isToolResultTurn, conversationKey, PROTOCOL_RETRY_PROMPT,
} from './claude-cli-protocol.js';

/** The one env var the spawn must not inherit: the nested-session marker, which
 *  would make the child think it runs inside another Claude session
 *  (inline-subagent strips it for the same reason). Auth vars pass through. */
const ENV_TO_STRIP = ['CLAUDECODE'] as const;

/** Concurrent `claude` processes this adapter will run (WALNUT_CLAUDE_CLI_CONCURRENCY overrides). */
export const MAX_CONCURRENT_CLI = (() => {
  const n = Number(process.env.WALNUT_CLAUDE_CLI_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
})();

/** How long to wait for the CLI to finish one text turn before giving up. */
const CLI_TURN_TIMEOUT_MS = 120_000;

/** One tracked CLI session per live conversation (keyed by conversationKey). */
interface CliSession {
  sessionId: string;
  /** How many messages of the conversation the CLI has already seen. */
  seenMessages: number;
  lastUsedAt: number;
}

/** Sessions idle longer than this are dropped (CLI-side cache is long gone). */
const SESSION_REUSE_TTL_MS = 30 * 60 * 1000;
/** Bound the map — Personal AI conversations are few; this is a leak guard. */
const MAX_TRACKED_SESSIONS = 50;

export class ClaudeCliAdapter implements ProtocolAdapter {
  readonly protocol: ApiProtocol = 'claude-cli';

  /** conversationKey → CLI session for --resume chaining. In-process only. */
  private sessions = new Map<string, CliSession>();

  /** Process gate: MAX_CONCURRENT_CLI turns at once, the rest queue in order. */
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= MAX_CONCURRENT_CLI) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
      this.waiters.shift()?.();
    }
  }
  /** Test hook: how many turns are running / waiting right now. */
  _gateStateForTesting(): { inFlight: number; waiting: number } {
    return { inFlight: this.inFlight, waiting: this.waiters.length };
  }

  resetClient(): void {
    // Forget resume state — next calls start fresh CLI sessions.
    this.sessions.clear();
  }

  async sendMessage(opts: AdapterCallOptions): Promise<ModelResult> {
    return this.runProtocolTurn(opts);
  }

  async sendMessageStream(
    opts: AdapterCallOptions & { onTextDelta?: (delta: string) => void },
  ): Promise<ModelResult> {
    return this.runProtocolTurn(opts, opts.onTextDelta);
  }

  /**
   * One protocol turn: spawn (or resume) the CLI, parse the text reply against
   * the pseudo-tool contract, retry once on malformed output, and return either
   * synthetic tool_use blocks or a plain text result.
   */
  private async runProtocolTurn(
    opts: AdapterCallOptions,
    onTextDelta?: (delta: string) => void,
  ): Promise<ModelResult> {
    const hasTools = !!opts.tools && opts.tools.length > 0;
    // Streaming deltas are held back in tools mode: the raw output is protocol
    // JSON, not user-facing prose. The parsed reply text is delivered once at
    // the end instead (loop callbacks still stream tool activity).
    const deltas = hasTools ? undefined : onTextDelta;

    let result = await this.spawnTurn(opts, deltas);
    if (!hasTools || result.aborted) return result;

    let raw = textOf(result);
    let parsed = parseProtocolReply(raw);
    if (parsed.kind === 'malformed') {
      log.agent.warn('claude-cli protocol violation — retrying once', { head: raw.slice(0, 120) });
      const firstUsage = result.usage;
      result = await this.spawnTurn(opts, undefined, PROTOCOL_RETRY_PROMPT);
      if (result.aborted) return result;
      // Both spawns burned real subscription quota — report the sum.
      result = { ...result, usage: sumUsage(firstUsage, result.usage) };
      raw = textOf(result);
      parsed = parseProtocolReply(raw);
    }

    if (parsed.kind === 'tool_calls') {
      return {
        content: synthesizeToolUseBlocks(parsed.calls, parsed.leadText),
        stopReason: 'tool_use',
        usage: result.usage,
      };
    }
    // reply (or still-malformed → surface the raw text rather than dropping it)
    const text = parsed.kind === 'reply' ? parsed.text : parsed.text;
    onTextDelta?.(text);
    return {
      content: text ? [{ type: 'text', text } as ContentBlock] : [],
      stopReason: 'end_turn',
      usage: result.usage,
    };
  }

  /**
   * Spawn one `claude -p` turn. Reuses a live CLI session via --resume when the
   * incoming messages extend a conversation we've seen (prefix grew), so only
   * the NEW tail is sent and the CLI's prefix cache does its job. Falls back to
   * a fresh session (full history replay) when resume isn't possible.
   */
  private spawnTurn(
    opts: AdapterCallOptions,
    onTextDelta?: (delta: string) => void,
    overridePrompt?: string,
  ): Promise<ModelResult> {
    const env = buildSpawnEnv();
    const command = opts.providerConfig.claude_cli_command
      || resolveClaudeCliExecutable()
      || 'claude';

    const key = conversationKey(systemKeyOf(opts), opts.messages);
    const now = Date.now();
    const tracked = this.sessions.get(key);
    const canResume = !overridePrompt
      && tracked
      && now - tracked.lastUsedAt < SESSION_REUSE_TTL_MS
      && opts.messages.length > tracked.seenMessages;

    let prompt: string;
    let session: { flag: '--resume' | '--session-id'; id: string };
    if (overridePrompt && tracked) {
      // Corrective retry rides the same session — the broken turn is context.
      prompt = overridePrompt;
      session = { flag: '--resume', id: tracked.sessionId };
    } else if (canResume && tracked) {
      // Send only the NEW tail. A tool_result tail uses the protocol envelope;
      // anything else is flattened the usual way. Leading assistant messages
      // are skipped: the CLI's transcript already contains the reply it just
      // produced — re-sending it as "Assistant: ..." text would both waste
      // tokens and invite role-confusion echo.
      let tail = opts.messages.slice(tracked.seenMessages);
      while (tail.length > 1 && tail[0].role === 'assistant') tail = tail.slice(1);
      const last = tail[tail.length - 1];
      prompt = isToolResultTurn(last)
        ? serializeToolResults(last.content)
        : serializePrompt(tail);
      session = { flag: '--resume', id: tracked.sessionId };
    } else {
      // Fresh session: replay full history, mint the id we'll resume later.
      // A corrective retry with no live session appends the nudge to the replay.
      prompt = serializePrompt(opts.messages)
        + (overridePrompt ? `\n\nUser: ${overridePrompt}` : '');
      session = { flag: '--session-id', id: randomUUID() };
    }
    if (!prompt.trim()) prompt = '(continue)';

    const args = [...buildArgs(opts), session.flag, session.id];

    return this.withSlot(() => this.execCli(command, args, env, prompt, opts.signal, onTextDelta))
      .then((result) => {
        // Track AFTER a successful turn: the CLI now knows the whole history
        // plus the assistant turn it just produced.
        this.sessions.set(key, {
          sessionId: session.id,
          seenMessages: opts.messages.length,
          lastUsedAt: Date.now(),
        });
        this.pruneSessions();
        return result;
      })
      .catch((err) => {
        // A failed resume (dead session, evicted state) must not kill the turn:
        // drop the tracked session and retry once from scratch.
        if (session.flag === '--resume') {
          log.agent.warn('claude-cli resume failed — falling back to a fresh session', {
            error: (err as Error).message,
          });
          this.sessions.delete(key);
          // Fresh replay must carry the FULL history — an overridePrompt-only
          // prompt would strand a context-free session and then stick (it gets
          // registered below and resumed forever after).
          const freshPrompt = serializePrompt(opts.messages)
            + (overridePrompt ? `\n\nUser: ${overridePrompt}` : '');
          const freshId = randomUUID();
          const freshArgs = [...buildArgs(opts), '--session-id', freshId];
          return this.withSlot(() => this.execCli(command, freshArgs, env, freshPrompt || '(continue)', opts.signal, onTextDelta))
            .then((result) => {
              this.sessions.set(key, {
                sessionId: freshId,
                seenMessages: opts.messages.length,
                lastUsedAt: Date.now(),
              });
              return result;
            });
        }
        throw err;
      });
  }

  /** Drop idle sessions; cap the map size (oldest first). */
  private pruneSessions(): void {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (now - s.lastUsedAt > SESSION_REUSE_TTL_MS) this.sessions.delete(k);
    }
    if (this.sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = [...this.sessions.entries()]
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
        .slice(0, this.sessions.size - MAX_TRACKED_SESSIONS);
      for (const [k] of oldest) this.sessions.delete(k);
    }
  }

  /** Low-level: run one CLI subprocess and collect its stream-json output. */
  private execCli(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    prompt: string,
    signal?: AbortSignal,
    onTextDelta?: (delta: string) => void,
  ): Promise<ModelResult> {

    return new Promise<ModelResult>((resolve, reject) => {
      let settled = false;
      let accumulatedText = '';
      let finalResult: ClaudeStreamResult | undefined;
      let stderrTail = '';
      let stdoutBuffer = '';

      const child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`claude-cli turn timed out after ${CLI_TURN_TIMEOUT_MS}ms`)));
      }, CLI_TURN_TIMEOUT_MS);

      // Abort → kill the child and return whatever text we had. The listener
      // is removed in finish(): the signal is shared across every spawn of a
      // turn (tool rounds + retries), so leaking one listener per spawn would
      // pile up toward MaxListenersExceededWarning on long tool runs.
      let onAbort: (() => void) | undefined;
      if (signal) {
        if (signal.aborted) {
          finish(() => resolve(abortedResult()));
          return;
        }
        onAbort = () => finish(() => resolve(abortedResult(accumulatedText)));
        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        // Process complete JSONL lines; keep the trailing partial in the buffer.
        let nl: number;
        while ((nl = stdoutBuffer.indexOf('\n')) !== -1) {
          const line = stdoutBuffer.slice(0, nl);
          stdoutBuffer = stdoutBuffer.slice(nl + 1);
          consumeLine(line);
        }
      });

      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => {
        // Keep only the tail — CLI stderr can be chatty (--debug etc.).
        stderrTail = (stderrTail + chunk).slice(-2000);
      });

      child.on('error', (err) => {
        finish(() => reject(new Error(`claude-cli spawn failed: ${err.message}`)));
      });

      child.on('close', (code) => {
        // Drain any final partial line.
        if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
        finish(() => {
          if (finalResult?.isError) {
            reject(new Error(`claude-cli reported an error: ${finalResult.result || stderrTail || 'unknown'}`));
            return;
          }
          // The CLI reports an expired/broken login as a SUCCESS result whose
          // text is the auth error (observed live: "Failed to authenticate.
          // API Error: 401 OAuth access token has expired..."). Surfacing that
          // as the assistant's reply confuses every caller — reject honestly so
          // the UI can say "run `claude login`". Anchored + length-bounded so a
          // real reply DISCUSSING OAuth expiry is never misclassified.
          const resultText = finalResult?.result || accumulatedText;
          if (resultText && resultText.length < 300
              && /^\s*failed to authenticate|^\s*api error: 4\d\d/i.test(resultText)) {
            reject(new Error(`claude-cli could not authenticate — run \`claude\` once in a terminal to sign in (or check its Bedrock settings). CLI said: ${resultText.slice(0, 200)}`));
            return;
          }
          if (code !== 0 && !accumulatedText && !finalResult) {
            reject(new Error(`claude-cli exited ${code}: ${stderrTail || 'no output'}`));
            return;
          }
          // Prefer the canonical result text; fall back to streamed deltas.
          const text = finalResult?.result || accumulatedText;
          const content: ContentBlock[] = text
            ? [{ type: 'text', text } as ContentBlock]
            : [];
          resolve({
            content,
            stopReason: 'end_turn',
            usage: toUsageStats(finalResult),
          });
        });
      });

      // Consume one parsed JSONL line.
      function consumeLine(line: string) {
        const block = parseClaudeJsonlLine(line, {
          onResult: (r) => { finalResult = r; },
        });
        if (!block) return;
        const blocks = Array.isArray(block) ? block : [block];
        for (const b of blocks) {
          if (b.type === 'text' && b.content) {
            accumulatedText += b.content;
            onTextDelta?.(b.content);
          }
          // tool_call / system blocks are ignored — tools are disabled, and the
          // CLI shouldn't emit them; if it does, we don't surface them.
        }
      }

      // Feed the prompt on stdin (text input mode) and close.
      child.stdin.write(prompt);
      child.stdin.end();
    }).catch((err) => {
      log.agent.warn('claude-cli adapter turn failed', { error: (err as Error).message });
      throw err;
    });
  }
}

/** Assemble the argv for a text-only `claude -p` turn on the CLI's own login. */
export function buildArgs(opts: AdapterCallOptions): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',                        // stream-json requires verbose for the full event stream
    '--include-partial-messages',       // stream text deltas as they arrive
    // Input stays default (text): we write the whole prompt to stdin and close.
    // (stream-json INPUT would force us into a JSON envelope for no gain here.)
    '--tools', '',                      // disable ALL built-in tools (deny-all)
    // No --settings override: the user's settings.json (and so their auth) applies as-is.
  ];
  // The Personal AI persona replaces the CLI's default coding-agent system prompt so
  // it answers as the Personal AI, not as a code assistant. --system-prompt (replace)
  // is verified to exist in the fork.
  let systemText = systemToText(opts.system).trim();
  // Pseudo-tool protocol: the CLI's own tools stay OFF (--tools "" above), but
  // Walnut's tools ride a strict JSON output contract appended here; the
  // adapter parses replies into synthetic tool_use blocks for loop.ts.
  if (opts.tools && opts.tools.length > 0) {
    const protocol = buildToolProtocolSection(opts.tools);
    systemText = systemText ? `${systemText}\n\n${protocol}` : protocol;
  }
  if (systemText) {
    args.push('--system-prompt', systemText);
  }
  // Only forward a model when it's a real Claude model id (subscription models
  // are Anthropic `claude-*`). Bedrock catalog ids (global.*, us.*) or the [1m]
  // context marker aren't valid CLI `--model` values → let the CLI use its default.
  const model = normalizeCliModel(opts.model);
  if (model) {
    args.push('--model', model);
  }
  return args;
}

/** All text content of a ModelResult, concatenated. */
function textOf(result: ModelResult): string {
  return result.content
    .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
    .join('');
}

/** Conversation-stable system string for keying (protocol section excluded —
 *  it varies with the tool list, which can differ per call within one convo). */
function systemKeyOf(opts: AdapterCallOptions): string {
  return systemToText(opts.system).trim();
}

/** Flatten a system prompt (string | text blocks) into plain text. */
function systemToText(system: string | TextBlockParam[]): string {
  return typeof system === 'string'
    ? system
    : system.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

/** Build the spawn env: inherit as-is (the CLI's auth lives in the env and in
 *  its settings file), drop only the nested-session marker. Never injects a credential. */
export function buildSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of ENV_TO_STRIP) {
    delete env[key];
  }
  // These children are the Personal AI's own turn engine, not user work
  // sessions — the marker keeps their transcripts out of the session-import
  // scan (which otherwise lists every sdk-cli transcript in a real cwd).
  env.CLAUDE_CODE_ENTRYPOINT = WALNUT_UTILITY_ENTRYPOINT;
  return env;
}

/**
 * Serialize the Personal AI's message history into a single plain text prompt written
 * to stdin (default text input mode). The system/persona is passed separately via
 * --system-prompt. Prior turns are flattened as `User:` / `Assistant:` lines for
 * continuity; the final user turn ends the prompt so the CLI answers it.
 */
export function serializePrompt(messages: MessageParam[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const text = messageToText(msg.content);
    if (!text.trim()) continue;
    parts.push(msg.role === 'assistant' ? `Assistant: ${text}` : `User: ${text}`);
  }
  return parts.join('\n\n');
}

/** Flatten Anthropic message content (string | blocks) into plain text.
 *  tool_use / tool_result blocks are rendered as compact tags — this provider
 *  is text-only, so we keep just enough for context continuity. */
function messageToText(content: MessageParam['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string; content?: unknown; name?: string };
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push(b.text);
    } else if (b.type === 'tool_use') {
      out.push(`[called tool: ${b.name ?? 'unknown'}]`);
    } else if (b.type === 'tool_result') {
      const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      out.push(`[tool result: ${c}]`);
    }
  }
  return out.join('\n');
}

/** Sum usage across the two spawns of a corrective retry. */
function sumUsage(a?: UsageStats, b?: UsageStats): UsageStats | undefined {
  if (!a) return b;
  if (!b) return a;
  const add = (x?: number, y?: number) => (x ?? 0) + (y ?? 0);
  return {
    input_tokens: add(a.input_tokens, b.input_tokens),
    output_tokens: add(a.output_tokens, b.output_tokens),
    cache_creation_input_tokens: add(a.cache_creation_input_tokens, b.cache_creation_input_tokens),
    cache_read_input_tokens: add(a.cache_read_input_tokens, b.cache_read_input_tokens),
  };
}

/** Map the CLI result line's usage into Walnut's UsageStats. */
function toUsageStats(result?: ClaudeStreamResult): UsageStats | undefined {
  const u = result?.usage;
  if (!u) return undefined;
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
  };
}

/**
 * Return a CLI-valid `--model` value, or undefined to let the subscription pick
 * its default. Bedrock/catalog ids (`global.*`, `us.*`, `apac.*`) and the `[1m]`
 * context marker are NOT valid CLI model args, so we drop them.
 */
export function normalizeCliModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  // Strip the [1m] context-window marker the catalog / CLI init may carry.
  const stripped = model.replace(/\[1m\]$/, '');
  // Region/inference-profile prefixes are Bedrock-only; not valid for the CLI.
  if (/^(global|us|eu|apac|apne\d)\./.test(stripped)) return undefined;
  // Accept plain Anthropic ids (`claude-…`) or short aliases (`opus`, `sonnet`, `haiku`).
  if (/^claude[-.]/.test(stripped) || /^(opus|sonnet|haiku)\b/.test(stripped)) {
    return stripped;
  }
  // Anything else: safer to let the CLI use the subscription default.
  return undefined;
}
