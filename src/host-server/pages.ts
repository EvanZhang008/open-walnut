/**
 * What a browser sees from a host server that can reach neither the Mac nor the
 * cloud companion. It names no task, session or file: nothing behind this page
 * has checked who is asking.
 */

const WHY: Record<string, string> = {
  'no-daemon': 'This host\'s Walnut daemon is not answering, so this server cannot tell who leads.',
  'mac-away': 'Your Mac is not answering (asleep, offline, or Walnut is restarting).',
  'nobody-answers': 'Neither your Mac nor your cloud companion is answering.',
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function aloneMessage(label: string, why: string): string {
  return `${WHY[why] ?? WHY['nobody-answers']} Sessions on ${label} keep running; this page opens Walnut again as soon as one answers.`
}

export function aloneJson(label: string, why: string): Record<string, unknown> {
  return { error: { code: 'leader_away', message: aloneMessage(label, why) }, why }
}

export function alonePage(label: string, why: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Walnut on ${escape(label)}</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f6f5f2; color: #2b2a27; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { margin: 0 0 .75rem; }
  .muted { color: #6f6b63; font-size: .875rem; }
  @media (prefers-color-scheme: dark) { body { background: #1d1c1a; color: #e9e6df; } .muted { color: #a29d93; } }
</style>
</head>
<body>
<main data-testid="host-server-alone" data-why="${escape(why)}">
  <h1>Walnut on ${escape(label)}</h1>
  <p>${escape(aloneMessage(label, why))}</p>
  <p class="muted">Checking again every 15 seconds.</p>
</main>
</body>
</html>
`
}
