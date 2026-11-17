/**
 * session.tag_requests (src/core/sessions/request-tag.ts): a session Walnut starts tags its
 * model requests with `x-walnut-session: <task id>`, Claude Code through
 * ANTHROPIC_CUSTOM_HEADERS (the user's own header lines kept), Codex through the http_headers
 * of the provider its threads go to. Off by default.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  REQUEST_PROJECT_HEADER, REQUEST_TAG_HEADER, noteRequestTagConfig, requestProjectValue, requestTagOn, requestTagValue, walnutRequestTagHeaders, withCodexRequestTag, withOneShotRequestTag, withRequestTagHeaders,
} from '../../../src/core/sessions/request-tag.js'
import { resolveCodexEngine } from '../../../src/providers/codex-engine-config.js'

const ROOT = path.resolve(__dirname, '../../..')
const PROVIDER = { engines: { codex: { provider: { base_url: 'http://127.0.0.1:9/v1', name: 'local-proxy' } } } }

describe('session.tag_requests', () => {
  it('is off unless the config turns it on, and follows the last config read', () => {
    expect(requestTagOn({})).toBe(false)
    expect(requestTagOn({ session: { tag_requests: 'yes' } })).toBe(false)
    expect(requestTagOn({ session: { tag_requests: true } })).toBe(true)
    noteRequestTagConfig({ session: { tag_requests: true } })
    expect(requestTagOn()).toBe(true)
    noteRequestTagConfig({ session: {} })
    expect(requestTagOn()).toBe(false)
  })

  it('the value is the task id, never a character a header line cannot carry', () => {
    expect(requestTagValue('mw3gr8ne-3062')).toBe('mw3gr8ne-3062')
    expect(requestTagValue('a b\nc: d')).toBe('abcd')
    expect(requestTagValue(undefined)).toBe('walnut')
  })

  it('Claude Code: the tag joins the user\'s own header lines, never replaces them', () => {
    expect(withRequestTagHeaders(undefined, 't1', undefined)).toBe(`${REQUEST_TAG_HEADER}: t1`)
    expect(withRequestTagHeaders('X-Team: blue\nX-Env: dev', 't1', undefined)).toBe(`X-Team: blue\nX-Env: dev\n${REQUEST_TAG_HEADER}: t1`)
    // An older tag line is replaced, so a resume never carries two.
    expect(withRequestTagHeaders(`X-Team: blue\n${REQUEST_TAG_HEADER}: old`, 't2', undefined)).toBe(`X-Team: blue\n${REQUEST_TAG_HEADER}: t2`)
  })

  it('the task\'s project rides beside the tag, percent-encoded; the Inbox sends none', () => {
    expect(withRequestTagHeaders(undefined, 't1', 'Walnut')).toBe(`${REQUEST_TAG_HEADER}: t1\n${REQUEST_PROJECT_HEADER}: Walnut`)
    // A space, a colon, a newline and non-ASCII letters ride one header line and decode back.
    for (const name of ['Walnut-Idea', 'Home Lab', 'a: b\nc', '\u6838\u6843 \u00e9t\u00e9']) {
      const line = withRequestTagHeaders(undefined, 't1', name).split('\n')[1]
      expect(line).toMatch(/^x-walnut-project: [A-Za-z0-9%._~!*'()-]+$/)
      expect(decodeURIComponent(line.slice(`${REQUEST_PROJECT_HEADER}: `.length))).toBe(name)
    }
    expect(requestProjectValue('  Walnut  ')).toBe('Walnut')
    expect(requestProjectValue('')).toBe('')
    expect(withRequestTagHeaders(undefined, 't1', '')).toBe(`${REQUEST_TAG_HEADER}: t1`)
    // A task that moved: its old project line is replaced, the user's own lines kept.
    const moved = withRequestTagHeaders(`X-Team: blue\n${REQUEST_TAG_HEADER}: t1\n${REQUEST_PROJECT_HEADER}: Old`, 't1', 'New One')
    expect(moved).toBe(`X-Team: blue\n${REQUEST_TAG_HEADER}: t1\n${REQUEST_PROJECT_HEADER}: New%20One`)
    // Moved into the Inbox: no project line at all.
    expect(withRequestTagHeaders(moved, 't1', undefined)).toBe(`X-Team: blue\n${REQUEST_TAG_HEADER}: t1`)
  })

  it('Codex: the provider the threads go to carries the header, its own headers kept', () => {
    const tagged = resolveCodexEngine(PROVIDER, undefined, { tag: { session: 't1', project: 'Walnut Idea' } }).baseConfig as Record<string, any>
    expect(tagged.model_provider).toBe('local-proxy')
    expect(tagged.model_providers['local-proxy'].http_headers).toEqual({ [REQUEST_TAG_HEADER]: 't1', [REQUEST_PROJECT_HEADER]: 'Walnut%20Idea' })
    const untagged = resolveCodexEngine(PROVIDER, undefined).baseConfig as Record<string, any>
    expect(untagged.model_providers['local-proxy'].http_headers).toBeUndefined()
    // A provider of the user's own CODEX_CONFIG is tagged too, with its headers kept.
    const own = JSON.stringify({ model_provider: 'mine', model_providers: { mine: { base_url: 'http://x/v1', http_headers: { 'X-Team': 'blue' } } } })
    const theirs = resolveCodexEngine({}, own, { tag: { session: 't2', project: undefined } }).baseConfig as Record<string, any>
    expect(theirs.model_providers.mine.http_headers).toEqual({ 'X-Team': 'blue', [REQUEST_TAG_HEADER]: 't2' })
    // An Inbox task drops a project header an older config carried.
    const stale = { model_provider: 'p', model_providers: { p: { http_headers: { [REQUEST_PROJECT_HEADER]: 'Old' } } } }
    expect((withCodexRequestTag(stale, 't4', '') as any).model_providers.p.http_headers).toEqual({ [REQUEST_TAG_HEADER]: 't4' })
    expect(stale.model_providers.p.http_headers).toEqual({ [REQUEST_PROJECT_HEADER]: 'Old' })
    // A header of ours in other letter case is replaced too, never sent twice.
    const upper = { model_provider: 'p', model_providers: { p: { http_headers: { 'X-Walnut-Project': 'Old', 'X-Walnut-Session': 'old', 'X-Team': 'b' } } } }
    expect((withCodexRequestTag(upper, 't5', 'New') as any).model_providers.p.http_headers).toEqual({ 'X-Team': 'b', [REQUEST_TAG_HEADER]: 't5', [REQUEST_PROJECT_HEADER]: 'New' })
    // Codex's built-in provider (no table here) takes no header.
    expect(withCodexRequestTag({ model: 'gpt' }, 't3', 'Walnut')).toEqual({ model: 'gpt' })
  })

  it('one-shot claude -p: the tag rides the env and the inline --settings env, the user\'s lines kept', () => {
    const plain = withOneShotRequestTag({ args: ['-p', '--model', 'm'], env: { HOME: '/h' } }, undefined)
    expect(plain.env.ANTHROPIC_CUSTOM_HEADERS).toBe(`${REQUEST_TAG_HEADER}: walnut`)
    expect(plain.args.slice(0, 3)).toEqual(['-p', '--model', 'm'])
    expect(JSON.parse(plain.args[plain.args.indexOf('--settings') + 1]).env.ANTHROPIC_CUSTOM_HEADERS).toBe(`${REQUEST_TAG_HEADER}: walnut`)
    // An inline --settings keeps its own keys; the user's settings.json header lines are kept.
    const slim = withOneShotRequestTag({ args: ['-p', '--settings', JSON.stringify({ env: { A: '1' }, x: 2 })], env: {} }, 'X-Team: blue')
    const settings = JSON.parse(slim.args[2])
    expect(settings).toEqual({ x: 2, env: { A: '1', ANTHROPIC_CUSTOM_HEADERS: `X-Team: blue\n${REQUEST_TAG_HEADER}: walnut` } })
    expect(slim.args.filter((a) => a === '--settings')).toHaveLength(1)
    // A settings file path is left alone; the env still carries the tag.
    const file = withOneShotRequestTag({ args: ['--settings', '/tmp/s.json'], env: { ANTHROPIC_CUSTOM_HEADERS: 'X-A: 1' } }, undefined)
    expect(file.args).toEqual(['--settings', '/tmp/s.json'])
    expect(file.env.ANTHROPIC_CUSTOM_HEADERS).toBe(`X-A: 1\n${REQUEST_TAG_HEADER}: walnut`)
  })

  it('Walnut\'s own server-side model calls: the walnut tag while on, nothing while off', () => {
    expect(walnutRequestTagHeaders({ session: { tag_requests: true } })).toEqual({ [REQUEST_TAG_HEADER]: 'walnut' })
    expect(walnutRequestTagHeaders({})).toEqual({})
  })

  it('every model client Walnut builds in the server carries the tag (a new one fails here)', () => {
    // Ollama is a local model server, never behind the user's provider proxy.
    const exempt = new Set(['src/model/providers/adapter-ollama.ts'])
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (/\.tsx?$/.test(e.name) && /new (Anthropic|AnthropicBedrock|OpenAI)\(/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) files.push(rel)
      }
    }
    walk('src')
    expect(files.length).toBeGreaterThanOrEqual(4)
    const untagged = files.filter((f) => !exempt.has(f) && !fs.readFileSync(path.join(ROOT, f), 'utf8').includes('walnutRequestTagHeaders('))
    expect(untagged).toEqual([])
  })

  it('every spawn path tags its requests: the Claude Code settings env and the Codex adapter config', () => {
    const claude = fs.readFileSync(path.join(ROOT, 'src/providers/claude-code-session.ts'), 'utf8')
    expect(claude).toMatch(/ANTHROPIC_CUSTOM_HEADERS: withRequestTagHeaders\(/)
    expect(claude).toMatch(/\.\.\.walnutEnv, \.\.\.tagEnv \}/)
    const acp = fs.readFileSync(path.join(ROOT, 'src/providers/acp-session.ts'), 'utf8')
    expect(acp).toMatch(/requestTagOn\(walnutConfig\) \? \{ tag: \{ session: requestTagValue\(this\.taskId\), project: await requestTagProject\(this\.taskId, this\.project\) \} \}/)
    // Every other ACP engine (dsh and the rest on the Anthropic SDK) gets the header in its env.
    expect(acp).toMatch(/ownHeaders = overlay\?\.ANTHROPIC_CUSTOM_HEADERS/)
    expect(acp).toMatch(/ANTHROPIC_CUSTOM_HEADERS: withRequestTagHeaders\(ownHeaders, requestTagValue\(this\.taskId\), await requestTagProject\(this\.taskId, this\.project\)\)/)
    // Every Walnut one-shot (titles, summaries, placement, micro-Claude, inline subagents) starts through startOneShot.
    const oneshot = fs.readFileSync(path.join(ROOT, 'src/providers/oneshot-client.ts'), 'utf8')
    expect(oneshot).toMatch(/spec = tag\.withOneShotRequestTag\(spec,/)
    // A pooled micro-Claude child is booted before its run, so it is tagged before its pool key.
    const warm = fs.readFileSync(path.join(ROOT, 'src/providers/micro-claude-warm.ts'), 'utf8')
    const tagAt = warm.indexOf('withOneShotRequestTag({ args, env: buildChildEnv() }')
    expect(tagAt).toBeGreaterThan(0)
    expect(tagAt).toBeLessThan(warm.indexOf('const warmKey ='))
    const manager = fs.readFileSync(path.join(ROOT, 'src/core/config-manager.ts'), 'utf8')
    expect(manager).toMatch(/noteRequestTagConfig\(config\)/)
  })
})
