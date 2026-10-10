/**
 * Why a host server answers alone: it can reach neither the Mac nor the cloud
 * companion. The sentence names no task, session or file; the page that shows
 * more (alone-page.ts) asks for a device token first.
 */

const WHY: Record<string, string> = {
  'no-daemon': 'This host\'s Walnut daemon is not answering, so this server cannot tell who leads.',
  'mac-away': 'Your Mac is not answering (asleep, offline, or Walnut is restarting).',
  'nobody-answers': 'Neither your Mac nor your cloud companion is answering.',
}

export function aloneMessage(label: string, why: string): string {
  return `${WHY[why] ?? WHY['nobody-answers']} Sessions on ${label} keep running; this page opens Walnut again as soon as one answers.`
}

export function aloneJson(label: string, why: string): Record<string, unknown> {
  return { error: { code: 'leader_away', message: aloneMessage(label, why) }, why }
}
