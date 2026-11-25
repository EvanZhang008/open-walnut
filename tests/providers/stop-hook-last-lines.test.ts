/**
 * The Stop hook hands Walnut the shape of the reply's last lines, with its thread card lines whole
 * (src/providers/stop-unanswered-hook.ts LAST_LINES_SCRIPT; experiment threads_reply_tag), so a
 * wrong or missing card line is sent back before the turn ends (core/org/reply-card-stop.ts). The
 * real hook command runs here in /bin/sh against a stub `walnut` that answers with the arguments
 * it got: what the server reads is exactly what this test reads.
 *
 * The shape never carries the reply's words: a line of words is "x", a blank line is empty, a code
 * fence is its mark, and only a card line is kept as written.
 *
 * MACHINE SAFETY: the only files made are this test's own two folders in the temp directory (a stub
 * `walnut` in one, five empty files in the other, both removed at the end); the hook only reads its stdin.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { STOP_UNANSWERED_HOOK_COMMAND } from '../../src/providers/stop-unanswered-hook.js'
import { cardTagLine, readCardTags } from '../../src/lib/card-tag.js'

const FENCE = 'th-0a1b2c3d4e5f'
const SEEDS = 'th-1b2c3d4e5f60'
let root = ''
let tmp = ''

/** Every stub notes each call it gets (one line per call), so a test can count them. */
const NOTE = '#!/bin/sh\necho call >> "$(dirname "$0")/calls"\n'
const BLOCK = 'printf \'{"decision":"block","args":%s}\\n\' "$4"\n'
const ECHO = NOTE + BLOCK
/** A walnut from before the field: it refuses a call that carries last_lines. */
const OLDER = `${NOTE}case "$4" in *last_lines*) echo "Unrecognized key(s) in object: last_lines"; exit 1;; esac\n${BLOCK}`
/** What a call that carries last_lines gets, in place of an answer; without them the block. */
const failing = (answer: string) => `${NOTE}case "$4" in *last_lines*) ${answer};; esac\n${BLOCK}`
/** The request was too large for the server: the failure as `walnut tools call` prints it when stderr is thrown away. */
const TOO_LARGE = failing('echo \'{"ok":false,"error":{"code":"http_431","message":"Walnut API error (431): bad_request"}}\'; exit 1')
/** Nothing to hold the turn for: the empty answer. */
const FREE = `${NOTE}echo '{}'\n`

const calls = () => fs.readFileSync(path.join(root, 'bin', 'calls'), 'utf8').split('\n').filter(Boolean).length
const encoded = (s: string | undefined) => encodeURIComponent(s ?? '').length

function stop(message: string | undefined, opts: { active?: boolean; walnut?: string } = {}): { hook?: string; last_lines?: string; tmp_paths?: string } | null {
  fs.writeFileSync(path.join(root, 'bin', 'walnut'), opts.walnut ?? ECHO, { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'bin', 'calls'), '')
  const input = JSON.stringify({ session_id: 's', transcript_path: '/nonexistent.jsonl', cwd: '/home/u', hook_event_name: 'Stop', stop_hook_active: opts.active ?? false, ...(message === undefined ? {} : { last_assistant_message: message }) })
  const r = spawnSync('/bin/sh', ['-c', STOP_UNANSWERED_HOOK_COMMAND], {
    input, encoding: 'utf8',
    env: { PATH: guardedPath([], `${path.join(root, 'bin')}:/usr/bin:/bin`), HOME: '/home/u', WALNUT_TASK_DIR: '/home/u/task' },
  })
  expect(r.status, r.stderr).toBe(0)
  const out = r.stdout.trim()
  return out ? (JSON.parse(out) as { args: { hook?: string; last_lines?: string } }).args : null
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-reply-tail-'))
  fs.mkdirSync(path.join(root, 'bin'))
  // The hook reads temp paths under /tmp itself, wherever this run's own temp directory is.
  tmp = fs.mkdtempSync('/tmp/walnut-last-lines-')
})
afterAll(() => { for (const dir of [root, tmp]) fs.rmSync(dir, { recursive: true, force: true }) })

