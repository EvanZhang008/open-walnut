/** The pure rules of a failed `walnut tools call` (src/providers/tool-call-output.ts); 2026-11-06: `2>&1 | json.load` read "Expecting value". */
import { describe, expect, it } from 'vitest'
import {
  gatewayFailureCode,
  opFailureCode,
  renderToolCallFailure,
  splitToolsJsonFlag,
  toolCallFailure,
} from '../../../src/providers/tool-call-output.js'
import { helpText } from '../../../src/providers/wn-cli.js'

describe('toolCallFailure', () => {
  it('is {ok:false,error:{code,message}}, with extra lines joined into the message', () => {
    expect(toolCallFailure('hub_timeout', 'no reply', ['walnut: read it first:', '  walnut tools call host_exec_read \'{}\'']))
      .toEqual({ ok: false, error: { code: 'hub_timeout', message: 'no reply\nwalnut: read it first:\n  walnut tools call host_exec_read \'{}\'' } })
  })

  it('drops empty lines and trailing space, and carries detail only when given', () => {
    expect(toolCallFailure('x', 'm  ', ['', '  ', 'n\n'])).toEqual({ ok: false, error: { code: 'x', message: 'm\nn' } })
    expect(toolCallFailure('x', 'm', [], { candidates: [] }).error.detail).toEqual({ candidates: [] })
    expect('detail' in toolCallFailure('x', 'm').error).toBe(false)
  })
})

describe('renderToolCallFailure', () => {
  const failure = toolCallFailure('invalid_arguments', 'Invalid arguments for search: types: "x"')

  it('default: one JSON line on stderr that parses whole, nothing on stdout', () => {
    const s = renderToolCallFailure(failure, { json: false })
    expect(s.stdout).toBe('')
    expect(s.stderr.endsWith('\n')).toBe(true)
    expect(s.stderr.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(s.stderr)).toEqual(failure)
    // What a `2>&1` reader gets: the same object, whole.
    expect(JSON.parse(s.stdout + s.stderr)).toEqual(failure)
  })

  it('--json: the one object on stdout, stderr empty', () => {
    const s = renderToolCallFailure(failure, { json: true })
    expect(s.stderr).toBe('')
    expect(JSON.parse(s.stdout)).toEqual(failure)
  })

  it('default keeps an op\'s partial result on stdout and does not repeat it on stderr', () => {
    const partial = { outcome: 'Refused, nothing changed', next: 'wait 30s' }
    const s = renderToolCallFailure(toolCallFailure('throttled', 'too many', [], partial), { json: false, partial })
    expect(JSON.parse(s.stdout)).toEqual(partial)
    expect(JSON.parse(s.stderr)).toEqual({ ok: false, error: { code: 'throttled', message: 'too many' } })
  })

  it('--json puts the partial result in error.detail, never before the object', () => {
    const partial = { count: 1 }
    const s = renderToolCallFailure(toolCallFailure('op_failed', 'half done'), { json: true, partial })
    expect(s.stdout.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(s.stdout)).toEqual({ ok: false, error: { code: 'op_failed', message: 'half done', detail: { count: 1 } } })
  })

  it('default keeps a detail stdout does not carry (a stopping daemon) in the stderr object', () => {
    const s = renderToolCallFailure(toolCallFailure('hub_unreachable', 'stopping', [], { stopping: true }), { json: false })
    expect(s.stdout).toBe('')
    expect(JSON.parse(s.stderr).error.detail).toEqual({ stopping: true })
  })
})

