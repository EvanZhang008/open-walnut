/**
 * The session daemon a compiled Mac gives a Linux host: the host's own walnut
 * file (src/core/host-server/host-file.ts), put in the daemon binary's slot
 * `<daemon dir>/daemon-linux-<arch>` and run there as `--start` / `--status`
 * (src/binary/main.ts routes those words to the daemon it carries).
 *
 * The compiled file has no separate daemon binaries to send (its runtime tree
 * holds only the daemon's .cjs sidecars), so without this a host with neither a
 * bun that runs nor Node got no daemon at all, although the Mac holds the very
 * file the host's Walnut server runs. One upload serves both: the daemon slot
 * takes a copy of a host server install of the same file, and a host server
 * install takes its gz from the slot (manager.ts), each checked by sha256 on the
 * host.
 *
 * Every script is POSIX sh (busybox included) and prints one marked word, so a
 * shell_setup that talks cannot be mistaken for an answer.
 */
import { shq } from './remote-sh.js'
import { remoteSha256Command } from './upload-resume.js'

const SHA256 = /^[0-9a-f]{64}$/

function checkSha(sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error('the walnut file\'s sha256 must be 64 hex characters')
  return sha256
}

/** Room a walnut file of `bytes` needs in the slot's dir: its gz, a cut upload's chunks, the unpacked part, the old file a running daemon keeps. */
export function slotNeedKb(bytes: number): number {
  return Math.ceil((bytes * 2.5) / 1024)
}

export interface SlotFit {
  /** The daemon version the file must print (`<file> __daemon --version`); unset skips the run. */
  version?: string | null
}

/**
 * `w_fits <file>`: the file runs on this host and prints `version` as the
 * daemon's version (a file that cannot run here, a glibc or CPU it does not
 * support, prints its loader's error instead). `W_SAID` keeps its first line.
 * No version: everything fits.
 */
function fitsSh(fit: SlotFit): string {
  if (!fit.version) return 'w_fits() { W_SAID=; return 0; }'
  return 'w_fits() { if command -v timeout >/dev/null 2>&1; then W_SAID=$(timeout 60 "$1" __daemon --version 2>&1 | head -n 1); '
    + 'else W_SAID=$("$1" __daemon --version 2>&1 | head -n 1); fi; '
    + `[ "$W_SAID" = ${shq(fit.version)} ]; }`
}

/** What a file that did not fit printed, on its own marked line (printable characters only). */
const UNFIT_ANSWER = 'echo slot=unrunnable; printf \'detail=%s\\n\' "$(printf %s "$W_SAID" | tr -cd \'[:print:]\' | cut -c1-200)"'

/**
 * Before an upload: does the slot already hold the file (`slot=have`), or does
 * one of `alsoAt` (a host server's install of it) hold it, copied in now
 * (`slot=copied`)? `slot=none` otherwise: the file must be sent. A host with no
 * sha256 tool proves nothing, so it always answers `none`. With `needKb`, a dir
 * with less room answers `slot=low free_kb=<n>` before anything is copied or
 * sent (the walnut file peaks at about 2.5 times its size there, where the
 * daemon's source needs well under a megabyte). A copy that does not fit
 * (`fit`) answers `slot=unrunnable` and is not moved in.
 */
export function slotCheckScript(slot: string, sha256: string, alsoAt: string[] = [], opts: SlotFit & { needKb?: number } = {}): string {
  const want = shq(checkSha(sha256))
  const q = shq(slot)
  const part = shq(`${slot}.part`)
  const dir = shq(slot.slice(0, slot.lastIndexOf('/')) || '/')
  // Nothing is sent: what an earlier upload into the slot left (its gz, the chunks of a cut one) goes.
  const tidy = leftoversOf(slot)
  const need = opts.needKb !== undefined && Number.isSafeInteger(opts.needKb) && opts.needKb > 0 ? opts.needKb : null
  return [
    `mkdir -p ${dir} || exit 1`,
    `if [ -f ${q} ] && [ "$( ${remoteSha256Command(slot)} )" = ${want} ]; then ${tidy}; echo slot=have; exit 0; fi`,
    // A df that cannot answer proves nothing: only a number below the need stops the copy and the upload.
    ...(need === null ? [] : [
      `FREE_KB=$(df -Pk ${dir} 2>/dev/null | awk 'NR==2 { print $4 }')`,
      `case "$FREE_KB" in ''|*[!0-9]*) ;; *) if [ "$FREE_KB" -lt ${need} ]; then echo "slot=low free_kb=$FREE_KB need_kb=${need}"; exit 0; fi;; esac`,
    ]),
    fitsSh(opts),
    ...alsoAt.map((from) => [
      `if [ -f ${shq(from)} ] && [ "$( ${remoteSha256Command(from)} )" = ${want} ]; then`,
      `  rm -f ${part}; if cp ${shq(from)} ${part} && chmod 755 ${part}; then`,
      `    if ! w_fits ${part}; then rm -f ${part}; ${UNFIT_ANSWER}; exit 0; fi`,
      `    mv -f ${part} ${q} && { ${tidy}; echo slot=copied; exit 0; }`,
      '  fi',
      `  rm -f ${part}`,
      'fi',
    ].join('\n')),
    'echo slot=none',
  ].join('\n')
}

