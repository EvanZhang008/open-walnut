/**
 * CLI: `open-walnut mcp list | <server> tools list | help <tool> | call <tool> '{json}'`.
 *
 * The hub twin of the in-session `walnut mcp` (src/providers/wn-cli.ts): same parsing and output
 * (src/providers/mcp-cli-args.ts), run through the mcp_* ops against the local server. Bare
 * `open-walnut mcp` is still Walnut's own stdio MCP server (./mcp.ts).
 */

import {
  MCP_CLI_HELP, formatMcpServers, formatMcpToolHelp, formatMcpTools, isNotReadOnlyRefusal, parseMcpCliArgs,
} from '../providers/mcp-cli-args.js'

export async function runMcpClient(argv: string[], options: { apiUrl?: string } = {}): Promise<void> {
  const parsed = parseMcpCliArgs(argv)
  if (parsed.kind === 'mcp.usage') {
    if (parsed.message) {
      console.error(`${parsed.message.replace(/walnut mcp/g, 'open-walnut mcp')}\nrun \`open-walnut mcp --help\` for usage`)
      process.exitCode = 2
      return
    }
    console.log(MCP_CLI_HELP.replace(/walnut mcp/g, 'open-walnut mcp'))
    return
  }

  let toolArgs: Record<string, unknown> = {}
  if (parsed.kind === 'mcp.call') {
    const { classifyArgsSource, parseToolArgs } = await import('../providers/tool-args-source.js')
    const source = classifyArgsSource(parsed.rawJson, process.stdin.isTTY === true)
    if (source.kind === 'usage-error') {
      console.error(source.message)
      process.exitCode = 2
      return
    }
    let rawJson = source.kind === 'inline' ? source.json : ''
    try {
      if (source.kind === 'file') rawJson = await (await import('node:fs/promises')).readFile(source.path, 'utf-8')
      else if (source.kind === 'stdin') {
        rawJson = await new Promise<string>((resolve) => {
          let buf = ''
          process.stdin.setEncoding('utf-8')
          process.stdin.on('data', (chunk) => { buf += chunk })
          process.stdin.on('end', () => resolve(buf))
        })
      }
    } catch (err) {
      console.error(`cannot read arguments: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 2
      return
    }
    const args = parseToolArgs(rawJson)
    if (!args.ok) {
      console.error(args.message)
      process.exitCode = 2
      return
    }
    toolArgs = args.args
  }

  const { executeOp } = await import('../ops/index.js')
  const { LOCAL_ORIGIN } = await import('../lib/caller-origin.js')
  const run = (name: string, args: Record<string, unknown>) => executeOp(name, args, {
    origin: LOCAL_ORIGIN, ...(options.apiUrl ? { apiBase: options.apiUrl } : {}),
  })
  let outcome
  if (parsed.kind === 'mcp.servers') outcome = await run('mcp_servers', {})
  else if (parsed.kind === 'mcp.call') {
    const input = { server: parsed.server, tool: parsed.tool, arguments: toolArgs }
    outcome = await run('mcp_read', input)
    if (!outcome.ok && isNotReadOnlyRefusal(outcome.message)) outcome = await run('mcp_call', input)
  } else outcome = await run('mcp_tools', { server: parsed.server })

  if (!outcome.ok) {
    console.error(outcome.message)
    process.exitCode = 1
    return
  }
  if (parsed.kind === 'mcp.servers') console.log(formatMcpServers(outcome.result))
  else if (parsed.kind === 'mcp.tools') console.log(formatMcpTools(outcome.result))
  else if (parsed.kind === 'mcp.help') {
    const help = formatMcpToolHelp(outcome.result, parsed.tool)
    if (help === null) {
      console.error(`${parsed.server} has no tool named ${parsed.tool}; run \`open-walnut mcp ${parsed.server} tools list\``)
      process.exitCode = 1
      return
    }
    console.log(help)
  } else {
    console.log(JSON.stringify(outcome.result, null, 2))
    if ((outcome.result as { isError?: unknown } | undefined)?.isError === true) process.exitCode = 1
  }
}