describe('the Stop hook sends the shape of the reply\'s last lines', () => {
  it('a card line comes whole, his words and the reply\'s never', () => {
    const line = `<walnut-card thread="${FENCE}" state="answered" summary="Two metres; see /srv/garden/fence.png &quot;as drawn&quot;" title="Orchard fence"/>`
    const args = stop(`The fence is two metres tall, as he asked in "how tall?".\n\nIt keeps the deer out.\n\n${line}`)!
    expect(args.hook).toBe('stop')
    expect(args.last_lines).toBe(`x\n\nx\n\n${line}`)
    expect(readCardTags(args.last_lines).cards).toEqual([{ thread: FENCE, state: 'answered', summary: 'Two metres; see /srv/garden/fence.png "as drawn"', title: 'Orchard fence' }])
  })

  it('several card lines, the tasks line and the agent-ack line after them', () => {
    const args = stop(['Both are done.', '', cardTagLine(FENCE, 'done'), cardTagLine(SEEDS, 'working'), '<walnut-about tasks="abc-123"/>', '<walnut-turn status="agent-ack"/>'].join('\n'))!
    expect(args.last_lines).toBe(`x\n\n${cardTagLine(FENCE, 'done')}\n${cardTagLine(SEEDS, 'working')}\nx\nx`)
    expect(readCardTags(args.last_lines).cards.map((c) => [c.thread, c.state])).toEqual([[FENCE, 'done'], [SEEDS, 'working']])
  })

  it('a reply with no card line still sends its shape, so a missing line is seen', () => {
    expect(stop('The fence is up.\n\nThe gate too.')!.last_lines).toBe('x\n\nx')
  })

  it('values in another script come back as written (escaped)', () => {
    // "The orchard fence is already up", in Chinese.
    const words = '\u679c\u56ed\u7684\u7bf1\u7b06\u5df2\u7ecf\u7acb\u597d'
    const line = `<walnut-card thread="${FENCE}" state="working" summary="${words}"/>`
    const tail = stop(`${words}\u3002\n${line}`)!.last_lines
    expect(tail).toBe(`x\n${line}`)
    expect(readCardTags(tail).cards[0].summary).toBe(words)
  })

  it('Windows line ends and tabs read as they do on the server', () => {
    const tail = stop(`The fence is up.\r\n\t\r\n${cardTagLine(FENCE)}\r\n`)!.last_lines!
    expect(readCardTags(tail).cards).toEqual([{ thread: FENCE, state: 'answered' }])
    expect(tail).not.toContain('fence is up')
  })

  it('a line in a code block stays code: in the last lines, and in a block that opened before them', () => {
    const inBlock = stop(`It looks like this:\n\`\`\`xml\n${cardTagLine(FENCE)}\n\`\`\`\nThat is all.`)!.last_lines!
    expect(inBlock).toBe(`x\n\`\`\`x\n${cardTagLine(FENCE)}\n\`\`\`\nx`)
    expect(readCardTags(inBlock).cards).toEqual([])
    // The block opened 30 lines up: its mark leads the shape, so the server still reads the line as code.
    const long = stop(['Here is the file:', '~~~', ...Array.from({ length: 30 }, (_, i) => `row ${i}`), cardTagLine(FENCE)].join('\n'))!.last_lines!
    expect(long.split('\n')[0]).toBe('~~~')
    expect(readCardTags(long).cards).toEqual([])
    // Closed before the last lines: the line after it counts.
    const closed = stop(['Here is the file:', '```', 'row', '```', ...Array.from({ length: 20 }, (_, i) => `More ${i}.`), cardTagLine(FENCE)].join('\n'))!.last_lines!
    expect(readCardTags(closed).cards).toEqual([{ thread: FENCE, state: 'answered' }])
  })

  it('only the last 16 lines are sent', () => {
    const tail = stop([cardTagLine(SEEDS), ...Array.from({ length: 20 }, (_, i) => `Line ${i}.`), cardTagLine(FENCE)].join('\n'))!.last_lines!
    expect(tail.split('\n')).toHaveLength(16)
    expect(tail).not.toContain(SEEDS)
    expect(readCardTags(tail).cards).toEqual([{ thread: FENCE, state: 'answered' }])
  })

  it('a shape that would be large is not sent at all, and a very long line is only a line of words', () => {
    const big = (id: string) => `<walnut-card thread="${id}" state="working" summary="${'seed '.repeat(240)}"/>`
    expect(stop(['Done.', big(FENCE), big(SEEDS), big('th-2c3d4e5f6071'), big('th-3d4e5f607182')].join('\n'))!.last_lines).toBeUndefined()
    const huge = `<walnut-card thread="${FENCE}" state="working" summary="${'seed '.repeat(400)}"/>`
    expect(stop(`Done.\n${huge}`)!.last_lines).toBe('x\nx')
  })

  it('no final text in the hook input (an older CLI): nothing is sent, so nothing is checked', () => {
    const args = stop(undefined)!
    expect(args.hook).toBe('stop')
    expect(args.last_lines).toBeUndefined()
  })

  it('a walnut that does not know the field yet is asked again without it', () => {
    const args = stop(`The fence is up.\n${cardTagLine(FENCE)}`, { walnut: OLDER })!
    expect(args.hook).toBe('stop')
    expect(args.last_lines).toBeUndefined()
    expect(calls()).toBe(2)
  })
})

