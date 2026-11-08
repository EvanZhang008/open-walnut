/**
 * The line that takes a found host's place on Home after Not now, once (2026-11-10 review: the
 * prompt went with no word on where to connect later). FoundHostPrompts keeps it until the
 * person closes it or leaves Home; a reload does not bring it back. A Not now host keeps its tab in
 * the folder picker, with Connect (path-selector/HostNote.tsx FoundHostNote).
 */
export function notNowLine(label: string): string {
  return `${label} stays off. Connect it any time from the folder picker of a new task, or in Settings > Remote Hosts.`;
}
