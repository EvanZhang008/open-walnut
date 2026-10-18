#!/usr/bin/env node
// The host-side lines of `scripts/walnut-logs.sh replica --host <alias>` (WP14):
// asks the Mac's own server (GET /api/replicas/logs, read only), which asks the
// host's daemon (`logs.tail`, cap replica-logs-v1). Prints one JSON object per
// line, each with `source` (replica | journal | stdout) and `file`, oldest first
// within a source, so jq can read them beside the Mac's own log lines.
//
//   node scripts/replica-logs-fetch.mjs --host <alias> [--n 500] [--sources replica,journal] [--match a,b] [--url http://127.0.0.1:<port>]
//
// --url (or WALNUT_LOGS_API_URL, then OPEN_WALNUT_API_URL) picks the server; the
// default is this Mac's own Walnut on loopback. Exit 0 with lines, 2 when the server
// or the host did not answer (the reason on stderr).
const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && i + 1 < args.length ? args[i + 1] : dflt
}
const host = opt('host', '')
if (!host) {
  process.stderr.write('usage: replica-logs-fetch.mjs --host <alias> [--n N] [--sources replica,journal] [--match a,b] [--url URL]\n')
  process.exit(2)
}
const base = (opt('url', '') || process.env.WALNUT_LOGS_API_URL || process.env.OPEN_WALNUT_API_URL || 'http://127.0.0.1:3456').replace(/\/+$/, '')
const q = new URLSearchParams({ host, n: String(opt('n', '500')), sources: opt('sources', 'replica,journal') })
const match = opt('match', '')
if (match) q.set('match', match)

let body
try {
  const r = await fetch(`${base}/api/replicas/logs?${q}`, { signal: AbortSignal.timeout(15_000) })
  body = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))
  if (!r.ok || body.ok !== true) {
    process.stderr.write(`host lines of ${host}: ${body.error ?? r.status}${body.message ? ` (${body.message})` : ''}\n`)
    process.exit(2)
  }
} catch (err) {
  process.stderr.write(`host lines of ${host}: the server at ${base} did not answer (${err instanceof Error ? err.message : String(err)})\n`)
  process.exit(2)
}

const out = []
for (const row of body.lines ?? []) {
  let o
  try { o = JSON.parse(row.line) } catch { o = { message: row.line } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = { message: String(row.line) }
  // The daemon's lines say `msg` and `ts`; the replica's `message` and `time`.
  if (o.message === undefined && typeof o.msg === 'string') o.message = o.msg
  if (o.time === undefined && typeof o.ts === 'string') o.time = o.ts
  out.push(JSON.stringify({ ...o, source: row.source, file: row.file, onHost: host }))
}
if (body.truncated) process.stderr.write(`host lines of ${host}: the newest only (the daemon cut the answer)\n`)
if (out.length) process.stdout.write(out.join('\n') + '\n')
