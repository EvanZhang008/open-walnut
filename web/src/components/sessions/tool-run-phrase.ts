// The collapsed tool-run line: "Ran 3 commands, read a file ›". Pure, so the
// history row and the streaming row (which must read the same) share it.

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
    const cat = toolPhraseCategory(t.name);
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
