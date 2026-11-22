# Walnut tools: groups and what each session lists

Every Walnut operation (an op) is one tool on every surface: the MCP tool `mcp__walnut__<op>`,
`walnut tools call <op>` in a shell, and `tool_call` on a `--core` mount. There are about 190
core ops plus each plugin's own, too many for one flat list, so every op belongs to exactly one
group.

## What an agent reads back

Every op answers an agent caller under an answer policy (`src/ops/answer.ts`): a write answers a
receipt (2,000 characters by default), a read answers content (8,000 by default, an op may declare
up to 24,000), an op's `shape` builds its compact form, and `"_full": true` lifts the cap for one call.
The cap also depends on where the answer is printed (`ANSWER_SURFACES`): an MCP tool's answer is
compact JSON held to 24,000 characters (its client keeps about 25,000); `walnut tools call` prints
pretty JSON into a shell that keeps about 10 KB, so its answer is held to 8,000 bytes of that print.
An answer is held to the smaller of the op's cap and its surface's. A shape builds for the cap it is
given (a document's page, a host_exec window, a page of rows) and builds again for a smaller one when
its answer prints over, so a page and its "read on" offset agree; the generic cut handles the rest.

The surface rides every call: the hub's MCP server says `mcp`, the CLI says `cli`, and a gateway
`tools.call` names its client (`client: "mcp" | "cli"`, set by `walnut mcp-server`, `walnut tools call`
and the daemon's minimal fallback CLI). A request that names none (an older CLI or daemon) is held to
the CLI's smaller cap. Guard: `tests/mcp/answer-policy.test.ts` holds every op on every surface to its
limit, printed the way that surface prints it, and pages documents to the end on both.

## Groups

The table is `src/ops/op-groups.ts`: a core op is placed by its exact name or its family's name
prefix (`trigger_`, `board_`), and a plugin op is in `plugin:<plugin id>`. A new core op that no
group holds fails `tests/unit/ops/op-groups.test.ts`, so it is placed when it is added.

Where the groups show:

- `walnut tools list` prints the catalog by group, each with what it is for;
  `walnut tools list --group board` prints one group (`--group plugin` every plugin's).
  The in-session CLI gets the groups from the server's `tools.list` answer (each row's `group`
  and the answer's `groups`); an older server sends none and the list stays flat.
- `tool_help` (on a `--core` mount) with no arguments lists every tool name, one line per group;
  `group=<group>` adds that group's titles; `name=<tool>` shows one tool's arguments.
- `walnut tools list --json` keeps its rows (each now with a `group`); nothing in the repo parses
  the table, and the minimal JS-fallback CLI on an old host keeps its flat list.

## What a session lists (experiment `mcp_tools_by_role`)

Off by default (Settings, Experimental). On, a Claude Code session lists only its role's groups:

| Role | Who | Lists |
|---|---|---|
| worker | an ordinary task session | tasks, lookup, memory, notes, hosts (with a host's MCP servers and HTTP), triggers, subagents, browser, board, plus `thread_list` and `human_inbox_send`; the tools of the plugin its task comes from |
| thread_keeper | a task that keeps Threads (not an org node) | the worker's, and threads |
| org | Main, a VP, an Ask of the Personal AI | the worker groups and threads, inbox, brief, org, task_admin, alarms, and every plugin's tools |
| router | a router session | its own four ops, as before (`src/core/router/gateway-policy.ts`) |

Plugin tools: a plugin is one the user installed and turned on for himself, and Main, the VPs and
his asks are where his requests about it land, so the org lists every plugin's tools. A worker
lists a plugin's tools only when its task comes from that plugin (`Task.source`, the plugin that
syncs its project); no prompt names plugin tools, so there is no narrower signal. Any other plugin
tool a worker reaches with `walnut tools call`.

Counted from the table on 2026-11-22: of 192 core ops a worker lists 77, a thread keeper 83, an org
node 118 (117 on another host, which refuses one local-only op), plus the plugin tools above.

Guard: `tests/core/sessions/tool-listing-role.test.ts` builds every always-loaded prompt block
(`src/core/sessions/prompt-blocks.ts`) and renders every built-in message hint
(`src/core/hints/hint-registry.ts`), and fails when one names an op a role that reads it does not
list, or when a new block or hint kind has no entry there.

It is listing only. No call is ever refused for a role: the host server (`walnut mcp-server`)
relays any name to the gateway, the hub server's CallTool handler runs any op as it runs a
deprecated one, and the CLI runs every op. Claude Code itself cannot call an MCP tool it was not
given, so for a session the way to an unlisted tool is the CLI: the MCP instructions say so in one
line ("use the CLI ... to reach a tool not listed here (`walnut tools list` shows every tool by
group)"), worded to be true with the experiment off too. A session that still calls an unlisted
MCP tool is told the CLI form once (`src/core/sessions/missing-walnut-tool.ts`).

How the role reaches each server:

- The host server asks the gateway for `tools.list {schemas: true, listing: 'role'}`; the server
  reads the caller's task (`src/core/sessions/tool-listing-role.ts`) and filters the list. A host
  server from before this change never sends `listing`, so it keeps listing everything.
- The hub mount (`open-walnut mcp`) of a Personal AI lane (Main, an ask, a console agent) carries
  `WALNUT_MCP_ROLE=org` (`personalAiMcpProfile()`, `walnutMcpProfile({ role })`) and reads the
  experiment from config.yaml at its start (`src/commands/mcp.ts`). Every other use of the hub
  mount (an ordinary task on the old opt-in mount, an ACP engine) has no role and lists everything,
  and `--core` wins over a role.

A session keeps the list it read at its MCP server's start: turning the experiment on or off
reaches it at its next start. A stored profile from before this change has no `WALNUT_MCP_ROLE`,
so a long-running Main lists everything until its lane profile is built again.
