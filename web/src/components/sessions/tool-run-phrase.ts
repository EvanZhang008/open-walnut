// The collapsed tool-run line: "Ran 3 commands, read a file ›". Pure, so the
// history row and the streaming row (which must read the same) share it.
import { walnutToolView } from './session-outbound';

/** Phrase category per tool name; unknown tools fall into 'other'. */
function toolPhraseCategory(name: string): string {
  switch (name) {
    case 'Bash': case 'BashOutput': case 'KillShell': return 'command';
    case 'Read': return 'read';
    case 'Edit': case 'Write': case 'NotebookEdit': return 'edit';
    case 'Grep': case 'Glob': case 'WebSearch': return 'search';
    case 'WebFetch': return 'fetch';
    case 'Skill': return 'skill';
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return 'todo';
    case 'AskUserQuestion': return 'ask';
    default: {
      // Walnut's messaging ops say what they did, never "used a tool".
      const op = /^mcp__.+__(.+)$/.exec(name)?.[1];
      if (op === 'task_send' || op === 'session_send' || op === 'org_send' || op === 'board_post') return 'send';
      if (op === 'human_inbox_send' || op === 'human_inbox_reply') return 'inbox';
      return 'other';
    }
  }
}

/**
 * A worker's AskUserQuestion that Walnut sent to its leader instead of the user
 * (src/core/sessions/worker-question.ts). The CLI records it as a denied tool
 * call, but nothing failed: the question went where it belongs, so it never
 * counts as a failure or shows ✗. Keyed on the start of Walnut's own message.
 */
export function isRoutedQuestion(name: string | undefined, result: unknown): boolean {
  return name === 'AskUserQuestion' && typeof result === 'string'
    && result.trimStart().startsWith('In this team your questions go to your leader');
}

/**
 * A call the person said no to: the CLI records the deny's message as the tool's
 * error result (Walnut's own words: a plain deny, a deny with a note, a prompt
 * withdrawn by a new message). Nothing failed, so it is counted as denied, never
 * as failed, and marks its row with its own sign rather than the red cross.
 */
