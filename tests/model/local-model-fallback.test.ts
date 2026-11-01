/**
 * A model Walnut's own calls name that the local server does not serve falls back
 * to the main model (src/model/providers/local-provider.ts localModelOrMain, used by
 * resolveForCall in src/model/model.ts). 2026-11-01: Path D's snippet set
 * fast_model qwen3:8b next to a pull of only qwen3-coder:30b, so host-learning and
 * every other helper got `404 model 'qwen3:8b' not found`.
 *
 * Runs sendMessage against a stand-in Ollama on a random port that speaks the two
 * endpoints Walnut uses (GET /api/tags, POST /v1/chat/completions).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('walnut-local-model-fallback'))

import { WALNUT_HOME } from '../../src/constants.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { sendMessage } from '../../src/model/model.js'
import { resetLocalModelCache } from '../../src/model/providers/local-provider.js'
import { log } from '../../src/logging/index.js'

let ollama: http.Server
let url = ''
let served: string[] = []
let tagReads = 0
const chats: string[] = []

beforeAll(async () => {
  ollama = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url === '/api/tags') {
      tagReads++
      res.end(JSON.stringify({ models: served.map((name) => ({ name })) }))
      return
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      tagReads++
      res.end(JSON.stringify({ object: 'list', data: served.map((id) => ({ id, object: 'model' })) }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const model = (JSON.parse(body) as { model: string }).model
        chats.push(model)
        const tagged = (m: string) => (m.includes(':') ? m : `${m}:latest`)
        if (!served.some((m) => tagged(m) === tagged(model))) {
          res.writeHead(404)
          res.end(JSON.stringify({ error: { message: `model '${model}' not found` } }))
          return
        }
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', created: 0, model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }))
      })
      return
    }
    res.writeHead(404); res.end('{}')
  })
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()))
  url = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await updateConfig({
    providers: { ollama: { api: 'ollama', base_url: url }, lmstudio: { api: 'openai-chat', base_url: `${url}/v1` } },
    agent: { main_provider: 'ollama', main_model: 'qwen3-coder:30b', fast_model: 'qwen3:8b' },
  } as never)
})

afterAll(async () => {
  await new Promise<void>((r) => ollama.close(() => r()))
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

beforeEach(() => {
  resetLocalModelCache()
  chats.length = 0
  tagReads = 0
  vi.restoreAllMocks()
})

const ask = (model?: string, provider?: string) => sendMessage({
  messages: [{ role: 'user', content: 'hi' }],
  config: { maxTokens: 50, ...(model ? { model } : {}), ...(provider ? { provider } : {}) },
  purpose: 'background',
})

describe('a model the local server lacks', () => {
  it('goes to the main model instead, and says so in the log once', async () => {
    served = ['qwen3-coder:30b']
    const warn = vi.spyOn(log.agent, 'warn')
    await ask('qwen3:8b')
    await ask('qwen3:8b')
    expect(chats).toEqual(['qwen3-coder:30b', 'qwen3-coder:30b'])
    const told = warn.mock.calls.filter(([msg]) => String(msg).includes('has no model "qwen3:8b"'))
    expect(told).toHaveLength(1)
    expect(String(told[0][0])).toContain('ollama pull qwen3:8b')
    // The list is read once for both calls.
    expect(tagReads).toBe(1)
  })

  it('is used once the server has it (no fallback, no warning)', async () => {
    served = ['qwen3-coder:30b', 'qwen3:8b']
    const warn = vi.spyOn(log.agent, 'warn')
    await ask('qwen3:8b')
    expect(chats).toEqual(['qwen3:8b'])
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('has no model'))).toBe(false)
  })

  it('an untagged name counts as :latest', async () => {
    served = ['qwen3-coder:30b', 'qwen3:latest']
    await ask('qwen3')
    expect(chats).toEqual(['qwen3'])
  })

  it('goes as asked when the server lacks the main model too, so its own error names it', async () => {
    served = ['llama3.2:latest']
    await expect(ask('qwen3:8b')).rejects.toThrow()
    expect(chats[0]).toBe('qwen3:8b')
  })

  it('a call for the main model never reads the list', async () => {
    served = ['qwen3-coder:30b']
    await ask()
    expect(chats).toEqual(['qwen3-coder:30b'])
    expect(tagReads).toBe(0)
  })
  it('an OpenAI-compatible local server (its /models list) falls back the same way', async () => {
    served = ['qwen3-coder:30b']
    await ask('qwen3:8b', 'lmstudio')
    expect(chats).toEqual(['qwen3-coder:30b'])
  })

  it('reads the list again after a minute, so a model pulled later is used', async () => {
    served = ['qwen3-coder:30b']
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    await ask('qwen3:8b')
    served = ['qwen3-coder:30b', 'qwen3:8b']
    clock.mockReturnValue(now + 61_000)
    await ask('qwen3:8b')
    expect(chats).toEqual(['qwen3-coder:30b', 'qwen3:8b'])
    expect(tagReads).toBe(2)
  })
})
