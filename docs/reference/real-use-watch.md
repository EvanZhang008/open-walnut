# Real use: watching what ships

Walnut counts how its tools, requests and pages behave in real use, and tells the task that
shipped a change when real use shows a problem with it. Code: `src/core/usage-watch/`.

## What is recorded

On the leader only, in `WALNUT_HOME/local/usage-watch.sqlite` (this machine, never synced):

- **Tool calls.** Every session's Walnut MCP tools and `walnut` CLI reach the server through its
  host daemon's gateway (`sessions/walnut-mcp-mount.ts`), so the gateway's `tools.call`
  (`peers/capability-router.ts`) records each one: the op name, the client (`mcp` or `cli`,
  `unknown` for an older one), how it ended (ok, refused, bad arguments, error, timeout,
  unreachable, from fixed error codes), the time, and the answer's size measured the way the
  client prints it (`lib/tool-answer-size.ts`). An answer over the client's limit counts as
  *over budget*; an MCP answer past `fitToolAnswer`'s cap counts as *spilled* (Walnut's MCP server
  saved it to a file).
- **Confirmed cuts.** Claude Code's own note in a tool result (`exceeds maximum allowed tokens`,
  `Output too large`) is read by the session hook (`usage-watch/session-hook.ts`) and counted on
  the op the call named. Only a confirmed cut rings an alarm.
- **Failed tool calls by session.** Every failed Walnut tool call a session's agent read, on every
  host, as the session hook sees the result (`is_error`, not a replayed line): its session, task,
  host, op, client and an error code read off the result (`toolErrorCode` in
  `usage-watch/normalize.ts`: the CLI's failure JSON, the MCP server's `walnut: <code>:` line, or
  Claude Code's own refusal, such as `no_such_tool` after the MCP link dropped, or no answer at all:
  `no_daemon` for a gateway socket that is gone, `hub_timeout` and `hub_unreachable`). This counts
  what the server never answered too. A report whose range starts before the first recorded failure
  says where its record starts (`dataFrom`). `usage_watch {"action":"errors","by":"op|code|session|host"}`
  reads them grouped; `"session":"<id or its start>"` lists one session's (or task's) one by one
  (`usage-watch/tool-errors.ts`). Kept 14 days, at most 50,000.
- **Requests** from the browser and the phone, by the route template Express matched (an op's own
  call to the API is counted under its tool, a test run's not at all).
- **Page errors**: a failed or timed-out request as its route template, or a thrown error as its
  type and the built code bundle it came from. Never a message, URL, argument or answer.

Hourly rows are kept 30 days, problem events 14 days (at most 5,000), with no session or task id; only the failed tool calls above name their session and task.

## Alarms

`health-monitor/usage-alarms.ts` adds rows to Walnut Health: answers cut, tool errors (fewer for
a watched tool), bad arguments as a share of calls, slow reads, server errors per request, and
page failures. Their action is `route` (`usage-watch/route.ts`): the armed watch whose ship is the
latest owns the target; a complete owner's project lead hears it instead (an automated note never
reopens a task); with no watch, the Walnut project's lead; with no lead, the fix-task way. A
recipient gets the day's first note at once and the rest at most every 4 hours, each note row
written before it is sent and marked sent only after the session took it.

A page failure rings only for one cause the page alone can see. A request that never reached the
server never rings: one the page's connection queue gave up on (`rejected`), and one that failed
with a network error (`failed`: the server was down, restarting or asleep, or the network was), whose
cause rings on its own or is not Walnut's; nor does a failure of a request whose route already rings
for server errors. A request the browser itself refused (`refused by the browser`: no network error
in its error text) is the page's own fault and rings like a thrown error. A request that timed out
waits one minute: one route timing out alone rings by its route; when three or more different
requests timed out within a minute of it, the server or the network stalled, and that stall counts
once as `page requests timed out together` (so a stall that recurs rings as one note); within two
minutes of the server's start it rings nothing. All of them still show in the Page errors table.
2026-11-22, replayed on the day's 360 page failures: 11 kinds rang before, 1 rings now (the threads
route timing out, which was also a slow read).

## Watches and the completion check

A task that ships (a land, deploy, push to main or publish its session ran, or `usage_watch`
`ship`) names what real use should show: `usage_watch {"action":"set","targets":[...],"checks":{...}}`.
At its check time each target is judged (Passed, Failed, Too little use, Unknown) and the verdict
goes to the task, or to its lead when it is complete. `admitSessionClose` refuses a task's own
session closing it after it shipped with no watch and no exemption (`usage-watch/gate.ts`); its
lead or a person closing it is not held, and such a close with nothing named is recorded as
`unwatched` on the page (the gap shows; nothing is refused). A ship is a command the session ran (its first word, as
a shell reads the line), never a word a command only reads or prints. An
exemption (`usage_watch {"action":"exempt","kind":...,"reason":...}`) names its kind: `copy`,
`colour`, `docs` or `tests` (nothing in real use can show it), `not_shipped`, or
`watched_elsewhere` (real use is watched outside Walnut, a pipeline alarm or a dashboard; the
reason says what watches it, who reads it and when). A Walnut trigger that checks the change
counts as a watch too.

The alarms' notes, the completion check and the prompt's rule line are behind the experimental
flag `real_use_watch` (off by default); recording and the Settings › Diagnostics › Real Use page
are always on.
