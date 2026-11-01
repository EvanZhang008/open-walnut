/**
 * The swiftc invocations of a desktop build script (desktop/build.sh, build-release.sh), one
 * string each, with their continuation lines joined and every "${NAME[@]}" bash array it names
 * spelled out from the script's own `NAME=( ... )`. 4fde6292b (2026-10-31) moved the app's Swift
 * files into one SOURCES list, so a test that read the file names off the swiftc line saw none of
 * them; read the compiles through this, never by splitting the text on "swiftc ".
 */
export function swiftCompiles(script: string): string[] {
  const arrays = new Map<string, string>()
  for (const m of script.matchAll(/^([A-Z_]+)=\(([\s\S]*?)\)/gm)) arrays.set(m[1]!, m[2]!.replace(/\\\n/g, ' '))
  const joined = script.replace(/\\\n/g, ' ')
  return joined.split('\n').filter((l) => /^\s*swiftc\s/.test(l))
    .map((l) => l.replace(/"\$\{([A-Z_]+)\[@\]\}"/g, (all, name: string) => arrays.get(name) ?? all))
}
