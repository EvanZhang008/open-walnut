import { z } from 'zod';
import { defineOp } from './registry.js';
import { ANSWER_CEILING_CHARS } from './answer.js';
import { withOutcome } from './outcome.js';
import { noBrowserLine, noBrowserNext, type GoneBrowser } from '../core/browser-control/gone-words.js';

/**
 * The person's own browser, through the Walnut browser extension (routes/browser-v1.ts). One op
 * with an `action`, so the catalog carries one tool; `walnut browser <action>` is the same in a
 * shell and saves screenshots as files.
 */

const ACTIONS = [
  'tabs', 'open', 'navigate', 'back', 'close', 'snapshot', 'text', 'find', 'form_values', 'click', 'hover', 'type', 'fill_form', 'select', 'press',
  'scroll', 'wait', 'screenshot', 'upload', 'downloads', 'take', 'fill_login', 'fill_code', 'dialog', 'evaluate',
  'network', 'network_body', 'network_request_body', 'console', 'resize', 'request_sign_in', 'drag', 'zoom', 'click_label',
] as const

/** A leave (navigate, back, close) the page's "Leave site?" holds up: the agent is still on the page and decides. */
function leaveHeld(body: Record<string, unknown>, tab: string): { outcome: string; next: string } | null {
  const d = body.dialog as { type?: string; message?: string } | undefined
  if (!d || typeof d !== 'object' || d.type !== 'beforeunload') return null
  return {
    outcome: `Not left yet${tab}: the page asks "${String(d.message ?? 'Leave site?')}" (it holds changes not saved: a draft, an upload still going), and stays as it is.`,
    next: 'Decide yourself (never ask the user): dialog {accept: false} stays on the page (then save, send or wait for the upload, and leave again); dialog {accept: true} leaves and loses those changes.',
  }
}

/** A step that opened a page dialog says what it says. */
function dialogLine(body: Record<string, unknown>): string {
  const d = body.dialog as { type?: string; message?: string } | undefined
  return d && typeof d === 'object' ? ` It opened a ${d.type ?? 'dialog'}: "${String(d.message ?? '').slice(0, 300)}".` : ''
}

