import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

/**
 * The person's own browser, through the Walnut browser extension (routes/browser-v1.ts). One op
 * with an `action`, so the catalog carries one tool; `walnut browser <action>` is the same in a
 * shell and saves screenshots as files.
 */

const ACTIONS = ['tabs', 'open', 'navigate', 'back', 'close', 'snapshot', 'text', 'click', 'type', 'select', 'press', 'scroll', 'wait', 'screenshot'] as const

function outcomeOf(args: Record<string, unknown>, body: Record<string, unknown>): { outcome: string; next: string } {
  if (body.status === 'needs_ok') {
    return {
      outcome: `Waiting for the person to let agents use ${body.site} (a notification on their Mac and phone).`,
      next: 'Call the same action again (with wait_ms up to 25000 to hold for the answer) until it goes through. Do not ask them in chat as well.',
    }
  }
  const tab = typeof body.tab === 'number' ? ` (tab ${body.tab})` : ''
  switch (args.action) {
    case 'tabs': return { outcome: `${(body.tabs as unknown[] | undefined)?.length ?? 0} tab(s) of this task.`, next: 'Act in one with its tab id, or open a page.' }
    case 'open': case 'navigate': case 'back':
      return { outcome: `At ${body.url ?? '?'}${tab}: ${body.title ?? ''}`, next: 'snapshot to see what is on the page and its element refs.' }
    case 'snapshot': return { outcome: `Page snapshot${tab}.`, next: 'click, type or select an element by its ref (e12); refs hold until the page changes, then snapshot again.' }
    case 'screenshot': return { outcome: body.image ? 'Screenshot taken.' : `Screenshot taken${tab}; the image is not in this result.`, next: 'In a shell, `walnut browser screenshot <file>` saves it as a file to Read.' }
    case 'close': return { outcome: `Closed tab ${args.tab ?? ''}.`, next: 'No further action is required.' }
    default: return { outcome: `Done${tab}${body.url ? ` at ${body.url}` : ''}.`, next: 'snapshot again to see the result.' }
  }
}

defineOp({
  name: 'browser',
  title: 'Use the person\'s browser',
  description:
    'Act in the user\'s own browser (Chrome or Firefox with the Walnut extension, signed in to their sites), in a separate Walnut agent window. '
    + 'You see and act only in tabs your task opened. Actions: tabs; open {url} (a new tab); navigate {tab, url}; back; close; '
    + 'snapshot (the page as text with element refs like e12: role, name, value); text (the page\'s visible text); '
    + 'click {ref} or {x, y}; type {ref, text, clear?, submit?} (ref omitted: the focused field); select {ref, value}; press {key: Enter, Tab, Escape, ArrowDown...}; '
    + 'scroll {direction: up|down, amount?} or {ref}; wait {text} or {ms}; screenshot (in a shell `walnut browser screenshot <file>` saves it to a file to Read). '
    + '`tab` may be left out after you used one. A site agents have not used yet asks the user first: you get status needs_ok, then call the same '
    + 'action again (wait_ms up to 25000 holds for the answer). Refusals: browser_not_connected (the user turns agents on in the extension popup), '
    + 'site_denied, not_your_tab, test_run. Passwords: never type one you read from elsewhere; ask with password_use, and only for a sign-in the task needs. '
    + 'Ask the user before a step that sends, buys or deletes something in their name.',
  input: {
    action: z.enum(ACTIONS).describe('What to do'),
    tab: z.number().int().optional().describe('The tab id (from open or tabs); default the tab you used last'),
    url: z.string().max(4000).optional().describe('open / navigate: the page'),
    ref: z.string().max(40).optional().describe('click / type / select / scroll: an element ref from snapshot (e12)'),
    x: z.number().optional().describe('click: a point in the page (CSS pixels of the viewport), instead of ref'),
    y: z.number().optional(),
    text: z.string().max(20_000).optional().describe('type: the text; wait: text to wait for'),
    clear: z.boolean().optional().describe('type: empty the field first'),
    submit: z.boolean().optional().describe('type: press Enter after'),
    value: z.string().max(500).optional().describe('select: the option\'s value or label'),
    key: z.string().max(40).optional().describe('press: Enter, Tab, Escape, Backspace, ArrowDown, ...'),
    direction: z.enum(['up', 'down']).optional().describe('scroll: which way (default down)'),
    amount: z.number().optional().describe('scroll: screens (default 1)'),
    ms: z.number().int().min(0).max(30_000).optional().describe('wait: how long, when not waiting for text'),
    inline: z.boolean().optional().describe('screenshot: put the image (a data URL) in the result; the shell command uses this'),
    wait_ms: z.number().int().min(0).max(25_000).optional().describe('needs_ok: hold this long for the person\'s answer'),
    device: z.string().max(80).optional().describe('Which browser, when more than one is connected (browser_status names them)'),
  },
  bind: { method: 'POST', path: '/browser/act' },
  timeoutMs: 75_000,
  mapResult: ({ body, args }) => {
    const b = { ...((body ?? {}) as Record<string, unknown>) }
    if (args.action === 'screenshot' && !args.inline) delete b.image
    const { outcome, next } = outcomeOf(args, b)
    return withOutcome(b, outcome, next)
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'browser_status',
  title: 'Browsers agents may use',
  description: 'The user\'s browsers that let agents in now (the Walnut extension with agents turned on), whether a new site asks the user first, and the sites agents may use.',
  input: {},
  bind: { method: 'GET', path: '/browser/status' },
  mapResult: ({ body }) => {
    const b = (body ?? {}) as { browsers?: Array<{ label: string }>; mode?: string; sites?: Array<{ site: string }> }
    const names = (b.browsers ?? []).map((x) => x.label)
    return withOutcome(b as Record<string, unknown>,
      names.length ? `Connected: ${names.join(', ')}. ${b.mode === 'any' ? 'Any site.' : `A new site asks the person; allowed: ${(b.sites ?? []).map((s) => s.site).join(', ') || 'none yet'}.`}` : 'No browser lets agents in now.',
      names.length ? 'browser with action open to start.' : 'Ask the user to turn on "Let Walnut agents use this browser" in the Walnut extension popup, Settings.')
  },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});
