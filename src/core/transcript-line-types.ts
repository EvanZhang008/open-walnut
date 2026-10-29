/**
 * The Claude Code transcript line kinds Walnut knows, and a canary for the rest.
 *
 * The history parser (session-history.ts parseSessionMessages) reads two
 * formats: the CLI's canonical transcript (~/.claude/projects/<dir>/<sid>.jsonl)
 * and its stream-json stdout (the daemon's stream files). A CLI upgrade can add
 * a line kind to either; Claude Code 2.1.284 added `api-request-blob` lines
 * (each request message as the model received it, instruction files and memory
 * merged in) and the parser showed them as conversation rows (2026-10-28).
 * Nothing noticed until the user did.
 *
 * So every line whose top-level `type`, or whose user/assistant content block
 * `type`, is not listed here gets ONE structured warning per process per kind.
 * The warning never changes what the parser outputs. When it fires: look at
 * the new kind, decide whether it is a message, plumbing or a fact the UI
 * needs, handle it in the parser, then add it here.
 *
 * Lists built from real 2.1.284 transcripts and stream files (2026-10-28) plus
 * the kinds the parsers name in code. A line with no `type` is an older capture
 * and is not reported.
 */
import { log } from '../logging/index.js';

/** Top-level `type` values of canonical transcript lines and stream-json lines. */
export const KNOWN_TRANSCRIPT_LINE_TYPES: ReadonlySet<string> = new Set([
  // Both formats
  'user',
  'assistant',
  'system',
  // Canonical transcript
  'attachment',
  'queue-operation',
  'last-prompt',
  'summary',
  'progress',
  'file-history-snapshot',
  'file-history-delta',
  'permission-mode',
  'mode',
  'ai-title',
  'custom-title',
  'agent-name',
  'pr-link',
  'cost-state',
  'atis-latch',
  'api-request-blob',
  'api-request-shape',
  // Stream-json stdout (daemon stream files)
  'result',
  'stream_event',
  'tool_progress',
  'command_lifecycle',
  'control_request',
  'control_response',
  'control_cancel_request',
  'rate_limit_event',
  'keep_alive',
]);

/** `message.content[].type` values on user and assistant lines. */
export const KNOWN_MESSAGE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'text',
  'thinking',
  'redacted_thinking',
  'tool_use',
  'tool_result',
  'image',
  'document',
]);

const reported = new Set<string>();

interface CanaryLine {
  type?: unknown;
  version?: unknown;
  claude_code_version?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function report(kind: 'line' | 'block', type: string, line: CanaryLine, fallbackVersion: string | undefined): void {
  const key = `${kind}:${type}`;
  if (reported.has(key)) return;
  reported.add(key);
  log.session.warn(kind === 'line'
    ? 'unknown Claude Code transcript line type: the CLI format may have changed'
    : 'unknown Claude Code message content block type: the CLI format may have changed', {
    kind,
    type,
    cliVersion: str(line.version) ?? str(line.claude_code_version) ?? fallbackVersion,
    sessionId: str(line.sessionId) ?? str(line.session_id),
  });
}

/** Note a parsed line's top-level type. A Set lookup unless the type is new. */
export function noteTranscriptLineType(line: CanaryLine, fallbackVersion?: string): void {
  const t = line.type;
  if (typeof t !== 'string' || KNOWN_TRANSCRIPT_LINE_TYPES.has(t)) return;
  report('line', t, line, fallbackVersion);
}

/** Note the content block types of a user/assistant line's message. */
export function noteMessageBlockTypes(content: unknown, line: CanaryLine, fallbackVersion?: string): void {
  if (!Array.isArray(content)) return;
  for (const b of content) {
    const t = (b as { type?: unknown } | null)?.type;
    if (typeof t !== 'string' || KNOWN_MESSAGE_BLOCK_TYPES.has(t)) continue;
    report('block', t, line, fallbackVersion);
  }
}

/** Test-only: forget which kinds were already reported. */
export function _resetTranscriptCanaryForTesting(): void {
  reported.clear();
}
