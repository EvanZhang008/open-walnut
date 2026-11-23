/**
 * reply_language_check: whether a text for the user is in the language his Reply language setting
 * names (lib/reply-language.ts). A session may call it on a draft. Walnut's own PreToolUse hook on
 * AskUserQuestion (providers/reply-language-hook.ts) pipes the hook's input to it: a question in
 * another language is denied, with the reason, so the session asks it again in his language before
 * he sees it. The send gate holds the other words for the user the same way (reply-language-gate.ts).
 * Never a Stop hook: a chat reply is never judged (tests/core/hints/no-reply-language-reminder.test.ts).
 */
import { z } from 'zod'
import { defineOp } from './registry.js'
import { askUserQuestionText } from '../lib/missing-links.js'
import { gateRefusal, measureScript, readsOffScript } from '../lib/reply-language.js'
import { GATE_SETTING_PATH, gateSettingOf } from './reply-language-gate.js'

export const ASK_WHAT = 'Your question to the user (AskUserQuestion)'

defineOp({
  name: 'reply_language_check',
  title: 'Check that a text for the user is in his reply language',
  description: 'Read-only. Says whether a text you mean for the user is in the language his Reply language setting '
    + 'names, counting prose only (code, commands, paths, identifiers and quoted words do not count). While the '
    + 'reply_language_gate experiment is on, Walnut does not send words for him that fail it (a message to another '
    + 'task, a thread, a letter, the Board, the Brief, a report, an AskUserQuestion prompt).',
  input: {
    text: z.string().max(200000).optional().describe('The text to check (Markdown or HTML)'),
    hook_input: z.record(z.string(), z.unknown()).optional().describe('Set by Walnut\'s AskUserQuestion hook: the hook\'s own input; the answer is then the hook\'s output'),
  },
  handler: async (args, call) => {
    const hook = args.hook_input as { tool_name?: unknown; tool_input?: unknown } | undefined
    if (hook && hook.tool_name !== 'AskUserQuestion') return {}
    const text = hook ? askUserQuestionText(hook.tool_input) : String(args.text ?? '')
    const setting = gateSettingOf(await call('GET', GATE_SETTING_PATH).catch(() => null))
    const m = setting ? readsOffScript(text, setting.script) : null
    if (hook) {
      return m ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: gateRefusal(ASK_WHAT, setting!.rule, m, 'Ask it again in that language.') } } : {}
    }
    const measure = setting ? measureScript(text, setting.script) : null
    return {
      setting: setting?.rule ?? null, gated: !!setting, passes: !m, ...(measure ? { words: measure.words, in_language: measure.inScript } : {}),
      note: m ? gateRefusal('This text', setting!.rule, m, 'Write it again in that language before you send it.') : null,
    }
  },
  // A hook's call prints what a harness reads as it is.
  answer: { kind: 'content', whole_for: (args) => args.hook_input !== undefined },
  tags: { readonly: true, remote: 'allow' },
})
