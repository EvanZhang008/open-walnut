/**
 * The words a tool call's card shows on its closed header line in a session's
 * chat: `Bash · Run the tests`, `Read file_path: src/a.ts`, `Edit a.ts`.
 *
 * One source for the cards (web/src/components/sessions: GenericToolCall,
 * BashToolCall, EditDiffView, PlanCard, CollapsedPlanWrite) and the
 * whole-session find (src/core/sessions/session-find.ts), so a find counts in a
 * turn it has not loaded the same words the card will show once it is. A call
 * drawn as something else (a subagent's chip, a message this session sent)
 * counts none.
 */
import { isCardedOp } from '../core/op-cards.js';
import { findOpCalls } from './walnut-op-command.js';

/** The fields of a tool call the header reads. */
export interface HeaderTool {
  name: string;
  input?: unknown;
  childMessages?: unknown;
  agentId?: unknown;
  result?: unknown;
  liveStatus?: unknown;
  planContent?: unknown;
}

type Input = Record<string, unknown>;

const inputOf = (tool: HeaderTool): Input =>
  (tool.input && typeof tool.input === 'object' ? tool.input : {}) as Input;

/** The call's own description (`input.description`), cut to 120 characters. */
export function toolDescription(input: Input): string | null {
  const raw = typeof input.description === 'string' ? input.description.trim() : '';
  return raw ? (raw.length > 120 ? raw.slice(0, 120) + '...' : raw) : null;
}

/** A Bash call's one-line summary: the command's first line, cut to 80 characters. */
export function bashCommandSummary(command: string): string {
  const firstLine = command.split('\n')[0] ?? '';
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
}

/** A generic call's input as `key: value` pairs, each value cut to 60 characters.
 *  Slice before stringify: a multi-100KB value is never serialized whole for 60
 *  characters of it. */
export function genericInputSummary(input: Input): string {
  return Object.entries(input)
    .filter(([k]) => k !== 'description')
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v)?.slice(0, 200) ?? String(v);
      return `${k}: ${val.length > 60 ? val.slice(0, 60) + '...' : val}`;
    })
    .join(', ');
}

/** The questions of an AskUserQuestion call, as its card's header shows them
 *  (web/src/components/sessions/ask-user-question.ts reads the same fields). */
function askQuestions(input: Input): string {
  const qs = Array.isArray(input.questions) ? input.questions as unknown[] : [];
  return qs
    .map((q) => (q && typeof q === 'object' && !Array.isArray(q) ? (q as Input).question : undefined))
    .filter((q): q is string => typeof q === 'string' && q !== '')
    .join(' \u00b7 ');
}

/** A generic card's summary: a question reads as its words, not its JSON. */
export function toolInputSummary(name: string, input: Input): string {
  return name === 'AskUserQuestion' ? askQuestions(input) : genericInputSummary(input);
}

/** The file name an Edit card shows. */
export function editFileName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

/** Simple line diff: finds common prefix and suffix lines, marks the middle as changed. */
export function computeLineDiff(oldStr: string, newStr: string): { type: 'context' | 'removed' | 'added'; text: string }[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: { type: 'context' | 'removed' | 'added'; text: string }[] = [];

  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length
    && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (from the end, not overlapping with prefix)
  let suffixLen = 0;
  while (suffixLen < oldLines.length - prefixLen && suffixLen < newLines.length - prefixLen
    && oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
    suffixLen++;
  }

  // Prefix lines = context
  for (let i = 0; i < prefixLen; i++) {
    result.push({ type: 'context', text: oldLines[i] });
  }

  // Middle: removed from old, added from new
  const oldMiddleEnd = oldLines.length - suffixLen;
  const newMiddleEnd = newLines.length - suffixLen;

  for (let i = prefixLen; i < oldMiddleEnd; i++) {
    result.push({ type: 'removed', text: oldLines[i] });
  }
  for (let i = prefixLen; i < newMiddleEnd; i++) {
    result.push({ type: 'added', text: newLines[i] });
  }

  // Suffix lines = context
  for (let i = oldLines.length - suffixLen; i < oldLines.length; i++) {
    result.push({ type: 'context', text: oldLines[i] });
  }

  return result;
}

/** An Edit card opens on its diff unless the diff is this long (then a "Show
 *  diff" button stands in for it). */
export function editDiffIsLarge(oldString: string, newString: string): boolean {
  return oldString.split('\n').length + newString.split('\n').length > 100;
}

/** Subagent calls drawn as their chip (SessionToolCall's TaskGroup). */
const GROUPED_TOOLS = new Set(['Task', 'Agent']);

