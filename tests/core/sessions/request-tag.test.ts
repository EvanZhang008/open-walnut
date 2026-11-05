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
  REQUEST_TAG_HEADER, noteRequestTagConfig, requestTagOn, requestTagValue, withCodexRequestTag, withRequestTagHeaders,
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
    expect(withRequestTagHeaders(undefined, 't1')).toBe(`${REQUEST_TAG_HEADER}: t1`)
    expect(withRequestTagHeaders('X-Team: blue\nX-Env: dev', 't1')).toBe(`X-Team: blue\nX-Env: dev\n${REQUEST_TAG_HEADER}: t1`)
    // An older tag line is replaced, so a resume never carries two.
    expect(withRequestTagHeaders(`X-Team: blue\n${REQUEST_TAG_HEADER}: old`, 't2')).toBe(`X-Team: blue\n${REQUEST_TAG_HEADER}: t2`)
  })

  it('Codex: the provider the threads go to carries the header, its own headers kept', () => {
    const tagged = resolveCodexEngine(PROVIDER, undefined, { tag: 't1' }).baseConfig as Record<string, any>
    expect(tagged.model_provider).toBe('local-proxy')
    expect(tagged.model_providers['local-proxy'].http_headers).toEqual({ [REQUEST_TAG_HEADER]: 't1' })
    const untagged = resolveCodexEngine(PROVIDER, undefined).baseConfig as Record<string, any>
    expect(untagged.model_providers['local-proxy'].http_headers).toBeUndefined()
    // A provider of the user's own CODEX_CONFIG is tagged too, with its headers kept.
    const own = JSON.stringify({ model_provider: 'mine', model_providers: { mine: { base_url: 'http://x/v1', http_headers: { 'X-Team': 'blue' } } } })
    const theirs = resolveCodexEngine({}, own, { tag: 't2' }).baseConfig as Record<string, any>
    expect(theirs.model_providers.mine.http_headers).toEqual({ 'X-Team': 'blue', [REQUEST_TAG_HEADER]: 't2' })
    // Codex's built-in provider (no table here) takes no header.
    expect(withCodexRequestTag({ model: 'gpt' }, 't3')).toEqual({ model: 'gpt' })
  })

  it('every spawn path tags its requests: the Claude Code settings env and the Codex adapter config', () => {
    const claude = fs.readFileSync(path.join(ROOT, 'src/providers/claude-code-session.ts'), 'utf8')
    expect(claude).toMatch(/ANTHROPIC_CUSTOM_HEADERS: withRequestTagHeaders\(/)
    expect(claude).toMatch(/\.\.\.walnutEnv, \.\.\.tagEnv \}/)
    const acp = fs.readFileSync(path.join(ROOT, 'src/providers/acp-session.ts'), 'utf8')
    expect(acp).toMatch(/requestTagOn\(walnutConfig\) \? \{ tag: requestTagValue\(this\.taskId\) \}/)
    const manager = fs.readFileSync(path.join(ROOT, 'src/core/config-manager.ts'), 'utf8')
    expect(manager).toMatch(/noteRequestTagConfig\(config\)/)
  })
})
