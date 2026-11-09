/**
 * Who wrote each part of a Brief (src/core/sessions/brief-source.ts, TaskBrief.text_sources): a
 * path opens on the machine of whoever wrote the words it sits in, never on the owner's current
 * session. The spans follow every write (whole, exact edit) and every reshaping (sections moved,
 * headings normalised, asks Walnut adds).
 */
import { describe, it, expect, vi } from 'vitest'
import { diffChars } from 'diff'

// The real diff, wrapped so one test can make it run out of its budget.
vi.mock('diff', async (importOriginal) => {
  const real = await importOriginal<typeof import('diff')>()
  return { ...real, diffChars: vi.fn(real.diffChars) }
})
import type { Task } from '../../../src/core/types.js'
import { applyBriefEdits, shapeBriefText } from '../../../src/core/sessions/brief-write.js'
import { structureBrief } from '../../../src/core/sessions/brief-structure.js'
import {
  REWRITE_DIFF_TIMEOUT_MS, askLineWriter, briefPathWriters, briefSourcesOf, sharedEnds, sourcesAfterInsertions, sourcesAfterRewrite, spliceBriefEdit,
  type BriefTextSource, type BriefWriter,
} from '../../../src/core/sessions/brief-source.js'
import { validHtmlSources, wholeHtmlSource } from '../../../src/core/boards/board-html-source.js'

const lead = { id: 'lead', title: 'Marina lead', phase: 'WAITING', status: 'in_progress', org_role: 'lead', project: 'Marina' } as Task
const t = (id: string, s: NonNullable<Task['user_status']>, phase = 'WAITING', extra: Partial<Task> = {}): Task =>
  ({ id, title: `T ${id}`, phase, status: phase === 'COMPLETE' ? 'done' : 'in_progress', project: 'Marina', user_status: s, ...extra }) as Task

const REMOTE: BriefWriter = { by: 'task:lead', sessionId: 'sid-remote' }
const OTHER: BriefWriter = { by: 'task:lead', sessionId: 'sid-other' }

/** A whole write by `writer`, shaped as brief-write stores it. */
function writeWhole(text: string, writer: BriefWriter, tasks: Task[]) {
  return shapeBriefText(text, lead, tasks, { sources: wholeHtmlSource(text.length, writer.by, writer.sessionId) }).brief
}

/** Exact edits by `writer` on a stored letter, shaped as brief-write stores it. */
function writeEdits(stored: { text: string; text_sources?: BriefTextSource[] }, edits: { old: string; new: string }[], writer: BriefWriter, tasks: Task[]) {
  let sources = briefSourcesOf(stored)
  const text = applyBriefEdits(stored.text, edits, (at, e, before) => { sources = spliceBriefEdit(sources, at, e.old, e.new, writer, before) })
  return shapeBriefText(text, lead, tasks, { sources }).brief
}

const working = t('b', { state: 'working', now: 'building' }, 'IN_PROGRESS')
const letter = '### Needs you\n- None\n### Working\n- <task-ref id="b" label="B"/>: building, log at /home/me/run/build.log\n### Waiting / snoozed\n- None'

