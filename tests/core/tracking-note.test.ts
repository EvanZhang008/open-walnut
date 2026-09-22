/**
 * The tracking note's PURE half: where a project's note goes, and what a fresh
 * one says.
 *
 * Two things are graded here because both are contracts other code copies:
 *
 *  1. The path rule. A project name becomes a vault DIRECTORY SEGMENT, so the
 *     fold has to survive the hostile table below — and it must agree with
 *     `projectSafeName` in src/core/sessions/ask-agent.ts, which folds the same
 *     names for the "Ask <agent>" project. When a name cannot be folded into a
 *     usable segment the answer is `null` ("this project has no tracking note"),
 *     never a guessed path: a guess mints a second note beside the real one.
 *
 *  2. The skeleton, byte for byte. It is the format contract the triage agent
 *     edits in place (`## Log` appends anchor on the heading; Workstreams edits
 *     anchor on a row), so a stray blank line or a renamed heading silently
 *     breaks every one of those edits.
 */
import { describe, it, expect } from 'vitest'
import {
  TRACKING_LOG_ANCHOR,
  TRACKING_NOTE_FILENAME,
  TRACKING_SKELETON,
  trackingNotePathFor,
  trackingStamp,
} from '../../src/core/tracking-note.js'

describe('trackingNotePathFor — one note per project, at a path the server owns', () => {
  it.each([
    // [what the name is, the name, the expected path]
    ['an ordinary name', 'Marina', 'Projects/Marina/Tracking.md'],
    ['spaces inside', 'Harbour Lights', 'Projects/Harbour Lights/Tracking.md'],
    ['surrounding whitespace, trimmed', '  Marina  ', 'Projects/Marina/Tracking.md'],
    ['a forward slash, folded to -', 'acme/marina', 'Projects/acme-marina/Tracking.md'],
    ['a backslash, folded to -', 'acme\\marina', 'Projects/acme-marina/Tracking.md'],
    ['both separators', 'a/b\\c', 'Projects/a-b-c/Tracking.md'],
    ['a NUL, folded to -', 'acme\u0000marina', 'Projects/acme-marina/Tracking.md'],
    ['dots collapsed to one', 'v1..2', 'Projects/v1.2/Tracking.md'],
    ['many dots collapsed to one', 'v1.....2', 'Projects/v1.2/Tracking.md'],
    ['a single inner dot, kept', 'v1.2', 'Projects/v1.2/Tracking.md'],
    ['a trailing dot, kept', 'Marina.', 'Projects/Marina./Tracking.md'],
    ['non-Latin, kept verbatim', '\u9879\u76ee\u7b14\u8bb0', 'Projects/\u9879\u76ee\u7b14\u8bb0/Tracking.md'],
    ['an emoji, kept verbatim', 'ship \u{1F680}', 'Projects/ship \u{1F680}/Tracking.md'],
    ['a % that must not be pre-encoded here', '100% done', 'Projects/100% done/Tracking.md'],
  ])('%s: %j', (_what, name, expected) => {
    expect(trackingNotePathFor(name)).toBe(expected)
  })

  it('caps the folded segment at 60 characters, then re-trims', () => {
    // A registry name may be up to 200 chars (MAX_PROJECT_NAME_LENGTH); the
    // SEGMENT is capped at 60 by the shared fold.
    const long = 'm'.repeat(200)
    const path = trackingNotePathFor(long)
    expect(path).toBe(`Projects/${'m'.repeat(60)}/${TRACKING_NOTE_FILENAME}`)

    // The cut can land on a space; the second trim is what keeps a segment from
    // ending in one (a trailing-space directory is a cross-platform trap).
    const cutOnSpace = `${'m'.repeat(59)} tail`
    expect(trackingNotePathFor(cutOnSpace)).toBe(`Projects/${'m'.repeat(59)}/${TRACKING_NOTE_FILENAME}`)
  })

  it.each([
    ['Inbox (the absence of a project)', ''],
    ['whitespace only', '   '],
    ['a tab only', '\t'],
    ['a single dot', '.'],
    ['dot dot', '..'],
    ['dots only', '.....'],
    ['a leading dot (a hidden vault folder)', '.hidden'],
    ['a leading dot after trimming', '  .hidden  '],
    // Folds to `.-.-etc-passwd`: the separators become `-`, so nothing can climb
    // out of Projects/ — but the leading dot is refused on its own merits.
    ['a traversal attempt', '../../etc/passwd'],
    ['a same-directory prefix', './x'],
    ['a newline inside the name', 'marina\nharbour'],
    ['a carriage return inside the name', 'marina\rharbour'],
    ['a DEL character', 'marina\u007f'],
  ])('refuses %s — no note, never a guessed path: %j', (_what, name) => {
    expect(trackingNotePathFor(name)).toBeNull()
  })

  it('never escapes the Projects folder, for any name in the table above', () => {
    const hostile = [
      '../../etc/passwd', '..', '../x', 'a/../../b', './x', 'x/..', '%2e%2e/x', 'a\\..\\b',
    ]
    for (const name of hostile) {
      const path = trackingNotePathFor(name)
      if (path === null) continue
      expect(path.startsWith('Projects/'), `${name} -> ${path}`).toBe(true)
      // Exactly three segments, and no segment that a path normalizer would
      // treat as "go up" or "stay here".
      const segments = path.split('/')
      expect(segments, `${name} -> ${path}`).toHaveLength(3)
      expect(segments.some((s) => s === '..' || s === '.'), `${name} -> ${path}`).toBe(false)
    }
  })

  it('two names that fold to the same segment get the same note (documented collision)', () => {
    // Not a bug to fix by salting the path: the registry's own identity is
    // case-insensitive and its gate already refuses separators, so the only way
    // to reach this is a caller inventing names. Both would ADOPT one note.
    expect(trackingNotePathFor('a/b')).toBe(trackingNotePathFor('a\\b'))
  })
})

