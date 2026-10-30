/**
 * Background fast-model calls on a model server the user hosts (Ollama, LM
 * Studio, vLLM). Such a server answers one request at a time, so a background
 * call waits behind the session turn it serves: it gets a budget that fits, and
 * a call cut off by its deadline is named a timeout, never parsed as an empty
 * answer. 2026-10-30: host-learning failed every run on a local model with
 * "JSON Parse error: Unexpected EOF" after 15 s while Ollama was busy.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLI_FAST_CALL_BUDGET_MS, FastCallTimeoutError, LOCAL_FAST_CALL_BUDGET_MS, fastCallBudgetMs, fastCallText,
} from '../../src/core/cheap-model.js'
import { titleBudgetMs } from '../../src/core/session-title-backend.js'
import type { Config } from '../../src/core/types.js'

const cfg = (main: string, providers: Record<string, unknown>): Config =>
  ({ agent: { main_provider: main }, providers } as unknown as Config)

describe('fastCallBudgetMs fits the channel', () => {
  it('a local model server waits as long as a session turn may take', async () => {
    const ollama = cfg('ollama', { ollama: { api: 'ollama', base_url: 'http://localhost:11434' } })
    expect(fastCallBudgetMs(ollama, 15_000)).toBe(LOCAL_FAST_CALL_BUDGET_MS)
    expect(await titleBudgetMs(ollama)).toBe(LOCAL_FAST_CALL_BUDGET_MS)
    const lmstudio = cfg('lm', { lm: { api: 'openai-chat', base_url: 'http://127.0.0.1:1234/v1' } })
    expect(fastCallBudgetMs(lmstudio, 10_000)).toBe(LOCAL_FAST_CALL_BUDGET_MS)
  })

  it('a cloud API and the Claude CLI keep their budgets', async () => {
    const openai = cfg('openai', { openai: { api: 'openai-chat', base_url: 'https://api.openai.com/v1' } })
    expect(fastCallBudgetMs(openai, 15_000)).toBe(15_000)
    expect(await titleBudgetMs(openai)).toBe(15_000)
    const bedrock = cfg('bedrock', { bedrock: { api: 'bedrock' } })
    expect(fastCallBudgetMs(bedrock, 15_000)).toBe(15_000)
    const cli = cfg('claude_cli', { claude_cli: { api: 'claude-cli' } })
    expect(fastCallBudgetMs(cli, 15_000)).toBe(CLI_FAST_CALL_BUDGET_MS)
    expect(await titleBudgetMs(cli)).toBe(CLI_FAST_CALL_BUDGET_MS)
  })

  it('an explicit provider is judged on its own, not on the main one', () => {
    const mixed = cfg('bedrock', { bedrock: { api: 'bedrock' }, ollama: { api: 'ollama' } })
    expect(fastCallBudgetMs(mixed, 15_000)).toBe(15_000)
    expect(fastCallBudgetMs(mixed, 15_000, 'ollama')).toBe(LOCAL_FAST_CALL_BUDGET_MS)
  })
})

describe('fastCallText', () => {
  it('joins the text blocks', () => {
    expect(fastCallText({ content: [{ type: 'text', text: ' {"a":1}' } as never, { type: 'thinking' }] })).toBe('{"a":1}')
  })

  it('an aborted call is a timeout, not an empty answer', () => {
    expect(() => fastCallText({ content: [], aborted: true }, 15_000)).toThrow(FastCallTimeoutError)
    expect(() => fastCallText({ content: [], aborted: true }, 15_000)).toThrow('did not answer within 15 s')
  })
})

// Ratchet: every model call with its own deadline reads the answer in a way
// that tells a timeout from an empty answer. A new caller that joins the text
// blocks itself, without looking at `aborted`, fails here.
describe('every timed model call tells a timeout from an empty answer', () => {
  const root = path.resolve(__dirname, '../../src')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) files.push(p)
    }
  }
  walk(root)
  const timed = files.filter((f) => {
    const s = fs.readFileSync(f, 'utf8')
    return /\bsendMessage(Stream)?\(/.test(s) && /setTimeout\(\(\) => controller\.abort\(\)/.test(s)
  })

  it('finds the timed callers', () => {
    expect(timed.length).toBeGreaterThanOrEqual(10)
  })

  it.each(timed.map((f) => [path.relative(root, f)]))('%s', (rel) => {
    const s = fs.readFileSync(path.join(root, rel), 'utf8')
    expect(/fastCallText\(|result\.aborted/.test(s)).toBe(true)
  })
})