/** A call that starts a subagent (the Agent tool, Task in older Claude Code). */
export function isSubagentCall(name: string): boolean {
  return GROUPED_TOOLS.has(name);
}

/** How the session chat draws a saved call (SessionToolCall), as far as its header goes. */
export type ToolCardKind = 'chip' | 'plan' | 'plan-write' | 'edit' | 'bash' | 'generic';

export function toolCardKind(tool: HeaderTool): ToolCardKind {
  const input = inputOf(tool);
  if (GROUPED_TOOLS.has(tool.name) && (tool.childMessages || tool.agentId || tool.result || tool.liveStatus)) return 'chip';
  if (tool.name === 'ExitPlanMode' && (tool.planContent || (typeof input.plan === 'string' && input.plan))) return 'plan';
  if (tool.name === 'Write' && typeof input.file_path === 'string' && input.file_path.includes('.claude/plans/')) return 'plan-write';
  if (tool.name === 'Edit' && typeof input.file_path === 'string'
    && typeof input.old_string === 'string' && typeof input.new_string === 'string') return 'edit';
  if (tool.name === 'Bash' && typeof input.command === 'string') return 'bash';
  return 'generic';
}

/** The one thing a call touched, as its row shows it: the file, the pattern, the address,
 *  the question; a call with none reads its input as `key: value` pairs. */
const TARGET_KEYS = ['file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'path', 'prompt', 'command', 'subject', 'title'] as const;
export function toolTarget(name: string, input: Record<string, unknown> | undefined): string {
  const inp = input ?? {};
  if (name !== 'AskUserQuestion') {
    for (const k of TARGET_KEYS) {
      const v = inp[k];
      if (typeof v === 'string' && v.trim()) {
        const line = v.trim().split('\n')[0]!;
        return line.length > 160 ? `${line.slice(0, 159)}\u2026` : line;
      }
    }
  }
  return toolInputSummary(name, inp);
}

/** A Walnut or other MCP tool's name as a reader reads it on its row: `host_exec` (the server in the hover). */
export function toolDisplayName(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

/** `mcp__<server>__<op>`, as session-outbound.ts reads it. */
const MCP_OP = /^mcp__[^_].*?__([a-z][a-z0-9_]*)$/;

/** True when the chat draws this call as an op card (session-outbound.ts rawCallsOf). */
function isCardedOpCall(name: string, input: Input): boolean {
  const mcp = MCP_OP.exec(name);
  if (mcp) return isCardedOp(mcp[1]!);
  return name === 'Bash' && typeof input.command === 'string' && findOpCalls(input.command, isCardedOp).length > 0;
}

/** The words a card shows before the reader opens anything, separated by
 *  spaces: its header line, and an Edit's short diff ('' for a card drawn as
 *  something else). */
export function toolHeaderText(tool: HeaderTool): string {
  // A subagent call is always a chip in a session's chat (a burst of them is one
  // "N running tasks" chip), never a header line.
  if (GROUPED_TOOLS.has(tool.name)) return '';
  const input = inputOf(tool);
  // A Walnut call that carries words to someone (a send, a thread post) is drawn
  // as its op card (session-outbound.ts), not a tool row.
  if (isCardedOpCall(tool.name, input)) return '';
  const desc = toolDescription(input);
  switch (toolCardKind(tool)) {
    case 'chip':
      return '';
    case 'plan':
      // The plan card opens on the plan itself (markdown: the caller reads it as prose).
      return String(tool.planContent || input.plan || '');
    case 'plan-write':
      return `Wrote plan to ${editFileName(input.file_path as string)}`;
    case 'edit': {
      const head = ['Edit', editFileName(input.file_path as string), input.replace_all === true ? '(replace all)' : ''];
      // A short diff shows without opening anything: its lines are words on screen.
      const oldS = input.old_string as string;
      const newS = input.new_string as string;
      const diff = editDiffIsLarge(oldS, newS) ? [] : computeLineDiff(oldS, newS).map((l) => l.text);
      return [...head, ...diff].filter(Boolean).join(' ');
    }
    case 'bash':
      return ['Bash', desc || bashCommandSummary(input.command as string)].filter(Boolean).join(' ');
    default:
      // The row's own words (SessionMessage.tsx GenericToolCallInner): the short name, what it
      // is for, and what it touched.
      return [toolDisplayName(tool.name), desc ? `· ${desc}` : '', toolTarget(tool.name, input)].filter(Boolean).join(' ');
  }
}
