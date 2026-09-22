/**
 * The project detail pane's `Tracking` section — its states, as rendered markup.
 *
 * The three states acceptance names, plus the one honesty demands:
 *   1. the note is there            → it renders, with `Open in Notes`
 *   2. `tracking_note` set, note DELETED → say so, offer nothing broken
 *   3. no `tracking_note` at all    → NO section (not an empty box)
 *   4. the read FAILED for another reason → say THAT, not "the note is gone".
 *      A failed read is not an empty answer; claiming the note vanished when the
 *      server merely hiccuped is a confident wrong statement about the vault.
 *
 * Renders `ProjectTrackingView` (pure) rather than `ProjectTrackingBlock`: the
 * block's renderer (`@/utils/markdown`) needs a DOM for DOMPurify, which this
 * node-env tier has none of. Two consequences, both deliberate:
 *   - the `sanitizedHtml` the view gets here is a stand-in for what
 *     renderNoteMarkdown() produces, so this file pins LAYOUT and WIRING;
 *   - the real sanitize path and the `[[task:…]]` plain-text rendering are pinned
 *     in the browser, where they actually run
 *     (tests/e2e/browser/project-tracking.spec.ts).
 */
import { describe, expect, it } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import {
  ProjectTrackingView,
  hasTrackingNote,
  type TrackingNoteState,
} from '../../web/src/components/tasks/ProjectTrackingView'

const NOTE_PATH = 'Projects/Marina/Tracking.md'

/**
 * What renderNoteMarkdown() gives back for a tracking note that HAS been filled
 * in (a real Status line, a real workstream row). Not the fresh skeleton — that
 * one deliberately asserts nothing, so it could not pin the task-ref rendering.
 */
const NOTE_HTML = [
  '<h2>Status</h2>',
  '<p>Waiting on the design review; next milestone is the migration window.</p>',
  '<h2>Workstreams</h2>',
  '<table><thead><tr><th>Item</th><th>State</th><th>Owner task</th></tr></thead>',
  '<tbody><tr><td>Design review</td><td>in progress</td><td>[[task:ab12cd34]]</td></tr></tbody></table>',
].join('')

const render = (state: TrackingNoteState, notePath = NOTE_PATH): string => renderToStaticMarkup(
  createElement(ProjectTrackingView, { notePath, state, onOpenInNotes: () => {} }),
)

describe('state 1 — the note is there', () => {
  const html = render({ status: 'present', sanitizedHtml: NOTE_HTML })

  it('renders the section under its own title', () => {
    expect(html).toContain('project-tracking-section')
    expect(html).toContain('Tracking')
  })

  it('renders the note body with the vault note styling, not a raw dump', () => {
    // The same classes the task detail panes use, so a table/heading/list in a
    // tracking note looks like it does everywhere else in Walnut.
    expect(html).toContain('todo-detail-note markdown-body project-tracking-note')
    expect(html).toContain('<h2>Status</h2>')
    expect(html).toContain('<table>')
    expect(html).toContain('Design review')
  })

  it('offers Open in Notes', () => {
    expect(html).toContain('project-tracking-open')
    expect(html).toContain('Open in Notes')
    // The title names the note, so the human knows where the button lands.
    expect(html).toContain(NOTE_PATH)
  })

  it('passes a task ref through as text — no invented task-link markup', () => {
    // PINNED CHOICE: `[[task:…]]` stays plain text. The note renderer has no
    // task-ref extension, and adding one only here would make this pane and
    // Obsidian disagree about the same bytes. The real renderer is pinned in the
    // browser spec; what this asserts is that the view adds nothing of its own.
    expect(html).toContain('[[task:ab12cd34]]')
    expect(html).not.toContain('href="/tasks/ab12cd34"')
    expect(html).not.toContain('task-ref')
  })
})

describe('state 2 — the key points at a note that is gone', () => {
  const html = render({ status: 'missing' })

  it('says so, and names the path the project still tracks', () => {
    expect(html).toContain('not in the vault any more')
    expect(html).toContain(NOTE_PATH)
  })

  it('offers nothing broken — no button that would land on a missing note', () => {
    expect(html).not.toContain('Open in Notes')
    expect(html).not.toContain('project-tracking-open')
  })

  it('renders no note body', () => {
    expect(html).not.toContain('markdown-body')
  })
})

describe('state 3 — no tracking_note key: no section at all', () => {
  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('%s means the project has no tracking note: %j', (_what, notePath) => {
    expect(hasTrackingNote(notePath)).toBe(false)
  })

  it('a real path means it has one', () => {
    expect(hasTrackingNote(NOTE_PATH)).toBe(true)
  })
})

describe('state 4 — the read failed (not the same as "gone")', () => {
  const html = render({ status: 'unreadable', message: 'timed out after 15000ms' })

  it('reports the failure and says the note itself is untouched', () => {
    expect(html).toContain('timed out after 15000ms')
    expect(html).toContain('untouched')
    expect(html).toContain(NOTE_PATH)
  })

  it('does not claim the note is gone', () => {
    expect(html).not.toContain('not in the vault any more')
  })
})

describe('state 0 — first read in flight', () => {
  it('names what it is reading instead of flashing an empty box', () => {
    const html = render({ status: 'loading' })
    expect(html).toContain(NOTE_PATH)
    expect(html).not.toContain('markdown-body')
    expect(html).not.toContain('not in the vault any more')
  })
})
