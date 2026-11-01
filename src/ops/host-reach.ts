import { z } from 'zod';
import { defineOp } from './registry.js';
import { withOutcome } from './outcome.js';

const GRANT_NOTE = 'The first call for this task on a host asks the user by letter (403 exec_grant_required), the same grant host_exec uses: '
  + 'do other work, you get a notice when they allow it.'

/** An MCP answer in a line: still running, the tools, or the call's result. */
function mcpOutcome(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>
  const images = Array.isArray(b.images) ? b.images as Array<{ path?: string; pending?: boolean }> : []
  const saved = images.filter((i) => i.path && !i.pending).map((i) => i.path)
  const pending = images.filter((i) => i.path && i.pending).map((i) => i.path)
  const unsaved = images.filter((i) => !i.path).length
  if (b.running) {
    return withOutcome(b, `Still running on ${String(b.host)} as call ${String(b.callId)}.`, 'host_mcp_result with this call_id and wait_ms returns the answer; never call it again.')
  }
  if (Array.isArray(b.tools)) {
    return withOutcome(b, `${b.tools.length} tool(s) on ${String(b.server)} on ${String(b.host)}.`, 'host_mcp_call with one of them and its inputSchema.')
  }
  const notes = [
    b.isError ? 'The tool reported an error.' : '',
    b.truncated ? 'Only the first 512 KB of its text is here.' : '',
    b.redactedLines ? `${String(b.redactedLines)} line(s) that looked like a credential were hidden.` : '',
    saved.length ? `Image(s) saved: ${saved.join(', ')} (open with your Read tool).` : '',
    pending.length ? `Image(s) still being written, there in a few seconds: ${pending.join(', ')} (if one never appears, read this call again with host_mcp_result).` : '',
    unsaved ? `${unsaved} image(s) came back as their size only (too big together, or your task directory could not be written).` : '',
  ].filter(Boolean).join(' ')
  return withOutcome(b, `${String(b.server)} ${String(b.tool)} on ${String(b.host)} answered after ${String(b.ms)} ms.${notes ? ` ${notes}` : ''}`, 'Read text (and structured).')
}

