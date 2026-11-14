/**
 * E2E: Settings' "Test connection" for Ollama (POST /api/config/test-provider) on a
 * real server, against a stand-in Ollama on a random port that speaks the two
 * endpoints Walnut uses (GET /api/tags, POST /v1/chat/completions). Before
 * 2026-10-30 it answered 'Testing not yet supported for protocol "ollama"', though
 * GETTING_STARTED Path D tells a local model user to verify with it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'

import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-test-provider-local'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { updateConfig } from '../../src/core/config-manager.js'

let server: HttpServer
let port = 0
let ollama: http.Server
let ollamaUrl = ''
const chats: Array<{ model: string; max_tokens?: number }> = []

beforeAll(async () => {
  ollama = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }, { name: 'qwen3:8b' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body) as { model: string; max_tokens?: number }
        chats.push({ model: parsed.model, max_tokens: parsed.max_tokens })
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', created: 0, model: parsed.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }))
      })
      return
    }
    res.writeHead(404); res.end('{}')
  })
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()))
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`

  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await new Promise<void>((r) => ollama.close(() => r()))
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function testProvider(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; model?: string; latencyMs?: number }> {
  const res = await fetch(`http://localhost:${port}/api/config/test-provider`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  expect(res.ok).toBe(true)
  return res.json()
}

describe('POST /api/config/test-provider for Ollama', () => {
  it('sends one short request to the configured main model and reports it', async () => {
    await updateConfig({
      agent: { main_provider: 'ollama', main_model: 'qwen3-coder:30b' },
      providers: { ollama: { api: 'ollama', base_url: ollamaUrl } },
      defaults: { engine: 'opencode' },
    } as never)
    chats.length = 0
    const r = await testProvider({ provider_name: 'ollama' })
    expect(r).toMatchObject({ ok: true, model: 'qwen3-coder:30b' })
    expect(typeof r.latencyMs).toBe('number')
    expect(chats).toEqual([{ model: 'qwen3-coder:30b', max_tokens: 1 }])
  })

  it('a main model the server does not have is named, with the pull command, and nothing is sent', async () => {
    await updateConfig({ agent: { main_provider: 'ollama', main_model: 'qwen2.5:7b' } } as never)
    chats.length = 0
    const r = await testProvider({ provider_name: 'ollama' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ollama pull qwen2.5:7b')
    expect(chats).toEqual([])
  })

  it('with only main_provider set (main_model unset), it says to set the model, and sends nothing', async () => {
    await updateConfig({ agent: { main_provider: 'ollama' } } as never)
    chats.length = 0
    const r = await testProvider({ provider_name: 'ollama' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('agent.main_model')
    expect(r.error).not.toContain('ollama pull')
    expect(chats).toEqual([])
  })

  it('a server that is down answers at once with its address', async () => {
    const dead = http.createServer()
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()))
    const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`
    await new Promise<void>((r) => dead.close(() => r()))
    const t0 = Date.now()
    const r = await testProvider({ provider_name: 'ollama', provider_config: { api: 'ollama', base_url: deadUrl } })
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(r.ok).toBe(false)
    expect(r.error).toContain(`Ollama is not answering at ${deadUrl}`)
  })
})
