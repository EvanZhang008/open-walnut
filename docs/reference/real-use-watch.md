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
- **Requests** from the browser and the phone, by the route template Express matched (an op's own
  call to the API is counted under its tool, a test run's not at all).
- **Page errors**: a failed or timed-out request as its route template, or a thrown error as its
  type and the built code bundle it came from. Never a message, URL, argument or answer.

Hourly rows are kept 30 days, problem events 14 days (at most 5,000), with no session or task id.

## Alarms

`health-monitor/usage-alarms.ts` adds rows to Walnut Health: answers cut, tool errors (fewer for
a watched tool), bad arguments as a share of calls, slow reads, server errors per request, and
page failures. Their action is `route` (`usage-watch/route.ts`): the armed watch whose ship is the
latest owns the target; a complete owner's project lead hears it instead (an automated note never
reopens a task); with no watch, the Walnut project's lead; with no lead, the fix-task way. A
recipient gets the day's first note at once and the rest at most every 4 hours, each note row
written before it is sent and marked sent only after the session took it.

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