describe('Brief text sources', () => {
  it('a whole write is all its writer\'s, and a path in it names that remote session', () => {
    const brief = writeWhole(letter, REMOTE, [lead, working])
    expect(briefPathWriters(brief.text, brief.text_sources, '/home/me/run/build.log')).toEqual([REMOTE])
    // Every part of the letter is accounted for.
    expect(brief.text_sources!.at(-1)!.end).toBe(brief.text.length)
  })

  it('an exact edit by another session keeps the old path with its writer and gives the new words to the editor', () => {
    const first = writeWhole(letter, REMOTE, [lead, working])
    const edited = writeEdits(first, [{ old: '### Waiting / snoozed\n- None', new: '### Waiting / snoozed\n- <task-ref id="b" label="B"/>: notes in /srv/other/notes.md' }], OTHER, [lead, working])
    expect(briefPathWriters(edited.text, edited.text_sources, '/home/me/run/build.log')).toEqual([REMOTE])
    expect(briefPathWriters(edited.text, edited.text_sources, '/srv/other/notes.md')).toEqual([OTHER])
  })

  it('the same path written by two writers names both, never only the last', () => {
    const first = writeWhole(letter, REMOTE, [lead, working])
    const edited = writeEdits(first, [{ old: 'building, log at', new: 'building (see /home/me/run/build.log again), log at' }], OTHER, [lead, working])
    expect(briefPathWriters(edited.text, edited.text_sources, '/home/me/run/build.log')).toEqual([OTHER, REMOTE])
  })

  it('an ask Walnut adds carries its own task\'s report session, not the owner\'s writer, and keeps it once stored', () => {
    const worker = t('w', { state: 'needs', source: 'session', ask: 'Check /srv/w/out.log', askBy: 'self', askSessionId: 'sid-w' }, 'NEED_ACTION')
    const brief = writeWhole(letter, REMOTE, [lead, working, worker])
    expect(brief.text).toContain('/srv/w/out.log')
    expect(briefPathWriters(brief.text, brief.text_sources, '/srv/w/out.log')).toEqual([{ by: 'task:w', sessionId: 'sid-w' }])
    // Reshaped later while the worker reports from another session: the stored line keeps its writer.
    const later = { ...worker, user_status: { ...worker.user_status!, askSessionId: 'sid-w2' } } as Task
    const again = structureBrief(brief.text, lead.id, [lead, working, later], { live: lead, sources: brief.text_sources })
    expect(again.text).toBe(brief.text)
    expect(briefPathWriters(again.text, again.text_sources, '/srv/w/out.log')).toEqual([{ by: 'task:w', sessionId: 'sid-w' }])
  })

  it('an added ask with no recorded writer is unknown, never the owner', () => {
    const viaLetter = t('l', { state: 'needs', source: 'letter', ask: 'Read /srv/l/report.md' }, 'NEED_ACTION')
    expect(askLineWriter(viaLetter)).toEqual({ by: 'agent' })
    const brief = writeWhole(letter, REMOTE, [lead, working, viaLetter])
    expect(briefPathWriters(brief.text, brief.text_sources, '/srv/l/report.md')).toEqual([{ by: 'agent' }])
  })

  it('an answer to read takes the waiting writer, never the current progress writer', () => {
    const row = t('a', { state: 'read', toRead: 'answer', waitingOn: 'It answered; then waits on /srv/a/log', waitingBy: 'task:lead', waitingSessionId: 'sid-a', reportBy: 'human' }, 'NEED_ACTION')
    expect(askLineWriter(row)).toEqual({ by: 'task:lead', sessionId: 'sid-a' })
    expect(askLineWriter({ ...row, user_status: { ...row.user_status!, waitingBy: undefined, waitingSessionId: undefined } })).toEqual({ by: 'agent' })
    expect(askLineWriter({ ...row, user_status: { ...row.user_status!, waitingBy: 'human', waitingSessionId: undefined } })).toEqual({ by: 'human' })
  })

  it('a turn to read takes the session its quoted last words came from', () => {
    const task = t('r', { state: 'read', toRead: 'turn', waitingOn: 'Its turn ended; its last words: "done, see /srv/r/a.txt"' }, 'NEED_ACTION',
      { last_words: { text: 'done, see /srv/r/a.txt', at: '2026-11-07T00:00:00Z', session_id: 'sid-r' } } as Partial<Task>)
    expect(askLineWriter(task)).toEqual({ by: 'task:r', sessionId: 'sid-r' })
    expect(askLineWriter({ ...task, user_status: { ...task.user_status!, waitingOn: 'A formatted last reply link' } })).toEqual({ by: 'task:r', sessionId: 'sid-r' })
  })

  it('a person\'s write is the primary\'s', () => {
    const brief = writeWhole(letter, { by: 'human' }, [lead, working])
    expect(briefPathWriters(brief.text, brief.text_sources, '/home/me/run/build.log')).toEqual([{ by: 'human' }])
  })

  it('an older letter with no spans, or spans that do not cover it, reads as an unknown writer', () => {
    expect(briefSourcesOf({ text: letter })).toEqual([{ start: 0, end: letter.length, by: 'agent' }])
    expect(briefSourcesOf({ text: letter, text_sources: [{ start: 0, end: 3, by: 'human' }] })).toEqual([{ start: 0, end: letter.length, by: 'agent' }])
    expect(briefPathWriters(letter, briefSourcesOf({ text: letter }), '/home/me/run/build.log')).toEqual([{ by: 'agent' }])
  })

  it('moving a line to its live section and normalising a heading keep each line\'s writer, and the text is as before', () => {
    const asking = t('a', { state: 'needs', source: 'session', ask: 'Approve' }, 'NEED_ACTION')
    const mine = '## In progress\n- <task-ref id="a" label="A"/>: look at /home/me/a/plan.md\n<task-ref id="b" label="B"/>: building'
    const sources = [...wholeHtmlSource(mine.indexOf('<task-ref id="b"'), 'task:lead', 'sid-remote'),
      { start: mine.indexOf('<task-ref id="b"'), end: mine.length, by: 'human' as const }]
    const tasks = [lead, asking, working]
    const plain = structureBrief(mine, lead.id, tasks, { live: lead })
    const shaped = structureBrief(mine, lead.id, tasks, { live: lead, sources })
    expect(shaped.text).toBe(plain.text)
    expect(shaped.text).toMatch(/^### Needs you\n- <task-ref id="a"/)
    expect(briefPathWriters(shaped.text, shaped.text_sources, '/home/me/a/plan.md')).toEqual([REMOTE])
    // The bare line became a list item: its words stay the person's, Walnut's "- " adds no writer.
    const b = shaped.text.indexOf('<task-ref id="b"')
    const at = shaped.text_sources!.find((s) => s.start <= b && b < s.end)!
    expect(at.by).toBe('human')
  })

  it('an edit to the same words is no change, and repeated words around a change keep their writer', () => {
    const spans = wholeHtmlSource(10, 'human')
    expect(spliceBriefEdit(spans, 2, 'abc', 'abc', REMOTE, 'xxabcxxxxx')).toBe(spans)
    expect(sharedEnds('the old line', 'the new line')).toEqual({ prefix: 4, suffix: 5 })
    const out = spliceBriefEdit(wholeHtmlSource(12, 'human'), 0, 'the old line', 'the new line', REMOTE, 'the old line')
    expect(out).toEqual([{ start: 0, end: 4, by: 'human' }, { start: 4, end: 7, ...REMOTE }, { start: 7, end: 12, by: 'human' }])
  })

  it('completing a short ref id keeps every writer', () => {
    const prev = 'A <task-ref id="abcdef"/> /p/x.ts'
    const next = 'A <task-ref id="abcdef123"/> /p/x.ts'
    const spans: BriefTextSource[] = [{ start: 0, end: 2, by: 'human' }, { start: 2, end: prev.length, ...REMOTE }]
    const out = sourcesAfterInsertions(prev, next, spans)!
    expect(briefPathWriters(next, out, '/p/x.ts')).toEqual([REMOTE])
    expect(out[0]).toEqual({ start: 0, end: 2, by: 'human' })
  })

  it('a path counts only where it stands on its own when no block is given', () => {
    const text = 'see /a/b.ts and /x/a/b.ts.bak'
    const spans: BriefTextSource[] = [{ start: 0, end: 12, by: 'human' }, { start: 12, end: text.length, ...REMOTE }]
    expect(briefPathWriters(text, spans, '/a/b.ts')).toEqual([{ by: 'human' }])
    expect(briefPathWriters(text, spans, '/nowhere.ts')).toBeNull()
  })

  it('in a block, an encoded link by A beside a literal copy by B names both, never only the literal B', () => {
    const a = '[log](/a/my%20log.txt)'
    const text = `${a} and /a/my log.txt`
    const spans: BriefTextSource[] = [{ start: 0, end: a.length, ...REMOTE }, { start: a.length, end: text.length, by: 'human' }]
    expect(briefPathWriters(text, spans, '/a/my log.txt', [0, text.length])).toEqual([REMOTE, { by: 'human' }])
  })

  it('a block written by two writers names both, and a block of one writer only that one', () => {
    const text = '- /p/one.ts\n- /p/two.ts'
    const mixed: BriefTextSource[] = [{ start: 0, end: 12, ...REMOTE }, { start: 12, end: text.length, ...OTHER }]
    expect(briefPathWriters(text, mixed, '/p/one.ts', [0, text.length])).toEqual([REMOTE, OTHER])
    expect(briefPathWriters(text, wholeHtmlSource(text.length, REMOTE.by, REMOTE.sessionId), '/p/one.ts', [0, text.length])).toEqual([REMOTE])
  })

  it('a person\'s ask is the primary\'s even with no session recorded', () => {
    expect(askLineWriter(t('h', { state: 'needs', source: 'session', ask: 'Read /p/x.md', askBy: 'human' }, 'NEED_ACTION'))).toEqual({ by: 'human' })
  })
  describe('a whole rewrite keeps the writers of the words it did not change', () => {
    const W: BriefWriter = { by: 'task:w', sessionId: 'sid-w' }
    const prev = 'A /a/one.ts\nB /b/two.ts\nC /c/three.ts'
    const three: BriefTextSource[] = [{ start: 0, end: 12, ...REMOTE }, { start: 12, end: 24, by: 'human' }, { start: 24, end: prev.length, ...OTHER }]

    it('changing the middle line keeps the lines before and after with their own writers', () => {
      const next = prev.replace('/b/two.ts', '/b/zzz.ts')
      const out = sourcesAfterRewrite(prev, next, three, W)
      expect(out).toEqual([
        { start: 0, end: 12, ...REMOTE }, { start: 12, end: 17, by: 'human' }, { start: 17, end: 20, ...W },
        { start: 20, end: 24, by: 'human' }, { start: 24, end: next.length, ...OTHER },
      ])
      expect(briefPathWriters(next, out, '/a/one.ts')).toEqual([REMOTE])
      expect(briefPathWriters(next, out, '/c/three.ts')).toEqual([OTHER])
      expect(sourcesAfterRewrite(prev, prev, three, W)).toEqual(three)
    })

    it('an older letter with no spans keeps its unchanged words unknown, never the new writer', () => {
      const next = prev.replace('/b/two.ts', '/b/zzz.ts')
      const out = sourcesAfterRewrite(prev, next, [], W)
      expect(briefPathWriters(next, out, '/a/one.ts')).toEqual([{ by: 'agent' }])
      expect(briefPathWriters(next, out, '/b/zzz.ts')).toEqual(expect.arrayContaining([W, { by: 'agent' }]))
      expect(sourcesAfterRewrite(prev, next, briefSourcesOf({ text: prev }), W)).toEqual(out)
    })

    it('a replaced emoji is one inserted part, never a split surrogate pair', () => {
      const p = 'x \u{1F600} /p/a.ts'
      const n = 'x \u{1F603} /p/a.ts'
      const out = sourcesAfterRewrite(p, n, wholeHtmlSource(p.length, REMOTE.by, REMOTE.sessionId), W)
      expect(out).toEqual([{ start: 0, end: 2, ...REMOTE }, { start: 2, end: 4, ...W }, { start: 4, end: n.length, ...REMOTE }])
    })

    it('the same path written by two writers keeps both when another line is added', () => {
      const p = '- /p/x.ts\n- /p/x.ts'
      const spans: BriefTextSource[] = [{ start: 0, end: 10, ...REMOTE }, { start: 10, end: p.length, ...OTHER }]
      const n = `${p}\n- /q/new.ts`
      const out = sourcesAfterRewrite(p, n, spans, W)
      expect(briefPathWriters(n, out, '/p/x.ts')).toEqual([REMOTE, OTHER])
      expect(briefPathWriters(n, out, '/q/new.ts')).toEqual([W])
    })

    it('a deletion and an insertion together still cover the new text exactly', () => {
      const p = 'keep /a/a.ts\nXXXX\nkeep /b/b.ts'
      const spans: BriefTextSource[] = [{ start: 0, end: 13, ...REMOTE }, { start: 13, end: 18, by: 'human' }, { start: 18, end: p.length, ...OTHER }]
      const n = 'keep /a/a.ts\nkeep /b/b.ts\nYYYY'
      const out = sourcesAfterRewrite(p, n, spans, W)
      expect(validHtmlSources(out, n.length)).toEqual(out)
      expect(briefPathWriters(n, out, '/a/a.ts')).toEqual([REMOTE])
      expect(briefPathWriters(n, out, '/b/b.ts')).toEqual([OTHER])
      const last = out.at(-1)!
      expect(last).toMatchObject({ end: n.length, ...W })
      expect(last.start).toBeLessThanOrEqual(n.length - 4)
    })

    it('a diff that runs out of its budget makes the whole new text unknown, never the writer', () => {
      const next = prev.replace('/b/two.ts', '/b/zzz.ts')
      vi.mocked(diffChars).mockClear()
      vi.mocked(diffChars).mockReturnValueOnce(undefined as never)
      expect(sourcesAfterRewrite(prev, next, three, W)).toEqual([{ start: 0, end: next.length, by: 'agent' }])
      expect(vi.mocked(diffChars)).toHaveBeenCalledWith(prev, next, { timeout: REWRITE_DIFF_TIMEOUT_MS })
      // The same text never runs the diff.
      vi.mocked(diffChars).mockClear()
      expect(sourcesAfterRewrite(prev, prev, three, W)).toEqual(three)
      expect(vi.mocked(diffChars)).not.toHaveBeenCalled()
    })
  })

  describe('a deletion that joins or cuts a path makes it new text: the editor is among its writers', () => {
    const W: BriefWriter = { by: 'task:w', sessionId: 'sid-w' }
    const A: BriefWriter = { by: 'task:a', sessionId: 'sid-a' }
    const B: BriefWriter = { by: 'task:b', sessionId: 'sid-b' }

    /** Exact edits on `text` with `spans`, as brief-write applies them. */
    function edit(text: string, spans: BriefTextSource[], edits: { old: string; new: string }[], writer: BriefWriter) {
      let sources = spans
      const next = applyBriefEdits(text, edits, (at, e, before) => { sources = spliceBriefEdit(sources, at, e.old, e.new, writer, before) })
      expect(validHtmlSources(sources, next.length)).toEqual(sources)
      return { text: next, sources }
    }

    it('a whole rewrite with several deletions names the editor in each path it cut, and an untouched path keeps its writer', () => {
      const prev = 'see /a/old/x.ts and /b/y/z.ts\n- /keep/k.ts'
      const spans: BriefTextSource[] = [{ start: 0, end: 30, ...A }, { start: 30, end: prev.length, ...B }]
      const next = 'see /a/x.ts and /b/z.ts\n- /keep/k.ts'
      const out = sourcesAfterRewrite(prev, next, spans, W)
      expect(validHtmlSources(out, next.length)).toEqual(out)
      expect(briefPathWriters(next, out, '/a/x.ts')).toEqual(expect.arrayContaining([A, W]))
      expect(briefPathWriters(next, out, '/a/x.ts')).toHaveLength(2)
      expect(briefPathWriters(next, out, '/b/z.ts')).toEqual(expect.arrayContaining([A, W]))
      expect(briefPathWriters(next, out, '/keep/k.ts')).toEqual([B])
      // The words around the paths are not rewritten: only seam characters are the editor's.
      expect(out.filter((s) => s.by === W.by).every((s) => s.end - s.start <= 2)).toBe(true)
    })

    it('an exact edit deleting inside a path, at its head, or at its tail names the editor', () => {
      const text = 'at /a/old/x.ts, /tmp/c/run.log and /d/out.log.bak ok'
      const spans = wholeHtmlSource(text.length, A.by, A.sessionId)
      const mid = edit(text, spans, [{ old: '/a/old/x.ts', new: '/a/x.ts' }], W)
      expect(briefPathWriters(mid.text, mid.sources, '/a/x.ts')).toEqual([A, W])
      const head = edit(text, spans, [{ old: '/tmp/c/run.log', new: '/c/run.log' }], W)
      expect(briefPathWriters(head.text, head.sources, '/c/run.log')).toEqual([W, A])
      const tail = edit(text, spans, [{ old: '/d/out.log.bak', new: '/d/out.log' }], W)
      expect(briefPathWriters(tail.text, tail.sources, '/d/out.log')).toEqual([A, W])
      // The other paths of each letter are untouched.
      expect(briefPathWriters(mid.text, mid.sources, '/tmp/c/run.log')).toEqual([A])
      expect(briefPathWriters(tail.text, tail.sources, '/a/old/x.ts')).toEqual([A])
    })

    it('deleting a whole line takes nothing of the next line, even when the two end alike', () => {
      const prev = '- /a/one.ts\n- /old/x.ts\n- /b/x.ts'
      const spans: BriefTextSource[] = [{ start: 0, end: 12, ...A }, { start: 12, end: 24, ...OTHER }, { start: 24, end: prev.length, ...B }]
      const next = '- /a/one.ts\n- /b/x.ts'
      const want = [{ start: 0, end: 12, ...A }, { start: 12, end: next.length, ...B }]
      expect(sourcesAfterRewrite(prev, next, spans, W)).toEqual(want)
      // The same deletion as an exact edit whose shared ends leave "old/x.ts\n- /" as the cut.
      const exact = edit(prev, spans, [{ old: '\n- /old/x.ts\n- /b', new: '\n- /b' }], W)
      expect(exact.text).toBe(next)
      expect(exact.sources).toEqual(want)
      // Its Markdown block too: the block of the kept line is B's alone.
      expect(briefPathWriters(next, exact.sources, '/b/x.ts', [12, next.length])).toEqual([B])
      expect(edit(prev, spans, [{ old: '- /old/x.ts\n', new: '' }], W).sources).toEqual(want)
    })

    it('UTF-16: the seam is marked by whole code points and no span splits a surrogate pair', () => {
      const prev = 'x /a/\u{1F600}old/x.ts'
      const next = 'x /a/\u{1F600}x.ts'
      const spans = wholeHtmlSource(prev.length, A.by, A.sessionId)
      const out = sourcesAfterRewrite(prev, next, spans, W)
      expect(out).toEqual([{ start: 0, end: 5, ...A }, { start: 5, end: 8, ...W }, { start: 8, end: next.length, ...A }])
      const exact = edit(prev, spans, [{ old: '\u{1F600}old/', new: '\u{1F600}' }], W)
      expect(exact.text).toBe(next)
      expect(exact.sources).toEqual(out)
      // Deleting one emoji of a run of three never cuts between the halves of one.
      const run = '\u{1F600}\u{1F600}\u{1F600} /p.ts'
      const cut = edit(run, wholeHtmlSource(run.length, A.by, A.sessionId), [{ old: '\u{1F600}\u{1F600}\u{1F600}', new: '\u{1F600}\u{1F600}' }], W)
      for (const s of cut.sources) {
        expect(s.start === 0 || !(cut.text.charCodeAt(s.start - 1) >= 0xd800 && cut.text.charCodeAt(s.start - 1) <= 0xdbff)).toBe(true)
      }
      expect(briefPathWriters(cut.text, cut.sources, '/p.ts')).toEqual([A])
    })

    it('a deletion that makes a path with spaces names the editor: body text, a Markdown <link>, an image', () => {
      const cases: Array<[string, string, string, string]> = [
        ['notes at /n/Plan Old\nFinal.md today', 'Old\n', '', '/n/Plan Final.md'],
        ['open </n/My Plan Old Final.md> now', 'Old ', '', '/n/My Plan Final.md'],
        ['open [x](</n/a old /b.txt>) now', 'old ', '', '/n/a /b.txt'],
        [`open [x](</n/a old${String.fromCodePoint(0xa0)}/b.txt>) now`, `old${String.fromCodePoint(0xa0)}`, '', '/n/a /b.txt'],
        [`open [x](</n/a${String.fromCodePoint(0xa0)}old /b.txt>) now`, 'old ', '', `/n/a${String.fromCodePoint(0xa0)}/b.txt`],
        ['see ![shot](/n/My old Pic.png) here', 'old ', '', '/n/My Pic.png'],
      ]
      for (const [text, old, next, path] of cases) {
        const out = edit(text, wholeHtmlSource(text.length, A.by, A.sessionId), [{ old, new: next }], W)
        const writers = briefPathWriters(out.text, out.sources, path)
        expect(writers).toHaveLength(2)
        expect(writers).toEqual(expect.arrayContaining([A, W]))
        // The whole rewrite gives the same answer.
        const whole = sourcesAfterRewrite(text, out.text, wholeHtmlSource(text.length, A.by, A.sessionId), W)
        expect(briefPathWriters(out.text, whole, path)).toEqual(expect.arrayContaining([A, W]))
      }
    })

    it('a spaced path with two spaces, or with a word longer than the read-back limit, still names the editor', () => {
      const cases: Array<[string, string]> = [
        ['/n/Plan  Old\nFinal.md', '/n/Plan  Final.md'],
        [`/n/${'x'.repeat(600)} Old\nFinal.md`, `/n/${'x'.repeat(600)} Final.md`],
      ]
      for (const [head, path] of cases) {
        const prev = `${head}\n- /keep/k.ts`
        const spans: BriefTextSource[] = [{ start: 0, end: head.length + 1, ...A }, { start: head.length + 1, end: prev.length, ...B }]
        const exact = edit(prev, spans, [{ old: 'Old\n', new: '' }], W)
        expect(exact.text).toBe(`${path}\n- /keep/k.ts`)
        const whole = sourcesAfterRewrite(prev, exact.text, spans, W)
        expect(validHtmlSources(whole, exact.text.length)).toEqual(whole)
        for (const out of [exact.sources, whole]) {
          const writers = briefPathWriters(exact.text, out, path)
          expect(writers).toHaveLength(2)
          expect(writers).toEqual(expect.arrayContaining([A, W]))
          // The untouched line below keeps its own writer.
          expect(briefPathWriters(exact.text, out, '/keep/k.ts')).toEqual([B])
        }
      }
    })

    it('a word deleted after a path, before another path, leaves both paths with their writers', () => {
      const prev = 'see /a/x.ts old /b/y.ts'
      const spans: BriefTextSource[] = [{ start: 0, end: 12, ...A }, { start: 12, end: prev.length, ...B }]
      const out = edit(prev, spans, [{ old: 'old ', new: '' }], W)
      expect(out.text).toBe('see /a/x.ts /b/y.ts')
      expect(briefPathWriters(out.text, out.sources, '/a/x.ts')).toEqual([A])
      expect(briefPathWriters(out.text, out.sources, '/b/y.ts')).toEqual([B])
    })

    it('a whole rewrite whose source work runs past its budget is unknown as a whole', () => {
      const prev = 'see /a/old/x.ts\n- /keep/k.ts'
      const next = 'see /a/x.ts\n- /keep/k.ts'
      const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(26).mockReturnValue(26)
      try {
        expect(sourcesAfterRewrite(prev, next, wholeHtmlSource(prev.length, A.by, A.sessionId), W)).toEqual([{ start: 0, end: next.length, by: 'agent' }])
      } finally {
        now.mockRestore()
      }
      // With time to spare the same rewrite keeps its writers.
      expect(briefPathWriters(next, sourcesAfterRewrite(prev, next, wholeHtmlSource(prev.length, A.by, A.sessionId), W), '/keep/k.ts')).toEqual([A])
    })

    it('deleting a whole word between spaces marks nothing, and the same text sent again keeps every source', () => {
      const prev = 'log at old /a/x.ts'
      const spans: BriefTextSource[] = [{ start: 0, end: 11, ...A }, { start: 11, end: prev.length, ...B }]
      const out = edit(prev, spans, [{ old: 'at old ', new: 'at ' }], W)
      expect(out.sources.some((s) => s.by === W.by)).toBe(false)
      expect(briefPathWriters(out.text, out.sources, '/a/x.ts')).toEqual([B])
      expect(sourcesAfterRewrite(prev, prev, spans, W)).toEqual(spans)
    })
  })
})
