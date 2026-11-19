/**
 * Reads a versioned block (src/core/sessions/instruction-diff.ts `versionedBlock`) the way a test
 * asserts it: the version its head names once, then its lines up to the next blank line.
 */

const LEAD = /This version \((v[0-9a-f]{8})\) is the lines below, up to the next blank line:\n/g

/** The tag every block line carried until 2026-11-19 ("[vXXXXXXXX] "); no line Walnut writes now starts with one. */
export const LEGACY_TAG = /^\[v[0-9a-f]{8}\] /

export interface VersionedBlockLines { version: string; lines: string[] }

/** Every whole versioned block a prompt or notice carries, in order. A notice's closing tag ends its last one too. */
export function versionedBlocks(text: string): VersionedBlockLines[] {
  return [...text.matchAll(LEAD)].map((m) => ({
    version: m[1]!,
    lines: text.slice(m.index! + m[0].length).split(/\n\n|\n<\/walnut-message>/)[0]!.split('\n'),
  }))
}

/** The lines of the block whose head names `version`; [] when none does. */
export const blockLines = (text: string, version: string): string[] =>
  versionedBlocks(text).find((b) => b.version === version)?.lines ?? []

/**
 * A prompt as Walnut wrote it until 2026-11-19: the head named the tag, every line of a block carried
 * it, and the rule after a user's own core instructions followed it without a blank line.
 */
export function legacyForm(text: string): string {
  let out = text
  for (const { version, lines } of versionedBlocks(text)) {
    out = out.replace(`This version (${version}) is the lines below, up to the next blank line:\n${lines.join('\n')}`, () =>
      `Each line of this version starts with [${version}]:\n${lines.map((l) => `[${version}] ${l}`).join('\n')}`)
  }
  return out.replace(/\n\n(Walnut's rule for your role still holds: )/, '\n$1')
}