describe('trackingStamp — the frontmatter `updated` value', () => {
  it('is UTC with minute precision', () => {
    expect(trackingStamp('2026-09-21T14:10:59.999Z')).toBe('2026-09-21T14:10Z')
  })

  it('normalizes an offset timestamp to UTC (one clock, not the caller\'s)', () => {
    expect(trackingStamp('2026-09-21T07:10:00-07:00')).toBe('2026-09-21T14:10Z')
  })

  it('refuses a value that is not a date rather than stamping "Invalid Date"', () => {
    expect(() => trackingStamp('sometime tuesday')).toThrow(/not a date/)
  })
})

describe('TRACKING_SKELETON — byte for byte', () => {
  const EXPECTED = `---
project: Marina
kind: project-tracking
updated: 2026-09-21T14:10Z
---

## Status

<!-- one sentence on where this stands, then the next milestone -->

## Workstreams

| Item | State | Owner task | Last update | Source |
| --- | --- | --- | --- | --- |
<!-- row format: | <workstream> | <in progress / blocked / done> | [[task:<id>]] | <Mon D> | <mail / slack>: <what changed> | -->

## Open questions

<!-- format: - <the question>? (raised in <where>, <Mon D>, <who owes an answer>) -->

## Log

<!-- format: - <YYYY-MM-DD HH:MM> triage: <what arrived>; <what you did about it> -->
`

  it('is exactly the documented block', () => {
    expect(TRACKING_SKELETON('Marina', '2026-09-21T14:10:00Z')).toBe(EXPECTED)
  })

  it('asserts NOTHING about the project it was just created for', () => {
    const note = TRACKING_SKELETON('Marina', '2026-09-21T14:10:00Z')
    const body = note.replace(/^---\n[\s\S]*?\n---\n/, '')
    // Structural, not keyword-based: EVERY content line of a fresh note is a
    // heading, the empty table's header, or a comment. Nothing else is allowed,
    // so any future edit that puts a row, a question or a log entry back into the
    // skeleton fails here. The old skeleton stated "Design review | in progress"
    // about work that did not exist — the pane showed it as fact.
    const allowed = new Set([
      '| Item | State | Owner task | Last update | Source |',
      '| --- | --- | --- | --- | --- |',
    ])
    for (const line of body.split('\n')) {
      const text = line.trim()
      if (!text) continue
      const isHeading = /^## \S/.test(text)
      const isComment = text.startsWith('<!--') && text.endsWith('-->')
      expect(
        isHeading || isComment || allowed.has(text),
        `a fresh note must state nothing, but it has: ${line}`,
      ).toBe(true)
    }
  })

  it('shares no text between a format comment and the real row it describes', () => {
    // A plausible sample row made the agent's FIRST table edit ambiguous: its
    // anchor matched the comment too, and note_edit refused with "old_str appears
    // 2 times". Templates are `<placeholders>`, so a real row's cells are unique.
    const note = TRACKING_SKELETON('Marina', '2026-09-21T14:10:00Z')
    const realRow = '| Design review | in progress | [[task:ab12cd34]] | Sep 21 | mail: RFC v3 |\n'
    const separator = '| --- | --- | --- | --- | --- |\n'
    const filled = note.replace(separator, separator + realRow)
    for (const anchor of [
      '| Design review | in progress |',
      '| Design review |',
      '| in progress |',
      '[[task:ab12cd34]]',
    ]) {
      expect(filled.split(anchor).length - 1, `anchor "${anchor}" must be unique`).toBe(1)
    }
  })

  it('leaves the Workstreams table with only its header, ready for a real row', () => {
    const lines = TRACKING_SKELETON('Marina', '2026-09-21T14:10:00Z').split('\n')
    const rows = lines.filter((l) => l.startsWith('|'))
    expect(rows).toEqual([
      '| Item | State | Owner task | Last update | Source |',
      '| --- | --- | --- | --- | --- |',
    ])
  })

  it('carries the EXACT project name, not the folded one', () => {
    // The note records which project it belongs to; the fold only picks the path.
    const note = TRACKING_SKELETON('acme/marina', '2026-09-21T14:10:00Z')
    expect(note).toContain('project: acme/marina')
  })

  it.each([
    ['a colon', 'Design: v2'],
    ['a hash', '#launch'],
    ['a leading quote', '"quoted"'],
    ['a name that looks like a number', '2026'],
    ['a name that looks like a boolean', 'true'],
    ['a leading bracket', '[draft]'],
    ['a trailing colon', 'blocked:'],
    ['non-Latin', '\u9879\u76ee\u7b14\u8bb0'],
  ])('keeps the frontmatter parseable for %s', async (_what, project) => {
    // A frontmatter block whose YAML does not parse loses its `id`, and the
    // server then stamps a NEW id on EVERY write — the note grows an id line per
    // save. So the project name must be emitted as a YAML scalar, not glued in.
    const { parseFrontmatter } = await import('../../src/core/parse-frontmatter.js')
    const parsed = parseFrontmatter(TRACKING_SKELETON(project, '2026-09-21T14:10:00Z'))
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.data.project).toBe(project)
    expect(parsed.data.kind).toBe('project-tracking')
  })

  it('holds exactly one `## Log` anchor, so an append can never land twice', () => {
    const note = TRACKING_SKELETON('Marina', '2026-09-21T14:10:00Z')
    expect(note.split(TRACKING_LOG_ANCHOR).length - 1).toBe(1)
  })

  it('appends a Log line under the heading without touching the lines below it', () => {
    const note = TRACKING_SKELETON('Marina', '2026-09-21T14:10:00Z')
    const line = '- 2026-09-22 09:00 triage: nothing new'
    const edited = note.replace(TRACKING_LOG_ANCHOR, `${TRACKING_LOG_ANCHOR}${line}\n`)
    expect(edited).toContain(`## Log\n${line}\n`)
    // Everything the skeleton said is still there, in order: the new line lands
    // above the format comment, and nothing else moved.
    expect(edited.indexOf(line)).toBeLessThan(edited.indexOf('<!-- format: - <YYYY'))
    expect(edited.length).toBe(note.length + line.length + 1)
  })
})