function outcomeOf(args: Record<string, unknown>, body: Record<string, unknown>): { outcome: string; next: string } {
  if (body.status === 'needs_ok') {
    // browser_reconnecting: Walnut restarted during the wait and the browser has not connected again yet.
    if (body.code === 'outward_needs_ok' || body.code === 'upload_needs_ok' || body.code === 'browser_reconnecting') {
      return {
        outcome: String(body.error ?? 'Waiting for the person to approve this step (a notification on their Mac and phone).'),
        next: `Call ${String(args.action)} again with the same arguments, request "${String(body.request ?? '')}" and wait_ms up to 25000 until it goes through (the ask stays open ${String(body.waitsMinutes ?? 10)} minutes). Do not ask them in chat as well.`,
      }
    }
    if (body.code === 'sign_in_waiting') {
      return {
        outcome: String(body.error ?? 'Waiting for the person to sign in themselves.'),
        next: `Tell the person in one line what to sign in to and that the Browser view of this task has Take over. Then call request_sign_in again with request "${String(body.request ?? '')}" and wait_ms 25000 until it answers done.`,
      }
    }
    if (body.code === 'fresh_sign_in_needs_ok') {
      return {
        outcome: String(body.error ?? 'Waiting for the person to approve a new sign-in.'),
        next: `Call ${args.action === 'fill_code' ? 'fill_code' : 'fill_login'} again with request "${String(body.request ?? '')}" and wait_ms up to 25000 until it goes through. Do not ask them in chat as well.`,
      }
    }
    if (args.action === 'fill_code') {
      return {
        outcome: `Waiting for the person to approve entering the one-time code of "${(body.item as { title?: string } | undefined)?.title ?? 'the login'}" (a notification on their Mac and phone).`,
        next: `Call fill_code again with request "${String(body.request ?? '')}" and wait_ms up to 25000 until it goes through. Do not ask them in chat as well.`,
      }
    }
    if (args.action === 'fill_login') {
      return {
        outcome: `Waiting for the person to approve signing in with "${(body.item as { title?: string } | undefined)?.title ?? 'the login'}" (a notification on their Mac and phone).`,
        next: `Call fill_login again with request "${String(body.request ?? '')}" and wait_ms up to 25000 until it goes through. Do not ask them in chat as well.`,
      }
    }
    return {
      outcome: `Waiting for the person to let agents use ${body.site} (a notification on their Mac and phone).`,
      next: 'Call the same action again (with wait_ms up to 25000 to hold for the answer) until it goes through. Do not ask them in chat as well.',
    }
  }
  const tab = typeof body.tab === 'number' ? ` (tab ${body.tab})` : ''
  const opened = body.opened as { tab?: number; url?: string } | undefined
  const also = opened ? ` It opened tab ${opened.tab} (${opened.url ?? ''}), now yours too.` : ''
  switch (args.action) {
    case 'tabs': return args.all
      ? { outcome: `${(body.tabs as unknown[] | undefined)?.length ?? 0} tab(s) in the browser (owner: mine, other task, person).`, next: 'take {tab} to act in one of the person\'s tabs (never the one they are on), or open a page.' }
      : { outcome: `${(body.tabs as unknown[] | undefined)?.length ?? 0} tab(s) of this task.`, next: 'Act in one with its tab id, or open a page.' }
    case 'open': case 'navigate': case 'back': {
      const held = leaveHeld(body, tab)
      if (held) return held
      const where = typeof body.where === 'string' ? body.where : `At ${body.url ?? '?'}${tab}: ${body.title ?? ''}`
      const theirs = typeof body.person_tabs_note === 'string' ? ` ${body.person_tabs_note}` : ''
      const refused = body.record_refused as { message?: string } | undefined
      const rec = body.recording === true ? ' It records its requests and console from the start (network, console).' : refused ? ` Not recording: ${refused.message ?? 'refused'}` : ''
      return {
        outcome: `${where}${theirs}${rec}`,
        next: theirs ? 'Ask the person for their tab (or take it) before you sign in anywhere; else snapshot to see the page.'
          : readFailed(body) ? `The step was done, but page_text was not read: ${readFailed(body)}`
          : body.page_text ? `${args.action === 'open' ? 'Tell the person in your first line which window and tab you are working in; then r' : 'R'}ead page_text (the main content); snapshot for the element refs to act on.`
          : args.action === 'open' ? 'Tell the person in your first line which window and tab you are working in; then snapshot to see the page and its element refs.'
            : 'snapshot to see what is on the page and its element refs.',
      }
    }
    case 'take': return {
      outcome: `${typeof body.where === 'string' ? `${body.where} ` : ''}You may act in the person's tab ${body.tab} (${body.url ?? ''}); it shows your frame and their Stop button.`,
      next: 'Tell the person which tab you took; snapshot it; close gives it back (it stays open).',
    }
    case 'text': return { outcome: `${String(body.scope ?? 'The page\'s text')}${tab}: ${String(body.chars ?? '?')} characters${body.cut ? ', cut (max reads more, ref or selector one part)' : ''}.`, next: 'click or find what you need next.' }
    case 'snapshot': return { outcome: `Page snapshot${tab}${typeof body.more === 'number' ? `, ${body.more} more element(s) off screen (all: true lists them)` : ''}.`, next: 'click, type or select an element by its ref (e12, or f3:e12 in a frame); refs hold until the page changes, then snapshot again.' }
    case 'find': return { outcome: `${body.count ?? 0} match(es)${tab}${typeof body.by_words === 'string' ? `: nothing had those words together, so these are controls named with "${body.by_words}"` : ''}.`, next: 'Act on a match by its ref.' }
    case 'form_values': return { outcome: `${body.count ?? 0} field(s)${tab}.`, next: 'fill_form {fields: [{ref or label, value}]} to fill several at once.' }
    case 'fill_form': return { outcome: `Filled ${(body.filled as unknown[] | undefined)?.length ?? 0} field(s)${tab}.`, next: 'form_values or snapshot to check, then send the form only if the person asked for that step.' }
    case 'screenshot': {
      const labels = Array.isArray(body.labels) ? ` with ${body.labels.length} numbered element(s) (labels: number, ref, role, name)` : ''
      return {
        outcome: body.image ? `Screenshot taken${labels}${body.cut ? ` (${String(body.note ?? 'cut')})` : ''}.` : `Screenshot taken${labels}${tab}; the image is not in this result.`,
        next: labels ? 'click_label {label} clicks a numbered element (or use its ref). In a shell, `walnut browser screenshot --annotate <file>` saves the picture.' : 'In a shell, `walnut browser screenshot <file>` saves it as a file to Read.',
      }
    }
    case 'zoom': {
      const px = (body.pixels ?? {}) as { width?: number; height?: number }
      return { outcome: `Zoomed in on ${String(px.width ?? '?')}x${String(px.height ?? '?')} pixels of the screen${tab}${body.image ? '' : '; the image is not in this result'}.`, next: 'In a shell, `walnut browser zoom X Y W H <file>` saves it as a file to Read.' }
    }
    case 'drag': return { outcome: `Dragged ${String(body.dragged ?? '')}${body.native ? ' (the page\'s own drag and drop)' : ''}${tab}${typeof body.changed === 'string' ? `: ${body.changed}` : ''}.${dialogLine(body)}`, next: body.dialog ? 'dialog accept or dismiss answers the dialog.' : 'snapshot or screenshot to see the result.' }
    case 'dialog': {
      if (args.read) {
        const d = body.dialog as { type?: string; message?: string; default_prompt?: string } | undefined
        return body.open && d
          ? { outcome: `A ${d.type ?? 'dialog'} is open${tab}: "${d.message ?? ''}"${d.default_prompt !== undefined ? ` (its box holds "${d.default_prompt}")` : ''}.${body.only_person ? ' Walnut can no longer answer it.' : ''}`,
            next: body.only_person ? String(body.note ?? 'Close the tab (close {discard: true}) and open the page again.') : d.type === 'prompt' ? 'dialog {accept: true, text} answers it with your text; accept: false cancels.' : d.type === 'beforeunload' ? 'dialog {accept: false} stays on the page; accept: true leaves it and loses its unsaved changes.' : 'dialog {accept: true} is OK; accept: false is Cancel.' }
          : { outcome: `No dialog open${tab}.${body.walnut_answered ? ' Walnut answered the last one itself the safe way, since nobody answered it in time.' : ''}`, next: String(body.note ?? 'Do the step that opens it with trusted, then read it.') }
      }
      if (body.closed === true) return { outcome: `The dialog was ${String(body.dialog ?? 'answered')}, and tab${tab ? tab.replace(/[()]/g, '') : ''} closed.`, next: 'No further action is required.' }
      if (body.stayed === true) return { outcome: `Stayed on the page${tab}: nothing was lost.`, next: 'Save, send or finish what the page holds (or wait for its upload), then leave again; snapshot to see it.' }
      return { outcome: `The dialog was ${String(body.dialog ?? 'answered')}${tab}${body.left === true && typeof body.url === 'string' ? `; now at ${body.url}` : ''}.`, next: 'snapshot to see the page now.' }
    }
    case 'click': case 'type': case 'press': case 'click_label': case 'select': case 'hover': case 'scroll': {
      if (body.dialog) return { outcome: `Done${tab}.${dialogLine(body)}`, next: 'dialog accept (with text for a prompt) or dialog dismiss answers it; nothing else works on the page until then.' }
      const changed = typeof body.changed === 'string' ? body.changed : undefined
      const where = changed ? `: ${changed}` : body.url ? ` at ${body.url}` : ''
      const why = body.trusted === false && typeof body.why === 'string' ? ` (trusted false: ${body.why})` : ''
      const matched = body.matched ? ` It clicked the best of ${String((body.matched as { of?: number }).of ?? 1)} match(es), ${String((body.matched as { ref?: string }).ref ?? '')}.` : ''
      return {
        outcome: `Done${tab}${where}.${changed?.startsWith('opened') ? '' : also}${matched}${why}`,
        next: changed === 'nothing changed on the page' ? 'Nothing to wait for (no change in its text, fields, scroll or address): snapshot to check before acting again.'
          : changed?.startsWith('Enter changed nothing on the page') ? 'Nothing was submitted: click the search or submit button beside the field (find search), or open the results address.'
          : readFailed(body) ? `The step was done, but page_text was not read: ${readFailed(body)}`
          : body.page_text ? 'Read page_text; act again by ref (snapshot lists them).' : 'snapshot to act on what is there now, or text to read it.',
      }
    }
    case 'upload': return { outcome: `Put ${(body.uploaded as unknown[] | undefined)?.length ?? 0} file(s) into ${body.into ?? 'the field'}${tab}.${typeof body.note === 'string' ? ` ${body.note}` : ''}`, next: 'snapshot to see what the page made of it.' }
    case 'downloads': return body.finished
      ? { outcome: `Finished: ${(body.finished as { filename?: string }).filename ?? '?'}.`, next: 'Read the file at that path if it is on this machine.' }
      : { outcome: `${(body.downloads as unknown[] | undefined)?.length ?? 0} download(s) of this task.`, next: 'downloads with wait to wait for the next one to finish.' }
    case 'fill_login': return { outcome: `Filled ${((body.fields as string[] | undefined) ?? []).join(' and ') || 'the login'} of "${(body.item as { title?: string } | undefined)?.title ?? ''}"${tab}; you never see the password.`, next: 'click the sign-in button (snapshot for its ref).' }
    case 'request_sign_in': return body.done
      ? { outcome: `The person signed in and handed tab ${String(body.tab ?? '')} back${body.url ? ` (now at ${String(body.url)})` : ''}.`, next: 'snapshot to see where the page is now, then go on.' }
      : { outcome: `The person ended the sign-in ask (${String(body.signIn ?? 'ended')}) without handing the tab back.`, next: 'Ask the person in chat what they want; do not act in that tab again unless it is still yours (tabs).' }
    case 'fill_code': return { outcome: `Filled the one-time code of "${(body.item as { title?: string } | undefined)?.title ?? ''}"${tab}; you never see the code.`, next: 'click the verify or continue button (snapshot for its ref).' }
    case 'evaluate': return { outcome: `The script ran${tab}${body.cut ? '; its result was cut at 50 KB' : ''}.`, next: 'No further action is required.' }
    case 'close': {
      const held = leaveHeld(body, tab)
      if (held) return held
      const which = body.tab ?? args.tab
      const n = which !== undefined ? ` ${which}` : ''
      return { outcome: body.released ? `Gave tab${n} back to the person (it stays open).` : `Closed tab${n}.`, next: 'No further action is required.' }
    }
    case 'network': {
      if (body.stopped !== undefined) return { outcome: body.stopped ? `Stopped recording${tab}.` : `Tab${tab} was not recording.`, next: 'No further action is required.' }
      const shown = (body.requests as unknown[] | undefined)?.length ?? 0
      return {
        outcome: `${shown} of ${body.matched ?? shown} matching request(s)${tab}, of ${body.total ?? shown} recorded since ${String(body.since ?? '?')}.${body.started_now ? ` ${String(body.note ?? '')}` : ''}`,
        next: 'network_body {request_id} reads a response; network_request_body {request_id} what a request sent. Filter with url, method, status (404 or 4xx), type (XHR, Fetch, Document).',
      }
    }
    case 'network_body': case 'network_request_body': return {
      outcome: `${args.action === 'network_body' ? 'Response' : 'Request'} body of ${String(body.request_id ?? '')} (${String(body.length ?? 0)} characters${body.base64 ? ', base64' : ''}${body.cut ? ', cut: max_chars reads more, up to 1,000,000' : ''}).`,
      next: 'No further action is required.',
    }
    case 'console': return {
      outcome: `${(body.messages as unknown[] | undefined)?.length ?? 0} console message(s)${tab}, of ${body.total ?? 0} since ${String(body.since ?? '?')}.${body.started_now ? ` ${String(body.note ?? '')}` : ''}`,
      next: 'level: error (or warn, info) for the important ones only.',
    }
    case 'resize': {
      const v = (body.viewport ?? {}) as { width?: number; height?: number }
      return { outcome: `The agent window is ${String(body.width ?? '?')}x${String(body.height ?? '?')}; the page sees ${String(v.width ?? '?')}x${String(v.height ?? '?')}${tab}.`, next: 'screenshot to see the page at that size.' }
    }
    default: return { outcome: `Done${tab}${body.url ? ` at ${body.url}` : ''}.${also}`, next: 'snapshot again to see the result.' }
  }
}

