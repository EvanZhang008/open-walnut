/**
 * Which agent actions move the agent's cursor in the page (page-cursor.ts), and why the others do
 * not. Every action an agent can call is in exactly one of the two lists:
 * tests/core/browser-control/extension-agent-cursor.test.ts reads the action sets and switch cases
 * of agent.ts, page-ops.ts, agent-page.ts and agent-trusted.ts and fails on one in neither, so a
 * new action that points at something is drawn before it ships.
 */

/** Actions that act at a point or on an element: the cursor goes there first (`click` adds the ripple). */
export const CURSOR_ACTS: Record<string, 'click' | 'move' | 'drag'> = {
  click: 'click',
  hover: 'move',
  /** At a point it is a click there first; into a field (ref, or the focused one), a move to it. */
  type: 'click',
  select: 'move',
  /** When it names an element or a point (a scroll of the whole page has no point). */
  scroll: 'move',
  /** The file field, when it is on screen (a page often hides its file input). */
  upload: 'move',
  /** To where it starts, then along to where it ends while the debugger drags. */
  drag: 'drag',
  /** The page side of a drag: the cursor goes to where it starts. */
  drag_points: 'drag',
  /** The page side of real input (agent-trusted.ts asks it with `cursor`): the point the debugger is about to use. */
  locate: 'move',
}

/** Actions with no point of their own on the page, each with why. */
export const NO_CURSOR: Record<string, string> = {
  press: 'keys go to the element that has the focus; no pointer moves',
  fill_form: 'sets several fields at once by their refs, as autofill does; no pointer moves',
  fill_login: 'Walnut fills the login the way the person\'s own autofill does; no pointer moves',
  fill_code: 'fills a one-time code as autofill does; no pointer moves',
  snapshot: 'reads the page', text: 'reads the page', find: 'reads the page', form_values: 'reads the page',
  has_text: 'reads the page', wait: 'waits for the page', annotate: 'numbers what is on screen for a screenshot',
  capture: 'a step of a full screenshot', cancel_input: 'stops typing a dialog cut short', probe_read: 'reads whether real input reached the page',
  screenshot: 'takes a picture (the cursor is hidden for it)', zoom: 'crops a picture',
  evaluate: 'runs a script; no pointer', dialog: 'answers the browser\'s own dialog, outside the page',
  tabs: 'lists tabs', take: 'takes a tab', open: 'opens a tab', close: 'closes or gives back a tab', resize: 'sizes the window',
  navigate: 'loads an address', back: 'goes back a page', downloads: 'lists downloads',
  network: 'reads recorded requests', network_body: 'reads recorded requests', network_request_body: 'reads recorded requests', console: 'reads the console',
}
