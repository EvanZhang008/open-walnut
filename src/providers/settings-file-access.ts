/**
 * The first settings file (as the card names it) the CLI could not add a rule to, and
 * why: an existing file that is not writable or is not valid JSON (the CLI leaves such
 * a file as it is and keeps nothing), or, for one not made yet, a nearest existing
 * folder that is not writable.
 */
export async function unwritableSettingsFile(
  files: Array<{ path: string; shown: string }>,
): Promise<{ shown: string; why: 'not-writable' | 'not-json' } | null> {
  const { access, readFile, constants } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  for (const f of files) {
    for (let p = f.path; ;) {
      try {
        await access(p, constants.W_OK)
        if (p === f.path) {
          const text = await readFile(p, 'utf8')
          if (text.trim()) {
            try { JSON.parse(text) } catch { return { shown: f.shown, why: 'not-json' } }
          }
        }
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { shown: f.shown, why: 'not-writable' }
        const up = dirname(p)
        if (up === p) return { shown: f.shown, why: 'not-writable' }
        p = up
      }
    }
  }
  return null
}
