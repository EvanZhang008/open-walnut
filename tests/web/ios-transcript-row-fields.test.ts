/**
 * Every field the phone's transcript read carries reaches the timeline row.
 *
 * 2026-10-30: the server sent each send's tasks (`sentTo`) and the phone's model
 * had the field, but the type the transcript decodes into
 * (`SessionTranscript.Message`) did not, so the names never reached a fold line;
 * the unit tests decoded `ChatMessage` directly and stayed green. A transcript row
 * becomes a `ChatMessage` in two places (`row(from:)`, `assignStableIDs`), and a
 * fold rebuilds rows with `replacingText`. These guards read the fields from the
 * Swift source and fail when a new one is not carried through every copy.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
const MODELS = read('ios-native/Walnut/API/Models.swift')
const STORE = read('ios-native/Walnut/Stores/SessionConversationStore.swift')
const FOLD = read('ios-native/Walnut/Timeline/TimelineTurnFold.swift')
const PROJECTION = read('src/core/session-projection.ts')

/** The text from `start` to the first line that closes at `indent`. */
function block(src: string, start: string, indent: string): string {
  const i = src.indexOf(start)
  expect(i, start).toBeGreaterThanOrEqual(0)
  const end = src.indexOf(`\n${indent}}\n`, i)
  expect(end, start).toBeGreaterThan(i)
  return src.slice(i, end)
}

/** Stored properties declared at `indent` (a computed one has a body on its line). */
function storedProps(body: string, indent: string): string[] {
  const re = new RegExp(`^${indent}(?:let|var) (\\w+):[^{\\n]*$`, 'gm')
  return [...body.matchAll(re)].map((m) => m[1])
}

describe('a transcript field reaches the timeline row', () => {
  const message = block(MODELS, 'struct Message: Codable, Equatable {', '    ')
  const fields = storedProps(message.slice(0, message.indexOf('init(')), '        ')
  // The four the row builds from by name or by mapping.
  const carried = fields.filter((f) => !['role', 'text', 'timestamp', 'kind'].includes(f))

  it('reads the transcript row\'s fields', () => {
    expect(carried).toEqual(expect.arrayContaining(['detail', 'resultPreview', 'sentBy', 'injectedAfter', 'sentTo']))
  })

  for (const fn of ['private static func row(from m: SessionTranscript.Message', 'private static func assignStableIDs(']) {
    it(`${fn.split('(')[0].replace('private static func ', '')} copies every one`, () => {
      const body = block(STORE, fn, '    ')
      const missing = carried.filter((f) => !body.includes(`m.${f}`))
      expect(missing, fn).toEqual([])
    })
  }

  it('a field the server sends and the phone\'s row has is also decoded from the transcript', () => {
    const iface = block(PROJECTION, 'export interface ProjectedTranscriptMessage {', '')
    const sent = [...iface.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1])
    const chat = storedProps(block(MODELS, 'struct ChatMessage: Codable, Identifiable, Equatable {', ''), '    ')
    expect(sent).toContain('sentTo')
    expect(sent.filter((f) => chat.includes(f) && !fields.includes(f))).toEqual([])
  })

  it('every test of "is this row a send" on the phone reads the server\'s answer (sentTo)', () => {
    // 2026-10-30, the iOS gate twice: isOutbound read only the command's head, then
    // isRunMember did, so a send the line counted sat inside "Ran a command".
    const RUN = read('ios-native/Walnut/Timeline/TimelineToolRun.swift')
    for (const [src, fn] of [[FOLD, 'static func isOutbound('], [RUN, 'static func isRunMember(']] as const) {
      expect(block(src, fn, '    '), fn).toContain('sentTo')
    }
  })

  it('an opened send lists the tasks the server named (the drawer reads sentTo)', () => {
    // 2026-10-31, the iOS gate: the chip said "+3" and nothing on the phone named the three.
    const CELLS = read('ios-native/Walnut/Timeline/TimelineComponentCells.swift')
    const ROW = read('ios-native/Walnut/Timeline/TimelineRowModel.swift')
    expect(block(ROW, 'static func tool(row: TimelineRow) -> Self? {', '    ')).toContain('sentTo')
    expect(block(CELLS, 'private var toolBody: some View {', '    ')).toContain('TimelineSentToSection(targets: detail.sentTo)')
  })

  it('the decoder\'s init takes every field', () => {
    const init = message.slice(message.indexOf('init('))
    expect(carried.filter((f) => !init.includes(`self.${f} = ${f}`))).toEqual([])
  })

  it('a fold\'s copy of a row (replacingText) keeps every stored field of ChatMessage', () => {
    const chat = block(MODELS, 'struct ChatMessage: Codable, Identifiable, Equatable {', '')
    const own = storedProps(chat, '    ').filter((f) => f !== 'text')
    expect(own).toEqual(expect.arrayContaining(['id', 'sentTo', 'sentBy']))
    const copy = block(FOLD, 'func replacingText(_ text: String) -> ChatMessage {', '    ')
    const kept = (f: string) => copy.includes(`${f}: ${f}`) || copy.includes(`copy.${f} = ${f}`)
    expect(own.filter((f) => !kept(f))).toEqual([])
  })
})
