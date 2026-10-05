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
    default: return 'other';
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

export interface ToolRunMember {
  name: string;
  input?: Record<string, unknown>;
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
      default: parts.push(n === 1 ? 'used a tool' : `used ${n} tools`); break;
    }
  }
  const phrase = parts.join(', ');
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
