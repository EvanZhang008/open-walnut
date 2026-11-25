/**
 * The class guard of the thread card line (src/lib/card-tag.ts; experiment threads_reply_tag): he
 * never sees `<walnut-card .../>` on any surface, with the switch on or off.
 *
 * The class: every reader of a reply's text that handles the tasks line (`<walnut-about>`) or the
 * agent-ack line (`<walnut-turn>`). Each of them must drop the card line too, or a reply that ends
 * with the three lines shows one of them. The members are read from the source, so a NEW reader
 * fails here until it drops the line:
 *   1. every exported reader of the shared text modules is classified: it drops the line itself
 *      (proved by running it), or it is a raw tasks-line reader;
 *   2. every call of a raw tasks-line reader, on the server and in the web client, passes text that
 *      a dropping reader took first, or reads only the ids;
 *   3. every place that takes the tasks line or the agent-ack line out of text with a pattern of
 *      its own (a notice's quote, the Brief) takes the card line out too;
 *   4. the phone's twins (Swift cannot run here): every call of its raw tasks-line reader does the
 *      same as part 2, its own strip runs the card strip before and after the report, and the
 *      shared cases file both sides run holds card cases;
 *   5. every subscriber that reads the turn's last words straight off the turn-end event
 *      (`session:result`) takes the line off before a model, a card, a push or he gets them, or is
 *      listed with why its text needs none.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cardTagLine, hasCardLine, readCardTags, stripCardTags } from '../../src/lib/card-tag.js'
import { hiddenLinesOf, splitInternalLines, stripInternalLines } from '../../src/lib/internal-lines.js'
import { NO_ACTION_TAG, readTurnMarker, stripTurnMarker } from '../../src/lib/turn-end-marker.js'
import { hasWordsBeyondControl, withoutWalnutControl } from '../../src/lib/walnut-control-text.js'
import { parseSessionMessages } from '../../src/core/history-parse.js'
import { shownAcpMessages } from '../../src/providers/acp-journal-projector.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
const walk = (dir: string, ext: RegExp): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
  const p = `${dir}/${e.name}`
  if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p, ext)
  return ext.test(e.name) && !/\.test\.|\.spec\./.test(e.name) ? [p] : []
})
/** Code lines only: a comment explains, it reads nothing. */
const codeLines = (file: string) => read(file).split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))

const FENCE = 'th-0a1b2c3d4e5f'
const WORDS = 'Done: the fence is up.'
const ABOUT = '<walnut-about tasks="abc-123"/>'
/** A reply as a lead ends it: its words, then the three lines, in the orders a session writes them. */
const REPLIES = [
  [WORDS, '', cardTagLine(FENCE)],
  [WORDS, '', cardTagLine(FENCE), ABOUT],
  [WORDS, '', ABOUT, cardTagLine(FENCE)],
  [WORDS, '', cardTagLine(FENCE), cardTagLine('th-1b2c3d4e5f60', 'working'), ABOUT, NO_ACTION_TAG],
  [WORDS, '', NO_ACTION_TAG, cardTagLine(FENCE)],
  [WORDS, '', `<walnut-card thread="${FENCE}" state="needs" ask="Which wood?" options="Larch; Oak" kind="spending" why="twice the budget"/>`],
  // One that cannot be read is still no words of the session's.
  [WORDS, '', `<walnut-card thread="${FENCE}" state="finished">`],
].map((l) => l.join('\n'))