defineOp({
  name: 'browser',
  title: 'Use the person\'s browser',
  description:
    'Act in the user\'s own browser (Chrome or Firefox with the Walnut extension, signed in to their sites), in a separate Walnut agent window. '
    + 'Start here (a read takes 3 to 5 calls): open {url, read_text: true} (the tab and its main text); snapshot (the elements on screen, a ref each: e12); '
    + 'click {ref} or {text: its words} (read_text: true reads the page after); type {ref, text, submit?}; text (the main content without menus, header or footer, 4000 characters; max, ref, selector or all for more); '
    + 'find {text} (the best few matches); wait {text | url | textGone, ms?} (10 s unless ms); close. '
    + 'Every acting step answers `changed` (went to <url>, opened tab N, the page content changed, a field\'s value changed, or nothing changed: then do not wait, snapshot and act again). '
    + 'Subagents may use it too: the same task, tabs and approvals. With two or more tabs every step names its tab (open answers the id); `tab` may be left out after you used one. '
    + 'You act only in tabs your task opened (and the tabs those open), or a tab of the user\'s you take {tab} (never the one they are on: person_is_here). '
    + 'More actions (their arguments are described on each field): tabs, navigate, back, form_values, hover, fill_form, select, press, scroll, screenshot (full, annotate), '
    + 'click_label {label}, zoom {x, y, width, height}, upload, downloads, drag {ref or x, y; to_ref or to_x, to_y; steps?}, dialog, evaluate (a tab you opened; JSON, 50 KB), '
    + 'resize (Walnut\'s agent window only), and with the real input switch network, network_body, network_request_body and console (open {url, record: true} records from the start). '
    + 'Real input (Chrome only, unless the user turned it off: trusted_off) is used by default for click, hover, type and press in your own tab; trusted: false sends the page\'s events. '
    + 'A trusted step that opens an alert, confirm or prompt answers with it: you decide it yourself with dialog {accept, text?}, except an OK that pays (needs_ok). '
    + 'navigate, back and close never lose a page\'s work silently: unsaved_work names it and you stay; discard: true leaves anyway. '
    + 'Every open, take, navigate and back names the window and the tab: say which in your first line to the user when you start using the browser. '
    + 'A site the person already has open in a tab of their own (person_tabs): ask them to hand that tab over, or take it, instead of signing in again. '
    + 'A site agents have not used yet may ask the user first (needs_ok): call the same action again with request (wait_ms up to 25000 holds for the answer). '
    + 'Passwords: sign in with fill_login, then fill_code where a one-time code is asked (you never see either); never type one you read from elsewhere. '
    + 'A sign-in only the person can do (no saved login, a code sent to their phone, a check, a page that refuses this browser: hand_off): request_sign_in {tab, text: what to sign in to}, then call again with request and wait_ms until it answers done. '
    + 'A step that sends a code to the person\'s phone or mail: first say in one line, where they read it, which task, which site and why; never between 22:00 and 08:00 their local time. '
    + 'While the person has a tab (Take over), every action there answers person_driving: work elsewhere or wait. '
    + 'A click, Enter or other key that buys or pays, sends or posts, or deletes (Place order, Pay, Send, Post, Publish, Delete, a form with card details or a message) waits for the user\'s approval: '
    + 'needs_ok with request, call the same action again with it; only the user can approve it. Add to cart, search, sign in, Next, filters and opening pages never ask. '
    + 'Never use evaluate, the page\'s own scripts or a link that acts on a plain visit to take a step the user has not approved. '
    + 'Every refusal says what to do (window_hidden, browser_not_connected, site_denied, not_your_tab, trusted_off: pass its message on as it is). '
    + 'Full rules: docs/reference/browser-control.md ("For agents") in the Walnut repository.',
  input: {
    action: z.enum(ACTIONS).describe('What to do'),
    tab: z.number().int().optional().describe('The tab id (from open or tabs). Needed once the task holds two or more tabs (subagents share them); with one, that one'),
    read_text: z.boolean().optional().describe('open / navigate / back / click / press / type / select / fill_form: also read the page\'s main text (page_text; a new tab the step opened is the one read)'),
    max: z.number().int().min(1).max(100_000).optional().describe('text (or read_text): at most this many characters (default 4000)'),
    url: z.string().max(4000).optional().describe('open / navigate: the page; wait: a substring of the address or /regex/; network: a part of the request\'s address'),
    ref: z.string().max(40).optional().describe('click / hover / type / select / scroll / upload / drag (its start) / text (that element\'s text): an element ref from snapshot or find (e12, f3:e12)'),
    x: z.number().optional().describe('click / hover / type / scroll / drag (its start) / zoom: a point in the page (CSS pixels of the viewport), instead of ref'),
    y: z.number().optional(),
    to_ref: z.string().max(40).optional().describe('drag: the element it ends on'),
    to_x: z.number().optional().describe('drag: the point it ends on, instead of to_ref'),
    to_y: z.number().optional(),
    steps: z.number().int().min(2).max(50).optional().describe('drag: how many moves between the ends (default 12)'),
    label: z.number().int().min(1).max(1000).optional().describe('click_label (or click / hover): a number from screenshot with annotate'),
    annotate: z.boolean().optional().describe('screenshot: number the elements on screen; the answer\'s labels map each number to its ref'),
    all_frames: z.boolean().optional().describe('text: each frame\'s text on its own (frames: [{frame, url, text}], the page first), in place of one text'),
    slowly: z.boolean().optional().describe('type: one key at a time (at most 200 characters), for fields that check each key'),
    read: z.boolean().optional().describe('dialog: read the open alert, confirm or prompt instead of answering it'),
    text: z.string().max(20_000).optional().describe('type: the text; find: the words to find; click / hover: the words of what to click, instead of ref; wait: text to wait for; request_sign_in: one line telling the person what to sign in to'),
    exact: z.boolean().optional().describe('find: the whole text must match'),
    role: z.string().max(40).optional().describe('find: only elements of this role (button, link, textbox, ...)'),
    limit: z.number().int().min(1).max(500).optional().describe('find: at most this many (default 20, at most 100); network: requests (default 50, at most 500); console: messages (default 100)'),
    textGone: z.string().max(2000).optional().describe('wait: until this text is gone from the page'),
    fields: z.array(z.object({ ref: z.string().max(40).optional(), label: z.string().max(200).optional(), value: z.union([z.string().max(20_000), z.boolean()]) })).max(100).optional()
      .describe('fill_form: each field by ref or label, and its value (true/false for a checkbox)'),
    clear: z.boolean().optional().describe('type: empty the field first'),
    submit: z.boolean().optional().describe('type: press Enter after'),
    value: z.string().max(500).optional().describe('select: the option\'s value or label'),
    key: z.string().max(40).optional().describe('press: Enter, Tab, Escape, Backspace, ArrowDown, ... (with trusted: combos like Control+a)'),
    direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('scroll: which way (default down)'),
    amount: z.number().optional().describe('scroll: screens (default 1)'),
    by: z.number().optional().describe('scroll: pixels instead of screens'),
    to: z.enum(['top', 'bottom']).optional().describe('scroll: to the top or bottom of the page'),
    ms: z.number().int().min(0).max(30_000).optional().describe('wait: how long (text, textGone and url wait 10 s unless ms says); downloads: how long to wait'),
    full: z.boolean().optional().describe('screenshot: the whole page, not only what is on screen'),
    format: z.enum(['jpeg', 'png']).optional().describe('screenshot / zoom: the image format (default jpeg)'),
    files: z.array(z.object({ name: z.string().max(255), type: z.string().max(200).optional(), base64: z.string().max(14_000_000) })).max(20).optional()
      .describe('upload: the files, their bytes as base64 (10 MB in all)'),
    paths: z.array(z.string().max(4000)).max(20).optional().describe('upload with trusted: full paths of files on the browser\'s own machine, any size; it goes ahead and is recorded (with approvals on, a file this task did not download waits for the person\'s yes: needs_ok)'),
    all: z.boolean().optional().describe('tabs: every tab of the browser (the user\'s too), title and address only; snapshot / text: the whole page, not only what is on screen or the main content'),
    wait: z.boolean().optional().describe('downloads: wait for the next one to finish'),
    request: z.string().max(100).optional().describe('fill_login, fill_code, request_sign_in, or a click / press / type that waits for the user: the request id from needs_ok, to wait for their answer'),
    site: z.string().max(200).optional().describe('request_sign_in: the site to sign in to (default the tab\'s)'),
    fresh_sign_in: z.boolean().optional().describe('fill_login, fill_code: ask the person to approve a new sign-in here, although they have this site open in a tab of their own (only their yes fills)'),
    trusted: z.boolean().optional().describe('click / hover / type / press / scroll / upload: true asks for real mouse and keys through the browser\'s debugger by name; false for the page\'s events; unset: real input by default for click, hover, type and press in your own tab'),
    accept: z.boolean().optional().describe('dialog: OK (true, default) or Cancel (false); text is a prompt\'s answer; on a "Leave site?" true leaves and false stays'),
    discard: z.boolean().optional().describe('navigate / back / close: leave even though the page holds unsent work or asks "Leave site?" (that work is lost)'),
    item: z.string().max(200).optional().describe('fill_login, fill_code: the login (its id, name or username) when the site has several'),
    purpose: z.string().max(200).optional().describe('fill_login, fill_code: why, in a few words the user reads on the approval'),
    expression: z.string().max(100_000).optional().describe('evaluate: JavaScript to run in the page (its value comes back as JSON)'),
    inline: z.boolean().optional().describe('screenshot / zoom: put the image (a data URL) in the result; the shell command uses this'),
    wait_ms: z.number().int().min(0).max(25_000).optional().describe('needs_ok: hold this long for the person\'s answer'),
    device: z.string().max(80).optional().describe('Which browser, when more than one is connected (browser_status names them)'),
    selector: z.string().max(500).optional().describe('text: the text of the first element it matches; upload: a CSS selector of the file field, for one a page hides (snapshot does not list it)'),
    record: z.boolean().optional().describe('open: record the tab\'s requests and console from before the page loads (real input switch)'),
    stop: z.boolean().optional().describe('network: stop recording this tab'),
    method: z.string().max(40).optional().describe('network: only requests of this method (GET, POST...)'),
    status: z.union([z.number().int(), z.string().max(10)]).optional().describe('network: only this status (404) or class ("4xx")'),
    type: z.string().max(40).optional().describe('network: only this type (XHR, Fetch, Document, Script...)'),
    include_static: z.boolean().optional().describe('network: also images, fonts, media and stylesheets'),
    request_id: z.string().max(100).optional().describe('network_body / network_request_body: the request\'s id from network'),
    max_chars: z.number().int().min(1000).max(1_000_000).optional().describe('network_body / network_request_body: read up to this many characters (default 200,000)'),
    level: z.enum(['debug', 'log', 'info', 'warn', 'error']).optional().describe('console: this level and above'),
    width: z.number().min(1).max(4000).optional().describe('resize: width in pixels (100 to 4000); zoom: the region\'s width in CSS pixels'),
    height: z.number().min(1).max(4000).optional().describe('resize: height in pixels (100 to 4000); zoom: the region\'s height in CSS pixels'),
    viewport: z.boolean().optional().describe('resize: the size is the page\'s, not the window\'s'),
  },
  bind: { method: 'POST', path: '/browser/act' },
  timeoutMs: 75_000,
  // Its answer is what the page showed (a snapshot, its text, a response body): content, up to the ceiling.
  // An inline screenshot is an image the CLI saves to a file: cut, it is a broken file.
  answer: { kind: 'content', max: ANSWER_CEILING_CHARS, whole_for: (args) => args.inline === true },
  mapResult: ({ body, args }) => {
    const b = { ...((body ?? {}) as Record<string, unknown>) }
    if ((args.action === 'screenshot' || args.action === 'zoom') && !args.inline) delete b.image
    const { outcome, next } = outcomeOf(args, b)
    // A page that refuses this browser's sign-in (sign-in-refusal.ts): the person signs in instead.
    const off = b.hand_off as { note?: string } | undefined
    if (off?.note) return withOutcome(b, `${outcome} ${off.note}`, 'request_sign_in on this tab, with text saying what to sign in to.')
    return withOutcome(b, outcome, next)
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'security_alert_check',
  title: 'Check a security alert against recent agent actions',
  description: 'Before asking whether the user signed in, check Walnut\'s recent sanitized browser, fill-login and host-exec actions for the alert\'s domain and exact event time. A unique successful form fill is ours and names its task, not proof the site accepted a sign-in. Unknown or unavailable means the owner or supervisor verifies it, never asks the user to fetch readable evidence. Returns no account, command, URL path, secret or transcript.',
  input: { domain: z.string().min(1).max(253).describe('The registrable domain in the alert'), occurred_at: z.string().describe('Exact ISO event time, not the mail delivery time'), account: z.string().min(1).max(320).optional().describe('The login account named in the alert, compared only as a local salted fingerprint. Without a matching account the result stays unknown.') },
  bind: { method: 'GET', path: '/browser/security-alert', query: ['domain', 'occurred_at', 'account'] },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'browser_status',
  title: 'Browsers agents may use',
  description: 'The user\'s browsers that let agents in now (the Walnut extension with agents turned on), whether a new site asks the user first, and the sites agents may use.',
  input: {},
  bind: { method: 'GET', path: '/browser/status' },
  mapResult: ({ body }) => {
    const b = (body ?? {}) as { browsers?: Array<{ label: string; caps?: string[] }>; mode?: string; sites?: Array<{ site: string }>; gone?: GoneBrowser }
    // A browser whose agents switch is off but where the person handed over a tab from the side panel.
    const names = (b.browsers ?? []).map((x) => (x.caps?.includes('handed-tabs-only') ? `${x.label} (only the tab the person handed over)` : x.label))
    return withOutcome(b as Record<string, unknown>,
      names.length ? `Connected: ${names.join(', ')}. ${b.mode === 'any' ? 'Any site.' : `A new site asks the person; allowed: ${(b.sites ?? []).map((s) => s.site).join(', ') || 'none yet'}.`}` : noBrowserLine(b.gone),
      names.length ? 'browser with action open to start.' : noBrowserNext(b.gone))
  },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

/** Why the page's text read with the step (`read_text`) failed, if it did. */
function readFailed(body: Record<string, unknown>): string | undefined {
  const t = body.page_text as { error?: unknown } | undefined
  return t && typeof t.error === 'string' ? t.error : undefined
}