describe('the codes', () => {
  it('names an op failure from the fixed opening of its message', () => {
    expect(opFailureCode('Invalid arguments for search: types: Invalid input')).toBe('invalid_arguments')
    expect(opFailureCode('Unknown op: nope. Run `walnut tools list`')).toBe('unknown_op')
    expect(opFailureCode('unknown op: nope — run `walnut tools list`')).toBe('unknown_op')
    expect(opFailureCode('Walnut API error (task_in_use): busy')).toBe('task_in_use')
    expect(opFailureCode('Walnut API error (404): Not Found')).toBe('http_404')
    expect(opFailureCode('Walnut server not running at http://127.0.0.1:1')).toBe('hub_unreachable')
    expect(opFailureCode('Walnut request timed out after 10ms: GET /search')).toBe('hub_timeout')
    expect(opFailureCode('Walnut request failed: socket hang up')).toBe('request_failed')
    expect(opFailureCode('something else')).toBe('op_failed')
  })

  it('a gateway code is kept, except the catch-alls an op failure arrives with', () => {
    expect(gatewayFailureCode('throttled', 'Invalid arguments for x')).toBe('throttled')
    expect(gatewayFailureCode('internal', 'Invalid arguments for search: q')).toBe('invalid_arguments')
    expect(gatewayFailureCode('internal', 'disk on fire')).toBe('internal')
    expect(gatewayFailureCode('bad_request', 'unknown op: nope — run `walnut tools list`')).toBe('unknown_op')
    expect(gatewayFailureCode('bad_request', 'tools.call requires a non-empty string "name"')).toBe('bad_request')
  })
})

describe('splitToolsJsonFlag', () => {
  const PAYLOAD = '{"q":"controller"}'

  it('reads --json before call, before the op, and after the JSON', () => {
    for (const argv of [
      ['--json', 'call', 'search', PAYLOAD],
      ['call', '--json', 'search', PAYLOAD],
      ['call', 'search', PAYLOAD, '--json'],
      ['call', 'search', '--json', PAYLOAD],
    ]) {
      expect(splitToolsJsonFlag(argv), argv.join(' ')).toEqual({ args: ['call', 'search', PAYLOAD], json: true })
    }
  })

  it('with no argument at all (stdin or none)', () => {
    expect(splitToolsJsonFlag(['call', 'task_list', '--json'])).toEqual({ args: ['call', 'task_list'], json: true })
  })

  it('never reads text inside the JSON argument, or a JSON argument that is the word', () => {
    const inside = '{"text":"--json"}'
    expect(splitToolsJsonFlag(['call', 'task_send', inside])).toEqual({ args: ['call', 'task_send', inside], json: false })
    expect(splitToolsJsonFlag(['call', 'task_send', ' --json'])).toEqual({ args: ['call', 'task_send', ' --json'], json: false })
  })

  it('keeps a word after the argument for the trailing-word refusal', () => {
    expect(splitToolsJsonFlag(['call', 'task_send', PAYLOAD, '--json', '--dry-run']))
      .toEqual({ args: ['call', 'task_send', PAYLOAD, '--dry-run'], json: true })
  })

  it('leaves a flag-form tail to the flag parser', () => {
    expect(splitToolsJsonFlag(['call', 'task_list', '--q', '--json', '--json']))
      .toEqual({ args: ['call', 'task_list', '--q', '--json', '--json'], json: false })
  })

  it('other subcommands: only the leading --json', () => {
    expect(splitToolsJsonFlag(['--json', 'list', '--readonly'])).toEqual({ args: ['list', '--readonly'], json: true })
    expect(splitToolsJsonFlag(['help', 'search'])).toEqual({ args: ['help', 'search'], json: false })
    expect(splitToolsJsonFlag(['call'])).toEqual({ args: ['call'], json: false })
    expect(splitToolsJsonFlag([])).toEqual({ args: [], json: false })
  })
})

describe('the tools manual', () => {
  it('says how a failure prints, that 2>&1 is no way to read a result, and what --json does', () => {
    const h = helpText('tools')
    expect(h).toContain('OUTPUT')
    expect(h).toContain('{"ok":false,"error":{"code":"...","message":"...","detail":...}}')
    expect(h).toContain('Do not read a normal result through 2>&1')
    expect(h).toContain('add --json (before call, before the op, or after the JSON)')
    expect(h).toContain('"ok": false')
  })

  it('warns a success-only parser, and captures first and stops on the failure before parsing', () => {
    const h = helpText('tools')
    expect(h).toContain('A success-only parser can mistake a valid error object for an empty result.')
    expect(h).toContain('Capture first and stop on failure before parsing successful fields:')
    const recipe = h.slice(h.indexOf('out=$(walnut tools call'), h.indexOf('Only then parse "$out" as the result.'))
    expect(recipe).toMatch(/--json\) \|\| \{\s+rc=\$\?; printf '%s\\n' "\$out" >&2; exit "\$rc"\s+\}\s*$/)
    expect(recipe).not.toContain('2>&1')
  })
})
