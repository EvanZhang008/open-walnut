/**
 * The claude-cli adapter passes pictures only when the caller asks (`images: 'send'`): such a call
 * whose user messages carry image blocks runs with `--input-format stream-json` and writes ONE
 * stream-json user line (the image blocks, then the same text as one block). Every other call,
 * pictures or not (the Personal AI replaying a history with hydrated pictures), keeps the default
 * text input byte for byte: the argv and stdin it always had. Tool-result pictures stay flattened.
 * And the drawing's diagram call on the claude-code provider reaches the CLI with its picture.
 *
 * `claude` is a fake script that records its argv and stdin and answers one stream-json result.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('cli-images'))
const cfg = vi.hoisted(() => ({ command: '' }))
vi.mock('../../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/config-manager.js')>()),
  getConfig: async () => ({
    version: 1, user: {},
    agent: { main_provider: 'claude_cli' },
    providers: { claude_cli: { api: 'claude-cli', claude_cli_command: cfg.command } },
  }),
}))

import { ClaudeCliAdapter, cliTurnInput, promptImages, serializePrompt } from '../../../src/model/providers/adapter-claude-cli.js'
import type { AdapterCallOptions } from '../../../src/model/providers/types.js'
import { streamJsonUserLine } from '../../../src/providers/stream-json-input.js'
import { makeDiagram } from '../../../src/core/drawings/diagram.js'
import { __setSharpForTests } from '../../../src/utils/image-compress.js'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }

let dir = ''
let fake = ''
const argvOf = () => fs.readFileSync(path.join(dir, 'argv.log'), 'utf8').split('\0').filter(Boolean)
const stdinOf = () => fs.readFileSync(path.join(dir, 'stdin.log'), 'utf8')

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cli-images-'))
  fake = path.join(dir, 'fake-claude.sh')
  fs.writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\0' "$@" > ${JSON.stringify(path.join(dir, 'argv.log'))}
cat > ${JSON.stringify(path.join(dir, 'stdin.log'))}
cat ${JSON.stringify(path.join(dir, 'result.jsonl'))}
`, { mode: 0o755 })
  const answer = JSON.stringify([{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, label: { text: 'A' } }])
  fs.writeFileSync(path.join(dir, 'result.jsonl'), `${JSON.stringify({ type: 'result', subtype: 'success', result: answer, usage: { input_tokens: 3, output_tokens: 2 } })}\n`)
  cfg.command = fake
})

afterAll(() => {
  __setSharpForTests(undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(path.join(dir, 'argv.log'), { force: true })
  fs.rmSync(path.join(dir, 'stdin.log'), { force: true })
})

const call = (messages: AdapterCallOptions['messages'], extra: Partial<AdapterCallOptions> = {}): AdapterCallOptions => ({
  providerConfig: { api: 'claude-cli', claude_cli_command: fake },
  model: 'haiku', maxTokens: 64, system: 'Describe pictures.', messages, ...extra,
})

describe('claude-cli adapter input', () => {
  it('keeps a text-only prompt in the default text input, byte for byte', async () => {
    const messages: AdapterCallOptions['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }]
    await new ClaudeCliAdapter().sendMessage(call(messages))
    expect(argvOf()).not.toContain('--input-format')
    expect(stdinOf()).toBe(serializePrompt(messages))
    expect(cliTurnInput('x', messages, 'send')).toEqual({ args: [], input: 'x' })
  })

  it('keeps a prompt with pictures in the text input when the caller did not ask to send them', async () => {
    // A fresh replay of a history whose pictures were hydrated (the Personal AI): the argv and
    // stdin are exactly the text-only form, as before pictures could go to the CLI.
    const messages = [
      { role: 'user', content: [image, { type: 'text', text: 'What is this?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'A box.' }] },
      { role: 'user', content: [{ type: 'text', text: 'And now?' }, image] },
    ] as AdapterCallOptions['messages']
    const textOnly: AdapterCallOptions['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }]
    await new ClaudeCliAdapter().sendMessage(call(textOnly))
    const textArgv = argvOf()
    await new ClaudeCliAdapter().sendMessage(call(messages))
    const argv = argvOf()
    expect(argv).not.toContain('--input-format')
    // The same argv as a text-only call, but the minted session id at the end.
    expect(argv.at(-2)).toBe('--session-id')
    expect(argv.slice(0, -1)).toEqual(textArgv.slice(0, -1))
    expect(stdinOf()).toBe(serializePrompt(messages))
    expect(cliTurnInput('p', messages)).toEqual({ args: [], input: 'p' })
  })

  it('sends a prompt with a picture as one stream-json user line with the image block, then closes stdin', async () => {
    const messages = [{ role: 'user', content: [image, { type: 'text', text: 'What is this?' }] }] as AdapterCallOptions['messages']
    const r = await new ClaudeCliAdapter().sendMessage(call(messages, { images: 'send' }))
    expect(r.content).toHaveLength(1)
    const argv = argvOf()
    expect(argv.slice(argv.indexOf('--input-format'), argv.indexOf('--input-format') + 2)).toEqual(['--input-format', 'stream-json'])
    expect(argv.slice(argv.indexOf('--output-format'), argv.indexOf('--output-format') + 2)).toEqual(['--output-format', 'stream-json'])
    const stdin = stdinOf()
    expect(stdin).toBe(streamJsonUserLine([image, { type: 'text', text: 'User: What is this?' }]))
    expect(stdin.split('\n')).toEqual([expect.any(String), ''])
    expect(JSON.parse(stdin)).toEqual({ type: 'user', message: { role: 'user', content: [image, { type: 'text', text: 'User: What is this?' }] } })
  })

  it('leaves tool-result pictures, url sources and unknown types out of the image blocks', () => {
    const messages = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [image] }] },
      { role: 'assistant', content: [image as never] },
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x.example/a.png' } }, { type: 'image', source: { type: 'base64', media_type: 'image/tiff', data: 'AA' } }] },
    ] as AdapterCallOptions['messages']
    expect(promptImages(messages)).toEqual([])
    expect(cliTurnInput('p', messages, 'send').args).toEqual([])
  })
})

describe('diagram on the claude-code provider', () => {
  it('reaches the CLI with the picture of the selection', async () => {
    const toBuffer = vi.fn(async () => Buffer.from('sketch-png'))
    __setSharpForTests((() => ({ resize: () => ({ png: () => ({ toBuffer }) }) })) as never)
    const result = await makeDiagram({ mode: 'tidy', elements: [{ id: 's', type: 'freedraw', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [10, 10]] }] })
    expect(result.elements).toEqual([{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, label: { text: 'A' } }])
    expect(argvOf()).toContain('--input-format')
    const line = JSON.parse(stdinOf())
    expect(line.message.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('sketch-png').toString('base64') } })
    expect(line.message.content[1].text).toContain('"id":"s"')
  })
})
