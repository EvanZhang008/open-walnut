/**
 * link_check: which code reviews, tickets or pull requests a text for the user names with
 * no link to open them (src/lib/missing-links.ts). A session may call it on a draft; Walnut's own
 * PreToolUse hook on AskUserQuestion (providers/ask-links-hook.ts) pipes the hook's input to it and
 * prints the note it answers as the hook's additionalContext. It runs in the caller's own process
 * and asks only GitHub, whether a linked commit exists (github-commit-check.ts).
 */
import { z } from 'zod'
import { defineOp } from './registry.js'
import { ASK_LINKS_FIX, ASK_LINKS_WHAT, askUserQuestionText, findMissingLinks, linkNotes, missingLinksNote } from '../lib/missing-links.js'
import { deadCommitLinksNote, findDeadCommitLinks } from '../lib/github-commit-check.js'

defineOp({
  name: 'link_check',
  title: 'Check a text for the user for ids with no link',
  description: 'Read-only, runs locally (it asks GitHub whether a linked commit exists). Lists the code reviews (CR-...), '
    + 'tickets and pull requests that text written for the user names with no full URL to open them, and the GitHub '
    + 'commit links in it that open nothing, with the note saying what to fix. The user asked that everything a thread, '
    + 'letter or question names is a link they can click.',
  input: {
    text: z.string().max(200000).optional().describe('The text to check (Markdown or HTML)'),
    hook_input: z.record(z.string(), z.unknown()).optional().describe('Set by Walnut\'s AskUserQuestion hook: the hook\'s own input; the answer is then the hook\'s output'),
  },
  handler: async (args) => {
    if (args.hook_input) {
      if (process.env.WALNUT_LINK_NOTE === '0') return {}
      const hook = args.hook_input as { tool_name?: unknown; tool_input?: unknown }
      if (hook.tool_name !== 'AskUserQuestion') return {}
      const notes = await linkNotes(askUserQuestionText(hook.tool_input), ASK_LINKS_WHAT, ASK_LINKS_FIX)
      return notes.length ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notes.join(' ') } } : {}
    }
    const text = String(args.text ?? '')
    const missing = findMissingLinks(text)
    const dead = await findDeadCommitLinks(text)
    const fix = 'Fix it before it goes to the user.'
    const notes = [missingLinksNote(missing, 'This text', fix), deadCommitLinksNote(dead, 'This text', fix)].filter(Boolean)
    return { missing, dead_commit_links: dead, note: notes.length ? notes.join(' ') : null }
  },
  tags: { readonly: true, remote: 'allow' },
})
