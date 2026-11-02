/**
 * Finds a plugin making a Walnut task itself: the guard behind content actions (2026-11-02, the
 * user, on a mail reminder that became a task titled with its subject and the raw mail pasted in:
 * every plugin offers the same two choices, "talk to ceo, and create a new task ... I can put init
 * promot").
 *
 * The class: any call that creates a task from plugin code, whatever it was handed: the server
 * SDK's `walnut.tasks.create`, the `task_create` op through `walnut.ops.call`, a POST to the task
 * routes, the console's `createTask`, and the retired letter-item task intents. A plugin hands the
 * content to `walnut.content` instead (Talk to CEO, New task), and the person writes the task.
 * `walnut-plugin validate` warns on each one it finds; Walnut's own plugins are held to it by
 * tests/core/content-to-task-ratchet.test.ts, with the matcher here, so both read the same rule.
 *
 * A sync adapter's `createTask(task)` (pushing a Walnut task to the remote service) is not a
 * member: it is a method definition or a call on the adapter, never a bare call.
 */

export type ContentTaskKind = 'tasks.create' | 'task_create op' | 'task route POST' | 'createTask' | 'task intent'

export interface ContentTaskCall {
  line: number
  kind: ContentTaskKind
  text: string
}

const RULES: Array<{ kind: ContentTaskKind; re: RegExp }> = [
  { kind: 'tasks.create', re: /\btasks\s*\.\s*create\s*\(/ },
  { kind: 'task_create op', re: /['"`]task_create['"`]/ },
  { kind: 'task route POST', re: /(?:apiPost|post)\s*(?:<[^>]*>)?\s*\(\s*['"`][^'"`]*\/api(?:\/v1)?\/tasks['"`?]/i },
  { kind: 'task route POST', re: /['"`]POST['"`]\s*,\s*['"`][^'"`]*\/api(?:\/v1)?\/tasks['"`?]/ },
  // A bare call: not `adapter.createTask(` (a sync push) and not a definition (`async createTask(`).
  { kind: 'createTask', re: /(?<![.\w])createTask\s*\((?![^)]*\)\s*[:{])/ },
  { kind: 'task intent', re: /['"`](?:create_task|attach_task|find_task)['"`]/ },
]

/** Whole-line and trailing `//` comments, and the lines of a block comment, are not code. */
function codeLines(src: string): string[] {
  let inBlock = false
  return src.split('\n').map((line) => {
    let out = ''
    let i = 0
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i)
        if (end < 0) return out
        inBlock = false
        i = end + 2
        continue
      }
      const block = line.indexOf('/*', i)
      const slash = line.indexOf('//', i)
      if (slash >= 0 && (block < 0 || slash < block) && !/:\s*$/.test(line.slice(0, slash))) {
        return out + line.slice(i, slash)
      }
      if (block < 0) return out + line.slice(i)
      out += line.slice(i, block)
      inBlock = true
      i = block + 2
    }
    return out
  })
}

const DEFINITION = /^\s*(?:async\s+)?createTask\s*\(|^\s*createTask\s*\??\s*\(/

/** Every task-making call in one source file, with its line (1-based). */
export function contentTaskCalls(src: string): ContentTaskCall[] {
  const out: ContentTaskCall[] = []
  codeLines(src).forEach((code, index) => {
    for (const rule of RULES) {
      if (!rule.re.test(code)) continue
      if (rule.kind === 'createTask' && DEFINITION.test(code)) continue
      out.push({ line: index + 1, kind: rule.kind, text: code.trim().slice(0, 160) })
      break
    }
  })
  return out
}

/** The validate warning for one call. */
export function contentTaskWarning(rel: string, call: ContentTaskCall): string {
  return `${rel}:${call.line} makes a Walnut task itself (${call.kind}). Turning an email or a message into a task `
    + 'is Walnut\'s: hand the item to walnut.content.actions(item) (Talk to CEO, New task) or render '
    + 'walnut.ui.views.ContentActions, and the person writes the task. A task that does not come from '
    + 'content (a sync import, a demo) can stay.'
}
