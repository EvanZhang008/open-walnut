// A stdio MCP server for the host_mcp tests (src/providers/host-mcp-core.ts): newline JSON-RPC,
// a junk line before the first message (as a login shell's greeting would be), a roots/list
// request to the client, tools over two pages, and tools that echo, wait, read the env, crash,
// return an image, and return a credential-looking line. No dependencies.
'use strict'
const readline = require('node:readline')

process.stdout.write('welcome from a login shell\n')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const TOOLS = [
  { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'slow', description: 'Answer after ms', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'env', description: 'Read an env var', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'crash', description: 'Exit at once' },
  { name: 'image', description: 'A tiny image' },
  { name: 'secret', description: 'A line that looks like a token' },
  { name: 'fails', description: 'A tool error' },
  { name: 'cjk', description: 'A long answer of multi-byte characters' },
  { name: 'crashleak', description: 'Print a token-like line to stderr, then exit' },
]
// Random bytes made up at each run, shaped like a GitHub token so the redaction scanner sees one: never a credential.
const FAKE_TOKEN = 'ghp_' + require('node:crypto').randomBytes(27).toString('base64url').replace(/[-_]/g, 'x').slice(0, 36)
let askedRoots = false
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id === 'roots-1') { askedRoots = true; return }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
    send({ jsonrpc: '2.0', id: 'roots-1', method: 'roots/list' })
    return
  }
  if (m.method === 'tools/list') {
    const page = m.params && m.params.cursor === 'p2' ? 2 : 1
    send({ jsonrpc: '2.0', id: m.id, result: page === 1 ? { tools: TOOLS.slice(0, 3), nextCursor: 'p2' } : { tools: TOOLS.slice(3) } })
    return
  }
  if (m.method === 'tools/call') {
    const a = m.params.arguments || {}
    const text = (t) => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: t }] } })
    switch (m.params.name) {
      case 'echo': return text(`echo: ${a.text} (pid ${process.pid}, roots asked ${askedRoots}, cwd ${process.cwd()})`)
      case 'slow': return setTimeout(() => text(`slept ${a.ms}`), a.ms)
      case 'env': return text(String(process.env[a.name] ?? '(unset)'))
      case 'crash': process.stderr.write('fake server: crashing on purpose\n'); return process.exit(7)
      case 'image': return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(300).toString('base64') }, { type: 'text', text: 'one image' }] } })
      case 'secret': return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'before\ntoken=' + FAKE_TOKEN + '\nafter' }], structuredContent: { ok: true } } })
      case 'cjk': return text('\u4e2d\u6587\ud83d\ude00'.repeat(a.count || 50000))
      case 'crashleak': process.stderr.write('boot failed with token=' + FAKE_TOKEN + '\n'); return process.exit(9)
      case 'fails': return send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'it went wrong' }] } })
      default: return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool ${m.params.name}` } })
    }
  }
  if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } })
})
rl.on('close', () => process.exit(0))
