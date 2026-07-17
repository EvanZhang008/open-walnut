/**
 * claude-cli protocol adapter — spawns `claude -p` as a TEXT-ONLY inference
 * engine for users whose only Anthropic access is a Claude Code SUBSCRIPTION
 * (no API key, no Bedrock). The butler's loop tolerates a text-only adapter
 * (zero tool_use blocks) gracefully, so this powers title-gen / triage /
 * summaries / memory distillation and plain conversational replies.
 *
 * HARD CONSTRAINTS (verified against the Claude Code fork v2.1.88):
 *  - `--tools ""` disables EVERY built-in CLI tool (the fork turns an empty
 *    base-tool set into a deny-all — Bash/Edit/Write/… never run). We rely on
 *    this rather than `--disallowedTools "*"` (a `*` wildcard matches nothing).
 *  - Force the SUBSCRIPTION, not Bedrock/keys:
 *      (a) strip AWS_* + ANTHROPIC_API_KEY + ANTHROPIC_AUTH_TOKEN + CLAUDE_CODE_USE_BEDROCK
 *          from the spawn env, AND
 *      (b) pass `--settings '{"env":{"CLAUDE_CODE_USE_BEDROCK":""}}'` — the fork
 *          Object.assign's settings.json's `env` over process.env, so unsetting
 *          it in the env alone is NOT enough; flagSettings outrank userSettings.
 *    Bedrock falsy + no api key/token → the fork uses the logged-in OAuth token.
 *  - NEVER `--bare` (that forces API-key-only and never reads the subscription).
 *  - We never read the token VALUE anywhere — auth is entirely the CLI's job.
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
import { abortedResult } from './retry.js';
import { log } from '../../logging/index.js';

/** Env vars we must NOT let reach the spawn — any of these would divert the CLI
 *  away from the subscription (Bedrock/Vertex routing) or leak a static key. */
const AUTH_ENV_TO_STRIP = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  // Nested-session marker — inline-subagent strips this too so the child doesn't
  // think it's running inside another Claude session.
  'CLAUDECODE',
] as const;

/** Inline settings that force subscription auth regardless of what
 *  ~/.claude/settings.json's env block says (flagSettings > userSettings). */
const FORCE_SUBSCRIPTION_SETTINGS = JSON.stringify({
  env: { CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '' },
});

/** How long to wait for the CLI to finish one text turn before giving up. */
const CLI_TURN_TIMEOUT_MS = 120_000;

export class ClaudeCliAdapter implements ProtocolAdapter {
  readonly protocol: ApiProtocol = 'claude-cli';

  // Stateless subprocess provider — no client to cache.
  resetClient(): void {
    /* no-op: each call spawns a fresh subprocess */
  }

  async sendMessage(opts: AdapterCallOptions): Promise<ModelResult> {
    return this.run(opts);
  }

  async sendMessageStream(
    opts: AdapterCallOptions & { onTextDelta?: (delta: string) => void },
  ): Promise<ModelResult> {
    return this.run(opts, opts.onTextDelta);
  }

  /** Spawn `claude -p`, stream its text reply, resolve to a text-only ModelResult. */
  private run(
    opts: AdapterCallOptions,
    onTextDelta?: (delta: string) => void,
  ): Promise<ModelResult> {
    const args = buildArgs(opts);
    const env = buildSpawnEnv();
    const command = opts.providerConfig.claude_cli_command || 'claude';
    const prompt = serializePrompt(opts.messages);

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
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`claude-cli turn timed out after ${CLI_TURN_TIMEOUT_MS}ms`)));
      }, CLI_TURN_TIMEOUT_MS);

      // Abort → kill the child and return whatever text we had.
      if (opts.signal) {
        if (opts.signal.aborted) {
          finish(() => resolve(abortedResult()));
          return;
        }
        opts.signal.addEventListener('abort', () => {
          finish(() => resolve(abortedResult(accumulatedText)));
        }, { once: true });
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

/** Assemble the argv for a text-only, subscription-forced `claude -p` turn. */
export function buildArgs(opts: AdapterCallOptions): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',                        // stream-json requires verbose for the full event stream
    '--include-partial-messages',       // stream text deltas as they arrive
    // Input stays default (text): we write the whole prompt to stdin and close.
    // (stream-json INPUT would force us into a JSON envelope for no gain here.)
    '--tools', '',                      // disable ALL built-in tools (deny-all)
    '--settings', FORCE_SUBSCRIPTION_SETTINGS,
  ];
  // The butler persona replaces the CLI's default coding-agent system prompt so
  // it answers as the butler, not as a code assistant. --system-prompt (replace)
  // is verified to exist in the fork.
  let systemText = systemToText(opts.system).trim();
  // Text-only guard: the butler persona advertises tools this provider can't run
  // (the CLI is spawned with --tools ""). If the loop passed tools, tell the model
  // to answer directly in prose instead of attempting a tool call it can't make.
  if (opts.tools && opts.tools.length > 0) {
    const notice = 'You are running in TEXT-ONLY mode: no tools are available. '
      + 'Do not attempt to call any tool. Answer directly and completely in prose.';
    systemText = systemText ? `${systemText}\n\n${notice}` : notice;
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

/** Flatten a system prompt (string | text blocks) into plain text. */
function systemToText(system: string | TextBlockParam[]): string {
  return typeof system === 'string'
    ? system
    : system.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

/** Build the spawn env: inherit, then STRIP every auth-routing var so the CLI
 *  falls back to the logged-in subscription. Never injects a credential. */
export function buildSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of AUTH_ENV_TO_STRIP) {
    delete env[key];
  }
  return env;
}

/**
 * Serialize the butler's message history into a single plain text prompt written
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