export function isUserDenied(result: unknown): boolean {
  return typeof result === 'string' && /^(User denied permission|The user denied this tool call|The user doesn't want to proceed with this tool use|User sent a new message \u2014 permission auto-denied|User dismissed the questions)/.test(result.trimStart());
}

/**
 * A call a permission rule refused (the CLI's auto mode classifier, a deny rule in the
 * settings), not the person: nothing failed and the person never saw it, so its row
 * stands above the turn's fold (StepRows.tsx LiftedStep) and the line counts it as denied.
 */
export function isRuleDenied(result: unknown): boolean {
  return typeof result === 'string' && /^(Permission for this action was denied|Permission to use \S+ (?:has been|was) denied)/.test(result.trimStart());
}

/** A call's answer that the agent's harness found too long and saved to a file instead. */
export interface TooLongAnswer {
  /** The harness whose wording it is. */
  engine: 'claude-code';
  /** Its size as the harness wrote it ("43,240 characters", "10.5KB"). */
  size: string;
  /** Where the harness saved the whole answer. */
  file?: string;
  /** The harness words it as an error ("Error: result ...") although the call succeeded, so
   *  the call is never a failed one. False where the harness keeps the tool's own outcome:
   *  a command whose long output it saved keeps its exit code's flag. */
  wordedAsError: boolean;
}

/**
 * Every known wording of a too-long answer, one row per engine and wording; a new one is
 * one more row. Each is anchored at the start of the result: only the harness's own note
 * matches, never a tool's output that quotes it.
 */
const TOO_LONG_ANSWERS: ReadonlyArray<{ engine: TooLongAnswer['engine']; wordedAsError: boolean; re: RegExp }> = [
  // Claude Code, any MCP server's tool (the CLI's words, the server's answer is not an error):
  // "Error: result (43,240 characters across 1 line) exceeds maximum allowed tokens. Output has
  // been saved to <dir>/tool-results/mcp-<server>-<tool>-<ms>.txt." It is keyed on "result ("
  // and "Output has been saved to" because the Read tool's "File content (N tokens) exceeds
  // maximum allowed tokens (25000)" is a real failure: the file was not read.
  {
    engine: 'claude-code', wordedAsError: true,
    re: /^(?:Error: )?result \(([\d,]+ characters)(?: across [\d,]+ lines?)?\) exceeds maximum allowed tokens\. Output has been saved to (.+?\.txt)(?=\.?(?:\s|$))/,
  },
  // Claude Code, a built-in tool's output (Bash and the rest), with a preview; never worded
  // as an error: "<persisted-output>\nOutput too large (10.5KB). Full output saved to: <file>".
  {
    engine: 'claude-code', wordedAsError: false,
    re: /^<persisted-output>\s*Output too large \(([\d.]+ ?[KMG]?B)\)\. Full output saved to: (.+)/,
  },
  // Codex: none known. It cuts the middle of a long output in place ("...N tokens truncated..."),
  // which is not an error, and Walnut reads a Codex call's failure from its status alone.
];

/** The harness's note that a call's answer was too long and went to a file, or undefined. */
export function tooLongAnswer(result: unknown): TooLongAnswer | undefined {
  if (typeof result !== 'string') return undefined;
  const text = result.trimStart();
  for (const row of TOO_LONG_ANSWERS) {
    const m = row.re.exec(text);
    if (m) return { engine: row.engine, size: m[1], ...(m[2]?.trim() ? { file: m[2].trim() } : {}), wordedAsError: row.wordedAsError };
  }
  return undefined;
}

/** A too-long answer's line on its call: it completed, and its answer went to a file. */
export const TOO_LONG_ANSWER_NOTE = 'Done. The answer was too long and was saved to a file.';

/** A call as a history row (`isError`, the transcript's flag) or a live block (`status`) holds it. */
export interface CallOutcome {
  name?: string;
  result?: string;
  isError?: boolean;
  status?: string;
}

/**
 * The one rule for a failed call, which every failed count and every row's red reads: the
 * call errored, and it is none of the errors that are not failures (a question routed to
 * the leader, the person's no, a permission rule's no, an answer the harness saved to a
 * file for being too long). Never write this filter by hand (tests/web/fold-failures.test.ts).
 */
export function isFailedCall(t: CallOutcome): boolean {
  if (!t.isError && t.status !== 'error') return false;
  return !isRoutedQuestion(t.name, t.result) && !isUserDenied(t.result) && !isRuleDenied(t.result)
    && !tooLongAnswer(t.result)?.wordedAsError;
}

export interface ToolRunMember {
  name: string;
  input?: Record<string, unknown>;
  /** The call's id and outcome, when the line counts by outcome (foldStepsPhrase). */
  toolUseId?: string;
  result?: string;
  isError?: boolean;
}

function filePathOf(input: Record<string, unknown> | undefined): string | undefined {
  const p = input?.file_path ?? input?.notebook_path;
  return typeof p === 'string' && p ? p : undefined;
}

/**
 * "Ran 3 commands, read a file" — categories in first-appearance order. Reads
 * and edits count FILES, not calls: six Edits to one file is "edited a file"
 * (it read "edited 6 files" beside a Changed view listing one). A call whose
 * path is not known yet counts as its own file.
 */
export function toolRunPhrase(tools: ToolRunMember[]): string {
  const counts = new Map<string, number>();
  const files = new Map<string, Set<string>>();
  for (const t of tools) {
    // A Walnut op through the CLI counts as the MCP call it stands in for.
    const cat = toolPhraseCategory(walnutToolView(t).name);
    const p = cat === 'read' || cat === 'edit' ? filePathOf(t.input) : undefined;
    if (p !== undefined) {
      const seen = files.get(cat) ?? new Set<string>();
      files.set(cat, seen);
      if (seen.has(p)) continue;
      seen.add(p);
    }
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [cat, n] of counts) {
    switch (cat) {
      case 'command': parts.push(n === 1 ? 'ran a command' : `ran ${n} commands`); break;
      case 'read': parts.push(n === 1 ? 'read a file' : `read ${n} files`); break;
      case 'edit': parts.push(n === 1 ? 'edited a file' : `edited ${n} files`); break;
      case 'search': parts.push(n === 1 ? 'searched files' : `ran ${n} searches`); break;
      case 'fetch': parts.push(n === 1 ? 'fetched a page' : `fetched ${n} pages`); break;
      case 'skill': parts.push(n === 1 ? 'launched a skill' : `launched ${n} skills`); break;
      case 'todo': parts.push('updated tasks'); break;
      case 'ask': parts.push(n === 1 ? 'asked a question' : `asked ${n} questions`); break;
      case 'send': parts.push(n === 1 ? 'sent a message' : `sent ${n} messages`); break;
      case 'inbox': parts.push(n === 1 ? 'wrote to your inbox' : `wrote to your inbox ${n}\u00d7`); break;
      default: parts.push(n === 1 ? 'used a tool' : `used ${n} tools`); break;
    }
  }
  const phrase = parts.join(', ');
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** One call of a run, with what became of it (denied: isUserDenied on its result). */
export interface RunCall extends ToolRunMember {
  toolUseId?: string;
  denied?: boolean;
  /** It has its result (or settled): only a call still open can be waiting. */
  done?: boolean;
}

export interface RunSegment {
  kind: 'ran' | 'denied' | 'waiting' | 'queued';
  text: string;
}

/**
 * The collapsed line by outcome: what ran, then what was denied, then what still
 * waits for an answer ("Ran a command, denied a command"). A denied or held call
 * never counts as one that ran. `waiting` is the toolUseIds an open prompt holds;
 * while one of them waits, the CLI runs nothing else, so a call queued beside it
 * (the agent sent both at once) waits too.
 */
export function runSegments(calls: readonly RunCall[], waiting: ReadonlySet<string>): RunSegment[] {
  const asked = (c: RunCall) => !c.denied && !!c.toolUseId && waiting.has(c.toolUseId);
  const blocked = calls.some(asked);
  const queued = (c: RunCall) => !asked(c) && blocked && !c.denied && c.done === false;
  const held = (c: RunCall) => asked(c) || queued(c);
  const ran = calls.filter((c) => !c.denied && !held(c));
  const denied = calls.filter((c) => c.denied);
  const waitingCount = calls.filter(asked).length;
  const queuedCount = calls.filter(queued).length;
  const segments: RunSegment[] = [];
  if (ran.length) segments.push({ kind: 'ran', text: toolRunPhrase(ran) });
  if (denied.length) {
    const cats = new Set(denied.map((c) => toolPhraseCategory(c.name)));
    const n = denied.length;
    const what = cats.size === 1 && cats.has('command') ? (n === 1 ? 'a command' : `${n} commands`)
      : cats.size === 1 && cats.has('ask') ? (n === 1 ? 'a question' : `${n} questions`)
        : (n === 1 ? 'a tool call' : `${n} tool calls`);
    segments.push({ kind: 'denied', text: `${cats.size === 1 && cats.has('ask') ? 'dismissed' : 'denied'} ${what}` });
  }
  // A question waits for an answer, not an approval.
  const what = calls.filter(asked).every((c) => toolPhraseCategory(c.name) === 'ask') ? 'waiting for your answer' : 'waiting for approval';
  if (waitingCount) segments.push({ kind: 'waiting', text: waitingCount === 1 ? what : `${waitingCount} ${what}` });
  // Sent beside it: not asked yet, it runs (or asks) once the open prompt is answered.
  if (queuedCount) segments.push({ kind: 'queued', text: `${queuedCount} queued` });
  if (segments.length) segments[0] = { ...segments[0], text: segments[0].text.charAt(0).toUpperCase() + segments[0].text.slice(1) };
  return segments;
}