/**
 * The gz an upload into the slot puts beside it and the chunk dirs a cut upload
 * leaves (uploadFile keys them by the file's sha: `<gz>.chunks-<sha prefix>`). A
 * cut upload of an older build would otherwise stay on the host for good.
 */
function leftoversOf(slot: string): string {
  const gz = shq(`${slot}.gz`)
  return `rm -rf ${gz} ${gz}.chunks-* 2>/dev/null`
}

/**
 * After the gz is on the host (`gz`, DaemonConnection.uploadFile): unpack it
 * beside the slot, check the file's sha256 (when the host can compute one),
 * run it once (`fit`: it must print the daemon version the Mac expects, which
 * also proves it runs on this host's CPU and C library), and rename it into
 * place. A running daemon keeps its old file (a rename never writes into a
 * file a process runs). The gz goes, and so do the chunks a cut upload of
 * another build left beside it. `slot=installed` on success; `slot=unrunnable`
 * (and what it printed) for a file that does not fit, which is removed with its gz.
 */
export function slotInstallScript(slot: string, gz: string, sha256: string, fit: SlotFit = {}): string {
  const want = shq(checkSha(sha256))
  const q = shq(slot)
  const part = shq(`${slot}.part`)
  return [
    'command -v gzip >/dev/null 2>&1 || { echo "the host has no gzip, which unpacks the walnut file" >&2; exit 1; }',
    `rm -f ${part}`,
    `gzip -dc ${shq(gz)} > ${part} || { rm -f ${part}; echo "cannot unpack the walnut file (is the disk full?)" >&2; exit 1; }`,
    `SUM=$( ${remoteSha256Command(`${slot}.part`)} )`,
    `if [ -n "$SUM" ] && [ "$SUM" != ${want} ]; then rm -f ${part}; echo "the walnut file arrived broken (sha256 $SUM)" >&2; exit 1; fi`,
    `chmod 755 ${part} || { rm -f ${part}; echo "cannot make the walnut file executable" >&2; exit 1; }`,
    fitsSh(fit),
    `if ! w_fits ${part}; then rm -f ${part}; ${leftoversOf(slot)}; ${UNFIT_ANSWER}; exit 0; fi`,
    `mv -f ${part} ${q} || { rm -f ${part}; echo "cannot move the walnut file into the daemon slot" >&2; exit 1; }`,
    `rm -rf ${shq(gz)} ${shq(gz)}.chunks-* 2>/dev/null`,
    'echo slot=installed',
  ].join('\n')
}

/**
 * For a host server install (manager.ts): when the daemon slot holds the file
 * with `sha256`, gzip it into `gz` on the host instead of sending it again
 * (`seeded=yes`); `seeded=no` otherwise. The install script checks the file it
 * unpacks from `gz` by the same sha256.
 */
export function seedFromSlotScript(slot: string, sha256: string, gz: string): string {
  const want = shq(checkSha(sha256))
  const q = shq(slot)
  const out = shq(gz)
  const part = shq(`${gz}.seed`)
  return [
    `if [ -f ${q} ] && command -v gzip >/dev/null 2>&1 && [ "$( ${remoteSha256Command(slot)} )" = ${want} ]; then`,
    `  mkdir -p ${shq(gz.slice(0, gz.lastIndexOf('/')) || '/')} && rm -f ${part} && gzip -1 -c ${q} > ${part} && mv -f ${part} ${out} && echo seeded=yes && exit 0`,
    `  rm -f ${part}`,
    'fi',
    'echo seeded=no',
  ].join('\n')
}

export type SlotAnswer = 'have' | 'copied' | 'none' | 'installed' | 'low' | 'unrunnable'

/** The marked word a slot script printed, or null (no answer). */
export function parseSlotAnswer(out: string): SlotAnswer | null {
  const m = /^slot=(have|copied|none|installed|low|unrunnable)(?:\s.*)?$/m.exec(out)
  return m ? (m[1] as SlotAnswer) : null
}

/** For a `low` or `unrunnable` answer: how much room there was, and what the file printed. */
export function parseSlotDetail(out: string): { freeKb?: number; needKb?: number; said?: string } {
  const low = /^slot=low free_kb=(\d+) need_kb=(\d+)\s*$/m.exec(out)
  const said = /^detail=(.*)$/m.exec(out)
  return {
    ...(low ? { freeKb: Number(low[1]), needKb: Number(low[2]) } : {}),
    ...(said ? { said: said[1].trim() } : {}),
  }
}

export function parseSeedAnswer(out: string): boolean {
  return /^seeded=yes\s*$/m.test(out)
}
