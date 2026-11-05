/**
 * Settings > Remote Hosts, More settings > Secrets: the hosts an open editor shows ticked and its
 * Save writes. A host's own "This host" part can switch the same secret's copy while the editor is
 * open (both are on screen), so the editor never writes back the list it opened with (review: its
 * Save undid that switch without a word). It changes only what the person ticked or unticked in
 * it; every other host stays as the server has it now. Pure, so vitest reads it.
 */

/** `now`: the server's hosts now; `opened`: what the editor started from; `picked`: its ticks. */
export function mergeSecretHosts(now: readonly string[], opened: readonly string[], picked: readonly string[]): string[] {
  const added = picked.filter((h) => !opened.includes(h));
  const removed = new Set(opened.filter((h) => !picked.includes(h)));
  return [...new Set([...now.filter((h) => !removed.has(h)), ...added])];
}

/** A tick in the editor: the shown list with `host` on or off, from the server's list now. */
export function tickSecretHost(shown: readonly string[], host: string, on: boolean): string[] {
  return on ? [...new Set([...shown, host])] : shown.filter((h) => h !== host);
}
