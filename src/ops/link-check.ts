/**
 * link_check: which code reviews, tickets, pull requests or commits a text for the user names with
 * no link to open them (src/lib/missing-links.ts). A session may call it on a draft; Walnut's own
 * PreToolUse hook on AskUserQuestion (providers/ask-links-hook.ts) pipes the hook's input to it and
 * prints the note it answers as the hook's additionalContext. It runs in the caller's own process
 * and reads nothing from the server.
 */
import { z } from 'zod'
import { defineOp } from './registry.js'
import { ASK_LINKS_FIX, ASK_LINKS_WHAT, askUserQuestionText, findMissingLinks, missingLinksNote } from '../lib/missing-links.js'

defineOp({
  name: 'link_check',
  title: 'Check a text for the user for ids with no link',
  description: 'Read-only, runs locally. Lists the code reviews (CR-...), tickets, pull requests and commits that text '
    + 'written for the user names with no full URL to open them, and the note saying what to add. The user asked that '
    + 'everything a thread, letter or question names is a link they can click.',
  input: {
    text: z.string().max(200000).optional().describe('The text to check (Markdown or HTML)'),
    hook_input: z.record(z.string(), z.unknown()).optional().describe('Set by Walnut\'s AskUserQuestion hook: the hook\'s own input; the answer is then the hook\'s output'),
  },
  handler: async (args) => {
    if (args.hook_input) {
      if (process.env.WALNUT_LINK_NOTE === '0') return {}
      const hook = args.hook_input as { tool_name?: unknown; tool_input?: unknown }
      if (hook.tool_name !== 'AskUserQuestion') return {}
      const note = missingLinksNote(findMissingLinks(askUserQuestionText(hook.tool_input)), ASK_LINKS_WHAT, ASK_LINKS_FIX)
      return note ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } } : {}
    }
    const missing = findMissingLinks(String(args.text ?? ''))
    return { missing, note: missingLinksNote(missing, 'This text', 'Add them before it goes to the user.') }
  },
  tags: { readonly: true, remote: 'allow' },
})