defineOp({
  name: 'host_mcp_list',
  title: 'List the MCP servers on another host',
  description:
    'The MCP servers configured on ANOTHER host Walnut knows (host_list names the hosts): the ones Claude Code there would load, the user\'s, '
    + 'the enabled plugins\' (named plugin:<plugin>:<server>) and, with `cwd`, that project\'s. Use one when only that host has it: its sign-in, '
    + 'its network, its files. First come the servers the user offers other hosts on purpose (scope "walnut", maybe with a one-word capability '
    + 'and a description). Names only, no grant needed (with `cwd` it needs the grant). Never your own host '
    + '(use your own MCP tools).',
  input: {
    host: z.string().min(1).describe('Host alias ("__local__" = the Mac) or a selector like "@ios"'),
    cwd: z.string().optional().describe('A project folder on that host, to include its own servers'),
  },
  bind: { method: 'GET', path: '/hosts/:host/mcp' },
  // The route dials the host and answers within the relayed caller's hold (about 14 s).
  timeoutMs: 60_000,
  mapResult: ({ body }) => withOutcome(body as Record<string, unknown>, `${((body as { servers?: unknown[] })?.servers ?? []).length} MCP server(s).`, 'host_mcp_tools lists one server\'s tools.'),
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_mcp_tools',
  title: 'List one MCP server\'s tools on another host',
  description:
    'The tools an MCP server on another host offers, with their inputSchema; the server starts there when it is not running (one per task, '
    + 'stopped after 10 idle minutes). ' + GRANT_NOTE + ' From a session on another host the call holds about 14 seconds: a server still '
    + 'starting comes back running:true with a call_id for host_mcp_result.',
  input: {
    host: z.string().min(1).describe('The host the server is on'),
    server: z.string().min(1).describe('The server name host_mcp_list gave'),
    cwd: z.string().optional().describe('The project folder the server belongs to (and runs in)'),
  },
  bind: { method: 'GET', path: '/hosts/:host/mcp/:server/tools' },
  timeoutMs: 3 * 60_000,
  mapResult: ({ body }) => mcpOutcome(body),
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_mcp_call',
  title: 'Call an MCP tool on another host',
  description:
    'Call one tool of an MCP server on ANOTHER host and get its answer: the server runs there, with that host\'s sign-in and config, which '
    + 'never leave it. ' + GRANT_NOTE + ' A call ends by timeout_ms (default 60 s, at most 10 min). It waits for the answer, from a session '
    + 'on another host at most about 14 seconds: a call still going comes back running:true with its call_id, and host_mcp_result with wait_ms '
    + 'reads it (never call it again). Up to 4 calls at once per task. Text comes back (512 KB at most); images are saved in your '
    + 'task directory and their paths given; lines that look like a credential are hidden.',
  input: {
    host: z.string().min(1).describe('The host the server is on'),
    server: z.string().min(1).describe('The server name host_mcp_list gave'),
    tool: z.string().min(1).describe('The tool name host_mcp_tools gave'),
    arguments: z.record(z.string(), z.unknown()).optional().describe('The tool\'s arguments, as its inputSchema says'),
    cwd: z.string().optional().describe('The project folder the server belongs to (and runs in)'),
    timeout_ms: z.number().int().min(1).max(600_000).optional().describe('Deadline in ms (default 60000, at most 600000)'),
  },
  bind: { method: 'POST', path: '/hosts/:host/mcp/:server/call' },
  timeoutMs: 11 * 60_000,
  mapResult: ({ body }) => mcpOutcome(body),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_mcp_result',
  title: 'Read an MCP call\'s answer on another host',
  description: 'The answer of a host_mcp_call or host_mcp_tools that came back running:true. `wait_ms` holds it until the answer is there '
    + '(up to 60000; about 12000 from a session on another host). An answer is kept 10 minutes; only the task that started the call reads it.',
  input: {
    host: z.string().min(1).describe('The host the call runs on'),
    call_id: z.string().min(1).describe('The callId the call returned'),
    wait_ms: z.number().int().min(0).max(60_000).optional().describe('Wait up to this long for the answer'),
  },
  bind: { method: 'GET', path: '/hosts/:host/mcp-calls/:call_id' },
  timeoutMs: 2 * 60_000,
  mapResult: ({ body }) => mcpOutcome(body),
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
});

defineOp({
  name: 'host_http',
  title: 'Make a web request from another host',
  description:
    'One HTTP request made FROM another host Walnut knows, for a web service only it reaches: a dev server on its localhost '
    + '(http://localhost:3000/...), a service on its own network. ' + GRANT_NOTE + ' http and https only; redirects are followed; it ends by '
    + 'timeout_ms (default 30 s, at most 5 min; about 12 s from a session on another host). Up to 256 KB of the body comes back, text as '
    + '`body`, anything else as `bodyBase64`; Set-Cookie values and lines that look like a credential are hidden. Never your own host (use curl).',
  input: {
    host: z.string().min(1).describe('Host alias ("__local__" = the Mac) or a selector like "@ios"'),
    url: z.string().min(1).describe('The full address as that host sees it, e.g. http://localhost:3000/api/health'),
    method: z.string().optional().describe('GET (default), HEAD, POST, PUT, PATCH, DELETE or OPTIONS'),
    headers: z.record(z.string(), z.string()).optional().describe('Request headers'),
    body: z.string().optional().describe('A text body (POST, PUT, PATCH)'),
    body_base64: z.string().optional().describe('Instead of body: the bytes, base64'),
    timeout_ms: z.number().int().min(1).max(300_000).optional().describe('Deadline in ms (default 30000)'),
  },
  bind: { method: 'POST', path: '/hosts/:host/http' },
  timeoutMs: 6 * 60_000,
  mapResult: ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>
    const notes = [b.truncated ? 'Only the first 256 KB of the body is here.' : '', b.redactedLines ? `${String(b.redactedLines)} line(s) that looked like a credential were hidden.` : ''].filter(Boolean).join(' ')
    return withOutcome(b, `HTTP ${String(b.status)} from ${String(b.url)} via ${String(b.host)} after ${String(b.ms)} ms.${notes ? ` ${notes}` : ''}`, 'Read status, headers and body.')
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
});