describe('the last lines never cost the hook its other checks', () => {
  const reply = `The fence is up.\n${cardTagLine(FENCE)}`
  // "Fruit", 230 times: a summary in a script whose every character is nine bytes of a request.
  const long = (id: string) => `<walnut-card thread="${id}" state="working" summary="${'\u679c'.repeat(230)}"/>`
  const ids = [FENCE, SEEDS, 'th-2c3d4e5f6071', 'th-3d4e5f607182', 'th-4e5f60718293']

  it('the cap is on what the request weighs once encoded, not on the bytes of the shape', () => {
    // Three such lines weigh about 6.6 KB in a request: sent, whole.
    const three = stop(['Done.', ...ids.slice(0, 3).map(long)].join('\n'))!.last_lines!
    expect(readCardTags(three).cards).toHaveLength(3)
    expect(encoded(three)).toBeLessThanOrEqual(9000)
    // Five are under 4,000 bytes as text and about 11 KB in a request, which with the rest of it
    // is past what a server takes in one request line (16 KB): not sent, so nothing is checked.
    const five = ['Done.', ...ids.map(long)].join('\n')
    expect(Buffer.byteLength(five)).toBeLessThan(4000)
    expect(encoded(five.replace('Done.', 'x'))).toBeGreaterThan(9000)
    const args = stop(five)!
    expect(args.hook).toBe('stop')
    expect(args.last_lines).toBeUndefined()
    expect(calls()).toBe(1)
  })

  it('beside long temp paths the last lines give way: the two together stay under the cap', () => {
    // Five files that exist in the temp directory the hook looks in, each path about 950 characters: it sends them as tmp_paths.
    const deep = path.join(tmp, 'a'.repeat(220), 'b'.repeat(220), 'c'.repeat(220), 'd'.repeat(220))
    fs.mkdirSync(deep, { recursive: true })
    const files = [1, 2, 3, 4, 5].map((i) => path.join(deep, `plan-${i}.md`))
    for (const f of files) fs.writeFileSync(f, 'x')
    const lines = ids.slice(0, 2).map(long)
    // Alone, the two lines are sent.
    expect(readCardTags(stop(['Done.', ...lines].join('\n'))!.last_lines).cards).toHaveLength(2)
    // With the paths the request would pass the cap: the paths go, the lines do not.
    const both = stop([`The plans: ${files.join(' ')}`, ...lines].join('\n'))!
    expect(both.tmp_paths?.split('|')).toEqual(files)
    expect(both.last_lines).toBeUndefined()
    expect(encoded(both.tmp_paths) + encoded(['x', ...lines].join('\n'))).toBeGreaterThan(9000)
    // Short lines still fit beside them.
    const short = stop([`The plans: ${files.join(' ')}`, cardTagLine(FENCE)].join('\n'))!
    expect(short.tmp_paths?.split('|')).toEqual(files)
    expect(short.last_lines).toBe(`x\n${cardTagLine(FENCE)}`)
    expect(encoded(short.tmp_paths) + encoded(short.last_lines)).toBeLessThanOrEqual(9000)
  })

  it('a request the server refuses as too large is asked again without the last lines', () => {
    const args = stop(reply, { walnut: TOO_LARGE })!
    expect(args.hook).toBe('stop')
    expect(args.last_lines).toBeUndefined()
    expect(calls()).toBe(2)
  })

  it('any other answer that is no answer is asked again without them: silence, an error, another read', () => {
    for (const answer of [
      'exit 1',
      'echo "Invalid arguments for open_items: last_lines: Too big"; exit 1',
      'echo \'{"ok":false,"error":{"code":"http_500","message":"Walnut API error (500)"}}\'; exit 1',
      // Exit 0 with something that is neither a block nor the empty answer.
      'echo \'{"subtasks":[],"waitingOn":[]}\'; exit 0',
      'exit 0',
    ]) {
      const args = stop(reply, { walnut: failing(answer) })!
      expect(args.hook, answer).toBe('stop')
      expect(args.last_lines, answer).toBeUndefined()
      expect(calls(), answer).toBe(2)
    }
  })

  it('an answer is asked once: a block, and the empty answer of a turn free to end', () => {
    expect(stop(reply)!.last_lines).toBe(`x\n${cardTagLine(FENCE)}`)
    expect(calls()).toBe(1)
    expect(stop(reply, { walnut: FREE })).toBeNull()
    expect(calls()).toBe(1)
  })

  it('a walnut that fails either way is asked twice, never more, and the turn ends', () => {
    expect(stop(reply, { walnut: `${NOTE}echo '{"ok":false,"error":{"code":"hub_unreachable","message":"no server"}}'; exit 1\n` })).toBeNull()
    expect(calls()).toBe(2)
    // With no last lines to leave out there is nothing to ask again.
    expect(stop(undefined, { walnut: `${NOTE}exit 1\n` })).toBeNull()
    expect(calls()).toBe(1)
  })
})

describe('the Stop hook and its own stop', () => {

  it('a stop the hook itself caused asks nothing', () => {
    expect(stop(`The fence is up.\n${cardTagLine(FENCE)}`, { active: true })).toBeNull()
  })
})
