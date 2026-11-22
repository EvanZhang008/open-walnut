/**
 * Real tool results whose answer the agent's harness found too long (Claude Code
 * transcripts, versions 2.1.284 to 2.1.322), with the paths made generic. The
 * harness saved each answer to a file and gave the model a note instead; the call
 * itself succeeded. READ_TOO_BIG is the look-alike that IS a failure: the Read tool
 * refused to read a file over its limit.
 */
const DIR = '/home/user/.claude/projects/-home-user-repo/ed151aa0-42ad-4c78-95d4-71db828f415e/tool-results'

/** The CLI's tail after the first sentence (abridged): a format line, a hint, the requirements block. */
const TAIL = '\nFormat: JSON array with schema: [{type: string, text: string}]\n'
  + 'Use offset and limit parameters to read specific portions of the file, or use jq to query it.\n'
  + 'REQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n- You MUST read the content from the file in chunks.'

/** An MCP answer on one line (a Walnut tool, host_list). */
export const MCP_ONE_LINE = `Error: result (43,240 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${DIR}/mcp-walnut-host_list-1795294265752.txt.${TAIL}`

/** An MCP answer over many lines (board_get), with a reminder that rode along. */
export const MCP_MANY_LINES = `Error: result (165,884 characters across 5,303 lines) exceeds maximum allowed tokens. Output has been saved to ${DIR}/mcp-walnut-board_get-1795000000000.txt.\nFormat: Plain text${TAIL}\n\n<system-reminder>\nA background task finished.\n</system-reminder>`

/** Another MCP server's answer, no line count (the wording is the CLI's for every server). */
export const MCP_NO_LINE_COUNT = `Error: result (945,049 characters) exceeds maximum allowed tokens. Output has been saved to ${DIR}/mcp-docs-read_page-1794000000000.txt.${TAIL}`

/** The same note without the "Error: " prefix. */
export const MCP_NO_PREFIX = `result (49,128 characters) exceeds maximum allowed tokens. Output has been saved to ${DIR}/mcp-walnut-task_list-1795100000000.txt.${TAIL}`

/** A Bash output saved to a file, with a preview (never worded as an error). */
export const BASH_PERSISTED = `<persisted-output>\nOutput too large (10.5KB). Full output saved to: ${DIR}/b81xo6s6w.txt\n\nPreview (first 2KB):\ntotal 48\ndrwxr-xr-x  12 user  staff  384 Nov 20 10:00 .\n...\n</persisted-output>`

/** The Read tool refusing a file over its limit: a real failure, as the CLI's toolUseResult holds it. */
export const READ_TOO_BIG = 'Error: File content (46566 tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.'

/** The same failure as the transcript's tool_result block holds it (no prefix, is_error true). */
export const READ_TOO_BIG_BLOCK = READ_TOO_BIG.replace(/^Error: /, '')
