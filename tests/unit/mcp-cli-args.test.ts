/**
 * `walnut mcp …` parsing and output (src/providers/mcp-cli-args.ts), shared by the in-session CLI
 * and the hub CLI, plus the env allowlist an MCP server process starts with.
 */
import { describe, it, expect } from 'vitest'
import {
  formatMcpServers, formatMcpToolHelp, formatMcpTools, isNotReadOnlyRefusal, parseMcpCliArgs,
} from '../../src/providers/mcp-cli-args.js'
import { mcpServerEnv } from '../../src/core/mcp-servers/env.js'

describe('parseMcpCliArgs', () => {
  it.each([
    [[], { kind: 'mcp.usage' }],
    [['--help'], { kind: 'mcp.usage' }],
    [['help'], { kind: 'mcp.usage' }],
    [['list'], { kind: 'mcp.servers' }],
    [['chat'], { kind: 'mcp.usage', message: 'expected `walnut mcp chat tools list | help | call`' }],
    [['chat', 'tools'], { kind: 'mcp.tools', server: 'chat' }],
    [['chat', 'tools', 'list'], { kind: 'mcp.tools', server: 'chat' }],
    [['chat', 'tools', 'help', 'search'], { kind: 'mcp.help', server: 'chat', tool: 'search' }],
    [['chat', 'tools', 'call', 'search'], { kind: 'mcp.call', server: 'chat', tool: 'search', rawJson: undefined }],
    [['chat', 'tools', 'call', 'search', '{"q":"x"}'], { kind: 'mcp.call', server: 'chat', tool: 'search', rawJson: '{"q":"x"}' }],
    [['chat', 'tools', 'call', 'search', '-'], { kind: 'mcp.call', server: 'chat', tool: 'search', rawJson: '-' }],
    [['chat', 'tools', 'call', 'search', '--help'], { kind: 'mcp.help', server: 'chat', tool: 'search' }],
  ] as const)('%j', (argv, expected) => {
    expect(parseMcpCliArgs([...argv])).toEqual(expected)
  })

  it.each([
    [['list', 'extra'], /unexpected argument: extra/],
    [['--json'], /unknown flag: --json/],
    [['chat', 'tools', 'list', 'x'], /unexpected argument: x/],
    [['chat', 'tools', 'help'], /requires <tool>/],
    [['chat', 'tools', 'call'], /requires <tool>/],
    [['chat', 'tools', 'call', 'search', '{"a":1}', '{"b":2}'], /ONE JSON object/],
    [['chat', 'tools', 'run'], /unknown tools subcommand: run/],
  ] as const)('%j is a usage error', (argv, message) => {
    const parsed = parseMcpCliArgs([...argv])
    expect(parsed.kind).toBe('mcp.usage')
    expect(parsed.kind === 'mcp.usage' && parsed.message).toMatch(message)
  })
})

describe('formatters', () => {
  it('servers: state, tool count, what sessions may call, the error on its own line', () => {
    expect(formatMcpServers({ servers: [] })).toMatch(/No MCP servers are registered/)
    expect(formatMcpServers({
      servers: [
        { name: 'chat', state: 'ready', toolCount: 12, sessions: 'read-only', owner: 'chat-plugin' },
        { name: 'docs', state: 'failed', sessions: 'all', owner: 'docs-plugin', lastError: 'could not start' },
      ],
    })).toBe([
      'chat  ready, 12 tools  sessions: read-only  (plugin chat-plugin)',
      'docs  failed  sessions: all  (plugin docs-plugin)\n    could not start',
    ].join('\n'))
  })

  it('tools: aligned names, ro/rw, first non-empty description line, long lines cut', () => {
    const out = formatMcpTools({
      tools: [
        { name: 'search', readOnly: true, description: '\n  Find messages.\nMore detail.' },
        { name: 'post_message', readOnly: false, description: 'x'.repeat(150) },
        { name: 'bare' },
      ],
    })
    const lines = out.split('\n')
    expect(lines[0]).toBe('search        ro  Find messages.')
    expect(lines[1]!.startsWith('post_message  rw  ')).toBe(true)
    expect(lines[1]!.endsWith('…')).toBe(true)
    expect(lines[1]!.length).toBe('post_message  rw  '.length + 100)
    expect(lines[2]).toBe('bare          rw  ')
    expect(formatMcpTools({ tools: [] })).toMatch(/lists no tools/)
  })

  it('tool help: kind, description, schema; null for a tool that is not there', () => {
    const result = {
      tools: [
        { name: 'search', readOnly: true, description: 'Find.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
        { name: 'wipe', readOnly: false, destructive: true, description: 'Delete.' },
        { name: 'post', readOnly: false, description: 'Post.' },
      ],
    }
    const help = formatMcpToolHelp(result, 'search')!
    expect(help.split('\n')[0]).toBe('search (read-only)')
    expect(help).toContain('"q": {')
    expect(formatMcpToolHelp(result, 'wipe')!.split('\n')[0]).toBe('wipe (changes or deletes something)')
    expect(formatMcpToolHelp(result, 'post')!.split('\n')[0]).toBe('post (changes something)')
    expect(formatMcpToolHelp(result, 'missing')).toBeNull()
  })

  it('a not-read-only refusal is recognised from the op error sentence', () => {
    expect(isNotReadOnlyRefusal('Walnut API error (mcp_tool_not_read_only): post changes something')).toBe(true)
    expect(isNotReadOnlyRefusal('Walnut API error (mcp_not_exposed): …')).toBe(false)
  })
})

describe('mcpServerEnv', () => {
  it('keeps the allowlist and what the plugin passes, drops everything else', () => {
    const env = mcpServerEnv({ PLUGIN_TOKEN_PATH: '/x' }, {
      HOME: '/home/u', PATH: '/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', https_proxy: 'http://p:1', NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
      ANTHROPIC_API_KEY: 'sk-ant', AWS_SECRET_ACCESS_KEY: 's', AWS_BEARER_TOKEN_BEDROCK: 'b', OPEN_WALNUT_API_URL: 'http://x',
      UNDEFINED_ONE: undefined,
    })
    expect(env).toEqual({
      HOME: '/home/u', PATH: '/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', https_proxy: 'http://p:1', NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/ca.pem', PLUGIN_TOKEN_PATH: '/x',
    })
  })
})