const base = { sessionId: 's-1', cwd: '/w', version: '2.1.0' }
const viaHistory = (t: string) => {
  const jsonl = [
    { type: 'user', uuid: 'u-1', parentUuid: null, timestamp: '2026-11-25T01:00:00.000Z', ...base, message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a-1', parentUuid: 'u-1', timestamp: '2026-11-25T01:00:01.000Z', ...base, message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: t }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n'
  return parseSessionMessages(jsonl).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n')
}

/** The exported readers that give text back for a screen or a person: each drops the card line. */
const DROPS: Record<string, (t: string) => string> = {
  'card-tag.ts stripCardTags': (t) => stripCardTags(t),
  'card-tag.ts readCardTags': (t) => readCardTags(t).text,
  'internal-lines.ts stripInternalLines': (t) => stripInternalLines(t),
  'internal-lines.ts splitInternalLines': (t) => splitInternalLines(t).text,
  'turn-end-marker.ts stripTurnMarker': (t) => stripTurnMarker(t),
  'turn-end-marker.ts readTurnMarker': (t) => readTurnMarker(t).text,
  'walnut-control-text.ts withoutWalnutControl': (t) => withoutWalnutControl(t),
}
/** The raw tasks-line readers: they take only that line off, so what they are given matters (part 2). */
const RAW = ['message-about.ts readAboutTag', 'message-about.ts stripAboutTag']
/** Exported functions of those modules that read no reply text for a screen, and why. */
const NOT_A_READER: Record<string, string> = {
  'card-tag.ts cardTagLine': 'writes the line',
  'card-tag.ts hasCardLine': 'answers yes or no',
  'card-tag.ts cardLinesOf': 'says which lines are card lines, shows none',
  'internal-lines.ts sentenceCount': 'counts sentences of lines already split',
  'internal-lines.ts isThreadStatusLine': 'judges one line',
  'internal-lines.ts isStatusReportLine': 'judges one line',
  'internal-lines.ts hasVersionTag': 'judges one line',
  'internal-lines.ts hiddenLinesOf': 'gives the lines a strip took out, for the developer\'s fold: the card line belongs there',
  'turn-end-marker.ts turnStartsOf': 'reads rows through readTurnMarker',
  'turn-end-marker.ts noActionRows': 'reads rows through readTurnMarker',
  'walnut-control-text.ts hasWordsBeyondControl': 'answers yes or no, through withoutWalnutControl',
  'message-about.ts aboutIds': 'reads a list of ids',
  'message-about.ts outsideFence': 'marks code fences',
  'message-about.ts envelopeFromTask': 'reads an envelope of a user row',
  'message-about.ts sentToTasks': 'reads a tool call',
  'message-about.ts messageAbout': 'reads rows the history parse already stripped (part 2 covers its caller)',
}
const MODULES = ['src/lib/card-tag.ts', 'src/lib/internal-lines.ts', 'src/lib/turn-end-marker.ts', 'src/lib/walnut-control-text.ts', 'src/core/org/message-about.ts']

describe('1. every reader of the shared text modules drops the card line, or is a raw tasks-line reader', () => {
  it('every exported function of those modules is classified', () => {
    const exported = MODULES.flatMap((f) => [...read(f).matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)].map((m) => `${path.basename(f)} ${m[1]}`))
    expect(exported.length).toBeGreaterThan(15)
    expect(exported.sort()).toEqual([...Object.keys(DROPS), ...RAW, ...Object.keys(NOT_A_READER)].sort())
  })

  for (const [name, show] of Object.entries(DROPS)) {
    it.each(REPLIES.map((r, i) => [i, r] as const))(`${name} drops it: reply %i`, (_i, reply) => {
      const out = show(reply)
      expect(out).not.toContain('walnut-card')
      expect(out).toContain(WORDS)
    })
  }

  it('the stored history and an ACP engine\'s rows drop it, and a message that is only card lines is no row', () => {
    for (const reply of REPLIES) {
      expect(viaHistory(reply)).not.toContain('walnut-card')
      expect(shownAcpMessages([{ role: 'assistant', text: reply, timestamp: '2026-11-25T01:00:01.000Z' }])[0].text).not.toContain('walnut-card')
    }
    expect(viaHistory(cardTagLine(FENCE))).toBe('')
    expect(hasCardLine(cardTagLine(FENCE))).toBe(true)
  })

  it('while a reply streams, no step of a card line shows', () => {
    const reply = REPLIES[3]
    for (let n = 1; n <= reply.length; n++) {
      const shown = stripTurnMarker(reply.slice(0, n), true)
      expect(shown, `after ${n} characters`).not.toMatch(/<walnut-c/)
    }
  })

  it('the developer\'s fold still holds the line, and words read for a person never do', () => {
    const reply = REPLIES[0]
    expect(splitInternalLines(reply).hidden).toContain(cardTagLine(FENCE))
    expect(hiddenLinesOf(reply, stripTurnMarker(reply))).toContain(cardTagLine(FENCE))
    expect(hasWordsBeyondControl(cardTagLine(FENCE))).toBe(false)
    expect(hasWordsBeyondControl(reply)).toBe(true)
  })
})

/** What a call of a raw tasks-line reader may pass: text a dropping reader took first. */
const TAKES_IT_FIRST = /\b(?:stripCardTags|stripInternalLines|splitInternalLines|withoutWalnutControl|hasWordsBeyondControl)\(/

describe('2. every call of a raw tasks-line reader is given text with the card line already off', () => {
  /** Calls that read rows the server's history parse already took the line off: file, the call as written, why. */
  const ALREADY_OFF: Array<[string, string, string]> = [
    ['src/core/history-parse.ts', 'const tag = readAboutTag(row.text);', 'row.text is splitInternalLines\' text (the same pass, above)'],
  ]
  const calls = [...walk('src', /\.ts$/), ...walk('web/src', /\.tsx?$/)]
    .filter((f) => f !== 'src/core/org/message-about.ts')
    .flatMap((f) => codeLines(f).filter(([, l]) => /\b(?:readAboutTag|stripAboutTag)\(/.test(l)).map(([n, l]) => ({ file: f, n, line: l.trim() })))

  it('finds the calls', () => {
    expect(calls.length).toBeGreaterThanOrEqual(5)
    expect(new Set(calls.map((c) => c.file))).toContain('src/lib/turn-end-marker.ts')
  })

  it('each one takes the card line off first, reads only the ids, or is listed with why', () => {
    const offenders = calls.filter((c) => {
      if (TAKES_IT_FIRST.test(c.line)) return false
      // The ids alone: no text of the reply leaves the call.
      if (/\breadAboutTag\([^()]*\)\.ids\b/.test(c.line)) return false
      return !ALREADY_OFF.some(([file, line]) => file === c.file && line === c.line)
    })
    expect(offenders.map((c) => `${c.file}:${c.n}: ${c.line}`)).toEqual([])
  })

  it('every listed exception is still in the source, and its text does come stripped', () => {
    for (const [file, line] of ALREADY_OFF) expect(calls.some((c) => c.file === file && c.line === line), `${file}: ${line}`).toBe(true)
    // The history parse: the row's text is the split's, before any tasks line is read.
    const parse = read('src/core/history-parse.ts')
    const split = parse.indexOf('const reply = msg.role === \'assistant\' ? splitInternalLines(text) : null;')
    expect(split).toBeGreaterThan(0)
    expect(parse.indexOf('text: reply ? reply.text : text,')).toBeGreaterThan(split)
    expect(parse.indexOf('const tag = readAboutTag(row.text);')).toBeGreaterThan(split)
  })
})

describe('3. a place with its own pattern for the tasks line or the agent-ack line drops the card line too', () => {
  /** A code line that looks for either line by a pattern: a regex, or a string test, naming it. */
  const BY_PATTERN = /(?:new RegExp\(|\.replace\(|\.includes\(|\.startsWith\(|\.match\(|\.test\(|=\s*\/|\(\s*\/)[^\n]*(?:walnut-about|walnut-turn|ABOUT_TAG_NAME|NO_ACTION_TAG)/
  /** Each such file outside the shared modules: what it does with the line, and its text out when it gives one. */
  const PLACES: Record<string, { how: string; shows?: (t: string) => Promise<string> }> = {
    'src/core/peers/envelope-kit.ts': {
      how: 'a notice quotes a session\'s last message, with patterns inlined (the kit references nothing outside)',
      shows: async (t) => (await import('../../src/core/peers/envelope-kit.js')).createEnvelopeKit().clipNoticeMessage(t)?.text ?? '',
    },
    'src/core/sessions/brief-structure.ts': {
      how: 'the Brief: a chat reply\'s line pasted into it is never the letter\'s',
      shows: async (t) => (await import('../../src/core/sessions/brief-structure.js')).structureBrief(t, 'mt-owner', []).text,
    },
    'src/core/history-parse.ts': { how: 'asks only whether to read the tasks line, off rows already split (part 2)' },
    'src/core/sessions/session-request-notify.ts': { how: 'tells an ack-only turn apart; the words it quotes go through the envelope kit\'s clip' },
  }
  const found = [...walk('src', /\.ts$/), ...walk('web/src', /\.tsx?$/)]
    .filter((f) => !MODULES.includes(f))
    .filter((f) => codeLines(f).some(([, l]) => BY_PATTERN.test(l)))

  it('every such place is known', () => {
    expect(found.sort()).toEqual(Object.keys(PLACES).sort())
  })

  for (const [file, place] of Object.entries(PLACES)) {
    if (!place.shows) continue
    it.each(REPLIES.map((r, i) => [i, r] as const))(`${file} drops it: reply %i`, async (_i, reply) => {
      const out = await place.shows!(reply)
      expect(out).not.toContain('walnut-card')
      expect(out).toContain(WORDS)
    })
  }

  it('the Brief keeps a card line shown in a code block (its own text there) and drops one on a line of its own', async () => {
    const { structureBrief } = await import('../../src/core/sessions/brief-structure.js')
    const line = cardTagLine(FENCE)
    const out = structureBrief(['A card line looks like this:', '```', line, '```', 'and a reply ends with it.', line].join('\n'), 'mt-owner', []).text
    expect(out).toContain(`\`\`\`\n${line}\n\`\`\``)
    expect(out.split(line)).toHaveLength(2)
  })

  it('a notice\'s quote keeps a card line that is not among the last lines: it is the session\'s words there', async () => {
    const { createEnvelopeKit } = await import('../../src/core/peers/envelope-kit.js')
    const quoted = `The line looks like this:\n${cardTagLine(FENCE)}\nand it goes last.`
    expect(createEnvelopeKit().clipNoticeMessage(quoted)?.text).toBe(quoted)
  })
})

describe('4. the phone\'s twins drop the card line the same way', () => {
  const swift = walk('ios-native/Walnut', /\.swift$/)
  const TAKES_IT_FIRST_SWIFT = /\b(?:InternalLines\.strip|CardTagLines\.strip|TimelineTurnMarker\.strip|TimelineTurnMarker\.stripLive)\(/

  it('every call of the raw tasks-line reader passes text the card strip took first', () => {
    const calls = swift.filter((f) => !f.endsWith('/MessageAboutTag.swift'))
      .flatMap((f) => read(f).split('\n').map((l, i) => ({ file: f, n: i + 1, line: l.trim() })).filter((c) => !c.line.startsWith('//') && /\bMessageAboutTag\.(?:read|strip)\(/.test(c.line)))
    expect(calls.length).toBeGreaterThanOrEqual(4)
    expect(calls.filter((c) => !TAKES_IT_FIRST_SWIFT.test(c.line)).map((c) => `${c.file}:${c.n}: ${c.line}`)).toEqual([])
  })

  it('the phone\'s strip of Walnut\'s lines runs the card strip before and after the report, as the server\'s does', () => {
    const src = read('ios-native/Walnut/Timeline/InternalLines.swift')
    expect(src).toContain('CardTagLines.strip(stripReport(CardTagLines.strip(text, streaming: streaming), streaming: streaming), streaming: streaming)')
    expect(read('src/lib/internal-lines.ts')).toContain('return stripCardTags(stripReportLines(stripCardTags(text, streaming), streaming), streaming);')
    // The marker's reader takes the card lines off before it looks for the marker, on both sides.
    expect(read('ios-native/Walnut/Timeline/TimelineTurnShape.swift')).toContain('MessageAboutTag.read(CardTagLines.strip(text)).text')
    expect(read('src/lib/turn-end-marker.ts')).toContain('readAboutTag(stripCardTags(text ?? \'\')).text')
  })

  it('every way the phone shows a reply\'s text goes through that strip', () => {
    const marker = read('ios-native/Walnut/Timeline/TimelineTurnShape.swift')
    expect(marker).toContain('let text = MessageAboutTag.strip(InternalLines.strip(text))')
    expect(marker).toContain('let text = MessageAboutTag.strip(InternalLines.strip(text, streaming: true), streaming: true)')
  })

  it('the phone\'s card pattern is the server\'s', () => {
    const phone = read('ios-native/Walnut/Timeline/CardTagLines.swift')
    const server = read('src/lib/card-tag.ts')
    // The server's `$` on one line is the phone's `\z`.
    expect(server).toContain('const CARD_LINE = /^ {0,3}<walnut-card(?![A-Za-z0-9_-])[^\\n\\r]*>\\s*$/u;')
    expect(phone).toContain('#"^ {0,3}<walnut-card(?![A-Za-z0-9_-])[^\\n\\r]*>\\s*\\z"#')
    expect(server).toContain('const CARD_START = /^<walnut-card(?![A-Za-z0-9_-])/u;')
    expect(phone).toContain('#"^<walnut-card(?![A-Za-z0-9_-])"#')
    expect(server).toContain('const OWN_START = \'<walnut-c\';')
    expect(phone).toContain('private static let ownStart = "<walnut-c"')
    // While it streams, a last line is held only where a card line may start (never one indented as code).
    expect(server).toContain('const CARD_LEAD = /^ {0,3}\\S/u;')
    expect(phone).toContain('private static let cardLead = InternalLines.js(#"^ {0,3}\\S"#)')
    expect(server).toContain('if (!CARD_LEAD.test(last)) return out;')
    expect(phone).toContain('guard InternalLines.test(cardLead, last) else { return out }')
  })

  it('one fence rule tells code from text for the tasks line and the card line, on both sides', () => {
    const phone = read('ios-native/Walnut/Timeline/CardTagLines.swift')
    expect(phone).not.toMatch(/func outsideFence\(/)
    expect(phone.match(/MessageAboutTag\.outsideFence\(/g)).toHaveLength(2)
    expect(read('ios-native/Walnut/Timeline/MessageAboutTag.swift')).toMatch(/\n    static func outsideFence\(/)
    expect(walk('ios-native/Walnut', /\.swift$/).filter((f) => /func outsideFence\(/.test(read(f)))).toEqual(['ios-native/Walnut/Timeline/MessageAboutTag.swift'])
    const server = read('src/lib/card-tag.ts')
    expect(server).toContain('import { outsideFence } from \'../core/org/message-about.js\';')
    expect(server).not.toMatch(/function outsideFence\(/)
  })

  it('the shared cases both sides run hold card cases, streaming ones too', () => {
    const cases = JSON.parse(read('tests/fixtures/internal-lines/cases.json')) as Array<{ label: string; text: string; streaming?: boolean; shown: string; mustShow?: boolean }>
    const card = cases.filter((c) => c.text.includes('<walnut-c'))
    expect(card.length).toBeGreaterThanOrEqual(20)
    expect(card.filter((c) => c.streaming).length).toBeGreaterThanOrEqual(5)
    expect(card.filter((c) => c.mustShow).length).toBeGreaterThanOrEqual(4)
    // A case that hides the line shows none of it; one that must show keeps it whole.
    for (const c of card) if (!c.mustShow && !c.label.includes('code block')) expect(c.shown, c.label).not.toContain('<walnut-c')
    expect(read('ios-native/WalnutTests/InternalLinesTests.swift')).toContain('cases.json')
  })
})

/**
 * Part 5. The turn-end event (`session:result`) carries the turn's last words as the engine gave
 * them, card lines included, and a subscriber reads them straight off it, past every reader of
 * parts 1 to 3 (2026-11-25, the review of this experiment: the title model was handed them whole).
 *
 * A reader is a code line, in a file that names the event, that reads `.result` off anything but a
 * tool row or an op's answer (NOT_THE_TURN), or takes `result` out of the event's typed data. The
 * engines' own files (src/providers, src/session-server) build the event from the engine's result
 * line and read hundreds of other results: there only a read through the typed accessor counts.
 * Each file is listed with how many such lines it has and what becomes of the text: it goes through
 * a reader that drops the line (the file must call it), or it is fine, with why. A new file, or a
 * new read in a listed one, fails until someone looks at where its text goes. Not seen: a read
 * handed on as the whole data object to another file.
 */
const TURN_END = /SESSION_RESULT|['"]session:result['"]/
const TYPED = /eventData<'session:result'>/
/** A tool row's result, an op's or a daemon's answer: never the turn's words. */
const NOT_THE_TURN = /\b(?:t|tb|tool|block|twin|hit|b|reply|resp)\??\.result\b/g
const ENGINE_FILE = /^src\/(?:providers|session-server)\//

function resultReads(file: string): number {
  if (!TURN_END.test(read(file))) return 0
  return codeLines(file).filter(([, l]) => {
    const typed = TYPED.test(l) && (/\.result\b/.test(l) || /\{[^}]*\bresult\b[^}]*\}\s*=/.test(l))
    if (ENGINE_FILE.test(file)) return typed
    return typed || /\.result\b/.test(l.replace(NOT_THE_TURN, ''))
  }).length
}

const ERROR_TEXT = 'reads only an error turn\'s text, to tell what kind of error it is (retry, compact, wait for the endpoint) or to keep it as the error shown: never a reply, so it holds no card line'
const TURN_READERS: Record<string, { lines: number; drops?: string; fine?: string }> = {
  'src/core/push-notification.ts': { lines: 1, drops: 'stripInternalLines' },
  'src/core/session-auto-continue.ts': { lines: 2, fine: ERROR_TEXT },
  'src/core/session-channel/host-resend.ts': { lines: 1, fine: 'hands the turn end to the retriers, which read only an error turn\'s text to tell its kind; nothing shows it' },
  // Two reads: the turn's words handed to the card write (org/reply-card.ts turnEndedWith reads the
  // lines and shows nothing), and the last message a notice quotes, through noticeText.
  'src/core/session-hooks/builtins.ts': { lines: 2, drops: 'noticeText' },
  'src/core/session-hooks/derive/session.ts': {
    lines: 3,
    fine: 'builds the session hooks\' payloads (a tool result, an error, the turn\'s words): a hook gets the words as the engine gave them, the tasks line and the turn marker too, and drops what it shows; the one in the repo that quotes them is builtins.ts above',
  },
  'src/core/sessions/context-full-recovery.ts': { lines: 3, fine: ERROR_TEXT },
  'src/core/sessions/endpoint-wait.ts': { lines: 1, fine: ERROR_TEXT },
  'src/core/sessions/lane-turn.ts': { lines: 2, fine: 'a Personal AI lane\'s answer: a lane is a conversation, not a task, so it keeps no Threads and is never told the line' },
  'src/core/sessions/thread-takeaway.ts': { lines: 2, drops: 'stripInternalLines' },
  'src/core/sessions/thread-title.ts': { lines: 1, drops: 'stripInternalLines' },
  'src/core/subagents/on-host.ts': { lines: 3, fine: 'a light subagent\'s answer, handed back to the agent that ran it as written: a subagent is no task, keeps no Threads and is never told the line' },
  'src/core/triage/runs.ts': { lines: 2, fine: ERROR_TEXT },
  'src/providers/claude-code-session.ts': { lines: 1, fine: ERROR_TEXT },
  'src/web/routes/quick-main-follow.ts': { lines: 2, drops: 'stripInternalLines' },
  'src/web/server.ts': { lines: 1, drops: 'stripInternalLines' },
  'src/web/session-event-sse.ts': { lines: 1, fine: 'a tool result\'s preview (session:tool-result) in a file that also names the turn end' },
}

describe('5. a subscriber that reads the turn\'s last words off the turn-end event drops the card line', () => {
  const found = Object.fromEntries([...walk('src', /\.ts$/), ...walk('web/src', /\.tsx?$/)].map((f) => [f, resultReads(f)] as const).filter(([, n]) => n > 0))

  it('every file that reads them is listed, with as many reads as it has', () => {
    const listed = Object.fromEntries(Object.entries(TURN_READERS).map(([f, r]) => [f, r.lines]))
    expect(found, 'a read of `.result` in a file that hears the turn end: when it is the turn\'s last words and they reach a model, a card, a push or the user, take Walnut\'s lines off first (stripInternalLines); then list the file in TURN_READERS with how').toEqual(listed)
  })

  it('each one calls a reader that drops the line, or says why its text needs none', () => {
    const readers = /^(?:stripInternalLines|stripCardTags|readCardTags|splitInternalLines|noticeText)$/
    for (const [file, row] of Object.entries(TURN_READERS)) {
      expect(!!row.drops !== !!row.fine, file).toBe(true)
      if (!row.drops) { expect(row.fine!.length, file).toBeGreaterThan(40); continue }
      expect(row.drops, file).toMatch(readers)
      expect(read(file), `${file} no longer calls ${row.drops}`).toMatch(new RegExp(`\\b${row.drops}\\(`))
    }
    // noticeText is the notice's quote, which part 3 holds to the card line.
    expect(read('src/core/sessions/session-request-notify.ts')).toMatch(/export (?:async )?function noticeText\(/)
  })

  it('the text each dropping file hands on has no card line: the title model\'s answer, a push, the quick answer', () => {
    const lines = (file: string) => codeLines(file).map(([, l]) => l)
    // The read and the strip are one expression, or the strip is the next thing done to the value read.
    expect(lines('src/core/sessions/thread-title.ts').some((l) => l.includes('answer: stripInternalLines(data.result ?? \'\')'))).toBe(true)
    expect(lines('src/core/sessions/thread-takeaway.ts').filter((l) => /\.result\b/.test(l)).every((l) => l.includes('stripInternalLines(data.result)'))).toBe(true)
    expect(lines('src/core/push-notification.ts').filter((l) => /\.result\b/.test(l)).every((l) => l.includes('stripInternalLines(data.result)'))).toBe(true)
    expect(lines('src/web/server.ts').some((l) => l.includes('stripInternalLines(rawResult)'))).toBe(true)
    expect(lines('src/web/routes/quick-main-follow.ts').some((l) => l.includes('stripInternalLines(text.trim() ? text : result)'))).toBe(true)
    expect(lines('src/core/session-hooks/builtins.ts').some((l) => l.includes('noticeText(lastMessage)'))).toBe(true)
    // Its other read is the card write's own: the words go to the reader of the lines and nowhere else.
    const reads = lines('src/core/session-hooks/builtins.ts').filter((l) => /\bp\.result\b/.test(l))
    expect(reads).toHaveLength(1)
    expect(reads[0]).toContain('m.turnEndedWith({ task: p.task, sessionId: p.sessionId, reply: p.result, ')
  })
})
