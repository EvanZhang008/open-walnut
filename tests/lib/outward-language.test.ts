/**
 * Words other people read go out in the language the user set for them (lib/outward-language.ts):
 * which calls are those, how their words are judged, and the class guard over Walnut's own ways a
 * session runs a command or an MCP tool (every one is held as the session's own call, or exempt).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { COMMAND_RUNNERS, MCP_RUNNERS, OUTWARD_RUNNERS_EXEMPT, commandFiles, outwardCall, outwardCommandPrefilter, outwardHookMatcher, outwardOffScript, outwardRefusal, outwardSettingOf } from '../../src/lib/outward-language.js'
import { listOpEntries, opInputJsonSchema } from '../../src/ops/registry.js'

// Test data: Chinese text for the user (escaped by the test writer), English for colleagues.
const ZH = '\u8fd9\u4e2a\u4fee\u590d\u5df2\u7ecf\u4e0a\u7ebf\uff0c\u8bf7\u5e2e\u5fd9\u770b\u4e00\u4e0b\u3002'
const EN = 'The fix is live; please take a look.'
const SET = outwardSettingOf({ language: 'English', tools: ['mcp__chat__post_message', 'mcp__tickets__.*comment.*'], commands: ['\\bgh (pr|issue) (create|comment|edit)\\b', '\\bgit commit\\b'] })!

describe('the setting', () => {
  it('names a language it knows, and keeps only patterns that compile', () => {
    expect(SET).toMatchObject({ language: 'English', script: 'latin' })
    expect(outwardSettingOf({ language: 'English', tools: ['ok', '(bad'], commands: [3, ''] })).toEqual({ language: 'English', script: 'latin', tools: ['ok'], commands: [] })
    expect(outwardSettingOf({ language: 'Klingon' })).toBeNull()
    expect(outwardSettingOf(undefined)).toBeNull()
  })

  it('asks for a hook only when it lists a step, and then watches Walnut\'s own runners too', () => {
    expect(outwardHookMatcher(outwardSettingOf({ language: 'English' }))).toBeNull()
    const m = new RegExp(outwardHookMatcher(SET)!)
    for (const name of ['mcp__chat__post_message', 'mcp__tickets__add_comment', 'Bash', 'mcp__walnut__host_exec', 'mcp__walnut__host_mcp_call', 'mcp__walnut__mcp_call']) expect(m.test(name), name).toBe(true)
    for (const name of ['mcp__chat__read_channel', 'Read', 'mcp__walnut__task_send', 'BashOutput']) expect(m.test(name), name).toBe(false)
    // The shell's prefilter: a POSIX ERE as wide as each pattern, or none (Walnut is asked every time).
    expect(outwardCommandPrefilter(SET)).toBe('(gh (pr|issue) (create|comment|edit))|(git commit)')
    const pre = (c: string) => outwardCommandPrefilter(outwardSettingOf({ language: 'English', commands: [c] }))
    expect(pre('(?:cr|post)\\s+--body\\d')).toBe('((cr|post)[[:space:]]+--body[0-9])')
    for (const c of ['(?=x)y', 'a"b', '[\\d]x', '(a)\\1', 'a\\\\b']) expect(pre(c), c).toBeNull()
    // The hook's input is one JSON line: a pattern's anchors would never match it, so they go.
    expect(pre('^git commit$')).toBe('(git commit)')
    expect(pre('^git commit|^gh pr create$')).toBe('(git commit|gh pr create)')
    expect(pre('[^$]x')).toBe('([^$]x)')
  })
})

describe('the calls other people read', () => {
  it('a listed tool, its words in any field', () => {
    const c = outwardCall('mcp__chat__post_message', { channel: '#team', text: ZH }, SET)!
    expect(c.text).toContain(ZH)
    expect(outwardCall('mcp__chat__read_channel', { channel: '#team' }, SET)).toBeNull()
  })

  it('a listed command, never one that is not', () => {
    expect(outwardCall('Bash', { command: `gh pr create --title "x" --body "${ZH}"`, description: ZH }, SET)!.text).toContain(ZH)
    expect(outwardCall('Bash', { command: 'ls -la', description: ZH }, SET)).toBeNull()
    // The description is the user's progress line, never what others read.
    expect(outwardCall('Bash', { command: 'git commit -m "Fix the sync"', description: ZH }, SET)!.text).not.toContain(ZH)
  })

  it('a command over several lines, and the files a command reads its words from', () => {
    const multi = SET.commands.length && outwardCall('Bash', { command: `gh pr create --title "Fix" \\\n  --body "${ZH}"` }, SET)
    expect(multi && multi.text).toContain(ZH)
    expect(commandFiles('gh pr create --body-file ./pr.md -F "notes.txt" && curl -d @./x.json < in.txt && echo $(cat /tmp/m.md)')).toEqual(['./pr.md', 'notes.txt', './x.json', 'in.txt', '/tmp/m.md'])
    const c = outwardCall('Bash', { command: 'gh pr create --title "Fix" --body-file ./pr.md' }, SET, { './pr.md': ZH, './other.md': 'x' })!
    expect(c.text).toContain(ZH)
    expect(outwardOffScript(c.text, 'latin', { shell: true })).not.toBeNull()
  })

  it('a folder or file named in another language is not a message', () => {
    const c = outwardCall('Bash', { command: `cd /notes/${ZH} && git add ${ZH}/${ZH}.md && git commit -m "Fix the sync" ./${ZH}.md` }, SET)!
    expect(c.text).not.toContain(ZH)
    expect(outwardOffScript(c.text, 'latin', { shell: true })).toBeNull()
  })

  // Review round 2: Chinese prose has no spaces, so a slash or a link inside it once made the whole
  // sentence a "path" and let it go.
  it('a sentence with a slash or a link in it is still words, never a path', () => {
    for (const cmd of [`git commit -m "${ZH}/${ZH}"`, `git commit -m "${ZH}https://x.io/a"`, `git commit -F - <<'EOF'\n${ZH}/${ZH}\nEOF`]) {
      const c = outwardCall('Bash', { command: cmd }, SET)!
      expect(outwardOffScript(c.text, 'latin', { shell: true }), cmd).not.toBeNull()
    }
  })

  it('a command or tool through Walnut\'s own runners', () => {
    expect(outwardCall('mcp__walnut__host_exec', { host: 'dev', command: `git commit -m "${ZH}"` }, SET)).not.toBeNull()
    expect(outwardCall('mcp__walnut__host_exec_pinned', { host: 'dev', argv: ['gh', 'issue', 'comment', '1', '--body', ZH] }, SET)).not.toBeNull()
    expect(outwardCall('mcp__walnut__host_mcp_call', { host: 'mac', server: 'chat', tool: 'post_message', arguments: { text: ZH } }, SET)!.text).toBe(ZH)
    expect(outwardCall('mcp__walnut__mcp_call', { server: 'tickets', tool: 'add_comment', arguments: { body: ZH } }, SET)).not.toBeNull()
    expect(outwardCall('mcp__walnut__host_mcp_call', { host: 'mac', server: 'chat', tool: 'read_channel', arguments: {} }, SET)).toBeNull()
  })
})

describe('the judge', () => {
  it('holds words in another script, quoted or not, and lets English, a name and code through', () => {
    expect(outwardOffScript(EN, 'latin')).toBeNull()
    expect(outwardOffScript(`${EN} ${ZH}`, 'latin')).not.toBeNull()
    expect(outwardOffScript(`${EN} "${ZH}"`, 'latin')).not.toBeNull()
    expect(outwardOffScript(`${EN} Thanks, \u738b\u660e.`, 'latin')).toBeNull()
    expect(outwardOffScript(`${EN}\n\n\`\`\`\nconst label = '${ZH}'\n\`\`\``, 'latin')).toBeNull()
    expect(outwardOffScript(`${EN} \`${ZH}\``, 'latin')).toBeNull()
    // In a shell command backticks run a command: their words are what goes out.
    expect(outwardOffScript(`git commit -m "\`echo ${ZH}\`"`, 'latin', { shell: true })).not.toBeNull()
  })

  it('a refusal says what, the language, and never to translate into the user\'s', () => {
    const c = outwardCall('mcp__chat__post_message', { text: ZH }, SET)!
    const r = outwardRefusal(c, SET, outwardOffScript(c.text, 'latin')!)
    expect(r).toMatch(/^Your call of mcp__chat__post_message was not run: other people read its words/)
    expect(r).toContain('are in English')
    expect(r).toContain('never translate them into the user\'s own language')
    // It names the words it found.
    expect(r).toContain(`"${ZH.slice(0, 24)}`)
  })
})

/** The last segments of an argument that run a command or call an MCP tool. */
function runsSomething(schema: unknown): boolean {
  const p = (schema as { properties?: Record<string, unknown> }).properties ?? {}
  return 'command' in p || 'argv' in p || ('server' in p && 'tool' in p)
}

describe('every Walnut op that runs a command or an MCP tool is held, or says why not (guard)', () => {
  beforeAll(async () => { await import('../../src/ops/index.js') })
  it('names each, a new one included', () => {
    const runners = new Set([...COMMAND_RUNNERS, ...MCP_RUNNERS].map((n) => n.replace(/^mcp__walnut__/, '')))
    const ops = listOpEntries().filter((e) => !e.op.deprecated && runsSomething(opInputJsonSchema(e.op))).map((e) => e.op.name)
    expect(ops.length).toBeGreaterThan(3)
    expect(ops.filter((n) => !runners.has(n) && !OUTWARD_RUNNERS_EXEMPT[n]), 'add it to COMMAND_RUNNERS, MCP_RUNNERS or OUTWARD_RUNNERS_EXEMPT in src/lib/outward-language.ts').toEqual([])
    for (const n of [...runners].filter((r) => r !== 'Bash')) expect(ops, n).toContain(n)
  })
})
