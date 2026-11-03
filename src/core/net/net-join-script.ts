/**
 * The script an invite link runs on a new machine (`curl -fsSL <link> | sh`,
 * routes/net-v1.ts): install Walnut if it is not there, then hand over to
 * `walnut net join`, which keeps Walnut running on the machine and joins it
 * (src/commands/net.ts). POSIX sh, so it runs on any macOS or Linux shell; nothing
 * runs until the last line, so a download cut short does nothing.
 *
 * The code rides in the script itself: it is one use and ends in 10 minutes.
 *
 * With no companion there is no server to make the script: `joinScript({ ticket: true })`
 * is scripts/join.sh, attached to every release beside install.sh, and the command a Mac
 * shows passes the ticket to it (`| sh -s -- wn1-...`, core/net/join-ticket.ts).
 */
import { JOIN_SCRIPT_URL } from './join-ticket.js'

const INSTALL_URL = 'https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh'

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function joinScript(input: { origin: string; code: string } | { ticket: true }): string {
  const ticket = 'ticket' in input
  // What this Walnut must understand: an older one knows only the companion's invite, and
  // one older still has no `net join` at all and answers its help with the top-level help,
  // exit 0 (0.6.23), so the check reads the help instead of trusting the exit code.
  const can = (w: string) => ticket ? `"${w}" net join --help 2>/dev/null | grep -q ticket` : `"${w}" net join --help 2>/dev/null | grep -q -e --steps`
  const knows = can('$W')
  const head = ticket
    ? `# Walnut: add this machine to your Walnut machines, with the ticket your Mac shows.
# Usage: curl -fsSL ${JOIN_SCRIPT_URL} | sh -s -- wn1-...
# It installs Walnut when it is not here, keeps it running, and joins this machine.
set -eu
WALNUT_JOIN_TICKET=\${1:-}
case "$WALNUT_JOIN_TICKET" in
  wn1-*) ;;
  *) printf '%s\\n' "Run the command your Mac shows under Settings > Remote Hosts > Add a machine." >&2; exit 1 ;;
esac
`
    : `# Walnut: add this machine to your Walnut machines (an invite from ${input.origin.replace(/[^\w.:/-]/g, '')}).
# It installs Walnut when it is not here, keeps it running, and joins this machine.
set -eu
WALNUT_JOIN_ORIGIN=${shq(input.origin)}
WALNUT_JOIN_CODE=${shq(input.code)}
`
  const join = ticket ? `exec "$W" net join "$WALNUT_JOIN_TICKET" --steps` : `exec "$W" net join "$WALNUT_JOIN_ORIGIN" "$WALNUT_JOIN_CODE" --steps`
  return `#!/bin/sh
${head}
walnut_join_fail() { printf '\\n%s\\n' "$1" >&2; exit 1; }

# Run Walnut's installer: the newest release, or with $1 $2 $3 that version for that
# target from a release laid out at $2 (the preview build below), which then returns
# instead of stopping, so the preview cleans up after itself.
walnut_join_install() {
  # Fetched first: \`curl | sh\` reads a failed download as an empty script and succeeds.
  walnut_join_inst=$(mktemp 2>/dev/null || echo "\${TMPDIR:-/tmp}/walnut-join-install.$$")
  if ! curl -fsSL "\${WALNUT_JOIN_INSTALL_URL:-${INSTALL_URL}}" -o "$walnut_join_inst"; then
    rm -f "$walnut_join_inst"
    if [ -n "\${1:-}" ]; then return 1; fi
    walnut_join_fail "Could not download Walnut's installer (above). Check this machine is online, then run this again."
  fi
  # Another Walnut's walnut in ~/.local/bin (an npm install's, a wrapper its owner wrote,
  # or the session daemon's script that hands over to another walnut on this machine)
  # stays as it is: an installer older than the one that knows to leave it would point it
  # at this install, so this one's links then go inside the install instead.
  walnut_join_dir="\${OPEN_WALNUT_INSTALL_DIR:-$HOME/.local/share/open-walnut}"
  walnut_join_bin="\${OPEN_WALNUT_BIN_DIR:-$HOME/.local/bin}"
  walnut_join_links=""
  for walnut_join_n in walnut open-walnut; do
    walnut_join_f="$walnut_join_bin/$walnut_join_n"
    [ -e "$walnut_join_f" ] || continue
    [ "$walnut_join_f" -ef "$walnut_join_dir/bin/walnut" ] && continue
    case "$(readlink "$walnut_join_f" 2>/dev/null || true)" in "$walnut_join_dir"/*) continue ;; esac
    if [ ! -L "$walnut_join_f" ] && [ "$(wc -c < "$walnut_join_f" | tr -d ' ')" -le 16384 ] && grep -q 'walnut-user''-shim v1' "$walnut_join_f" 2>/dev/null; then
      # That script runs the first other walnut it finds: one there means another Walnut.
      for walnut_join_d in $(printf '%s' "$PATH" | tr ':' ' ') /opt/homebrew/bin /usr/local/bin "$HOME/.npm-global/bin" "$HOME/bin"; do
        [ "$walnut_join_d" != "$walnut_join_bin" ] && [ -x "$walnut_join_d/walnut" ] && ! grep -q 'walnut-user''-shim' "$walnut_join_d/walnut" 2>/dev/null && { walnut_join_links=1; break; }
      done
    else
      walnut_join_links=1
    fi
    [ -n "$walnut_join_links" ] && break
  done
  [ -z "$walnut_join_links" ] || walnut_join_bin="$walnut_join_dir/links"
  # Off: no rc file is told to put links/ first on PATH.
  if ! OPEN_WALNUT_VERSION="\${1:-\${OPEN_WALNUT_VERSION:-}}" OPEN_WALNUT_RELEASE_BASE_URL="\${2:-\${OPEN_WALNUT_RELEASE_BASE_URL:-}}" \\
    OPEN_WALNUT_TARGET="\${3:-\${OPEN_WALNUT_TARGET:-}}" \\
    OPEN_WALNUT_BIN_DIR="$walnut_join_bin" OPEN_WALNUT_MODIFY_PATH=0 sh "$walnut_join_inst" >"$walnut_join_inst.log" 2>&1; then
    cat "$walnut_join_inst.log" >&2
    rm -f "$walnut_join_inst" "$walnut_join_inst.log"
    if [ -n "\${1:-}" ]; then return 1; fi
    walnut_join_fail "Walnut did not install (above). Run this again, or install it by hand: curl -fsSL ${INSTALL_URL} | sh"
  fi
  rm -f "$walnut_join_inst" "$walnut_join_inst.log"
  if [ ! -x "$W" ]; then
    if [ -n "\${1:-}" ]; then return 1; fi
    walnut_join_fail "Walnut installed, but not in $W. Run this again."
  fi
}

# This machine's target as install.sh picks it: an Apple silicon Mac under Rosetta still
# takes the arm64 build, and musl is told by ldd, else by its loader.
walnut_join_target() {
  if [ -n "\${OPEN_WALNUT_TARGET:-}" ]; then printf '%s' "$OPEN_WALNUT_TARGET"; return 0; fi
  case "$(uname -s)" in Darwin) walnut_join_p=darwin ;; *) walnut_join_p=linux ;; esac
  case "$(uname -m)" in arm64|aarch64) walnut_join_a=arm64 ;; *) walnut_join_a=x64 ;; esac
  if [ "$walnut_join_p" = darwin ] && [ "$walnut_join_a" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then walnut_join_a=arm64; fi
  walnut_join_p="$walnut_join_p-$walnut_join_a"
  case "$walnut_join_p" in linux-*)
    case "$(ldd --version 2>&1 || true)" in
      *musl*) walnut_join_p="$walnut_join_p-musl" ;;
      *GNU*|*GLIBC*|*glibc*) ;;
      *) for walnut_join_l in /lib/ld-musl-*; do if [ -e "$walnut_join_l" ]; then walnut_join_p="$walnut_join_p-musl"; break; fi; done ;;
    esac ;;
  esac
  printf '%s' "$walnut_join_p"
}

# The hex of a base64 string (npm's integrity): GNU's base64 and a newer macOS's decode
# with -d, an older macOS's with -D.
walnut_join_hex() {
  if printf 'QQ==' | base64 -d >/dev/null 2>&1; then walnut_join_d=-d; else walnut_join_d=-D; fi
  printf '%s' "$1" | base64 "$walnut_join_d" 2>/dev/null | od -An -v -tx1 | tr -d ' \\n'
}

# The newest preview build, straight from npm, checked against the sha512 npm gives for it
# and asked whether it can join before anything is installed. \`walnut update --channel
# nightly\` does not take a preview build numbered below the installed release, and one
# built after the release can be (2026-11-03: the release 0.6.24 had no \`net join\`, the
# preview build 0.6.24-nightly.20261102.605 had it, and every new machine stopped at step 1).
walnut_join_preview() {
  walnut_join_t=$(walnut_join_target)
  walnut_join_reg="\${WALNUT_JOIN_NPM_REGISTRY:-https://registry.npmjs.org}"
  walnut_join_pkg="$walnut_join_reg/@open-walnut%2f$walnut_join_t"
  if ! walnut_join_tags=$(curl -fsSL --retry 2 --max-time 60 -- "$walnut_join_reg/-/package/@open-walnut%2f$walnut_join_t/dist-tags"); then
    printf '%s\\n' "npm did not answer for Walnut's preview build ($walnut_join_t)." >&2; return 1
  fi
  walnut_join_v=$(printf '%s' "$walnut_join_tags" | sed -n 's/.*"nightly" *: *"\\([0-9A-Za-z.-]*\\)".*/\\1/p')
  [ -n "$walnut_join_v" ] || { printf '%s\\n' "npm names no preview build of Walnut for $walnut_join_t." >&2; return 1; }
  printf '  1/3  Walnut ............ installing the preview build %s from npm\\n' "$walnut_join_v"
  if ! walnut_join_meta=$(curl -fsSL --retry 2 --max-time 60 -- "$walnut_join_pkg/$walnut_join_v"); then
    printf '%s\\n' "npm did not answer for $walnut_join_v." >&2; return 1
  fi
  walnut_join_tgz_url=$(printf '%s' "$walnut_join_meta" | sed -n 's/.*"tarball" *: *"\\([^"]*\\)".*/\\1/p')
  walnut_join_want=$(walnut_join_hex "$(printf '%s' "$walnut_join_meta" | sed -n 's#.*"integrity" *: *"sha512-\\([A-Za-z0-9+/=]*\\)".*#\\1#p')")
  case "$walnut_join_tgz_url" in https://*|file://*) ;; *) walnut_join_tgz_url="" ;; esac
  if [ -z "$walnut_join_tgz_url" ] || [ "\${#walnut_join_want}" -ne 128 ]; then
    printf '%s\\n' "npm gives no file and sha512 for $walnut_join_v." >&2; return 1
  fi
  walnut_join_pd=$(mktemp -d 2>/dev/null) || walnut_join_pd=""
  [ -n "$walnut_join_pd" ] && [ -d "$walnut_join_pd" ] || { printf '%s\\n' "No temporary directory for the preview build." >&2; return 1; }
  if ! curl -fsSL --retry 2 --connect-timeout 30 -o "$walnut_join_pd/p.tgz" -- "$walnut_join_tgz_url"; then
    rm -rf "$walnut_join_pd"; printf '%s\\n' "The preview build did not download." >&2; return 1
  fi
  walnut_join_got=$({ sha512sum "$walnut_join_pd/p.tgz" 2>/dev/null || shasum -a 512 "$walnut_join_pd/p.tgz"; } | cut -d' ' -f1)
  if [ "$walnut_join_got" != "$walnut_join_want" ]; then
    rm -rf "$walnut_join_pd"
    printf '%s\\n' "The preview build did not match the sha512 npm gives for it (a broken or changed download); nothing was installed." >&2
    return 1
  fi
  # Laid out as a release with the plain file (install.sh takes one from a file:// release),
  # so the installer puts it where it puts every release.
  walnut_join_rel="$walnut_join_pd/rel/v$walnut_join_v"
  walnut_join_f="$walnut_join_rel/walnut-$walnut_join_v-$walnut_join_t"
  if ! { mkdir -p "$walnut_join_rel" && tar -xzf "$walnut_join_pd/p.tgz" -C "$walnut_join_pd" package/walnut && mv "$walnut_join_pd/package/walnut" "$walnut_join_f" && chmod 755 "$walnut_join_f"; }; then
    rm -rf "$walnut_join_pd"; printf '%s\\n' "The preview build did not unpack." >&2; return 1
  fi
  if ! WALNUT_NO_UPDATE_CHECK=1 ${can('$walnut_join_f')}; then
    rm -rf "$walnut_join_pd"; printf '%s\\n' "The preview build $walnut_join_v cannot join either; nothing was installed." >&2; return 1
  fi
  printf '%s  %s\\n' "$({ sha256sum "$walnut_join_f" 2>/dev/null || shasum -a 256 "$walnut_join_f"; } | cut -d' ' -f1)" "walnut-$walnut_join_v-$walnut_join_t" > "$walnut_join_rel/SHA256SUMS"
  walnut_join_install "$walnut_join_v" "file://$walnut_join_pd/rel" "$walnut_join_t" || { rm -rf "$walnut_join_pd"; return 1; }
  rm -rf "$walnut_join_pd"
}

walnut_join_main() {
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) walnut_join_fail "This machine runs $(uname -s): Walnut machines are macOS or Linux for now." ;;
  esac
  printf 'Walnut: adding this machine to your Walnut machines\\n'
  # The Walnut file install.sh puts here: the login service needs it (step 2), so another
  # Walnut on PATH (an npm install, an older server's) is never used, nor updated.
  # WALNUT_JOIN_WALNUT names another for a test.
  W="\${WALNUT_JOIN_WALNUT:-\${OPEN_WALNUT_INSTALL_DIR:-$HOME/.local/share/open-walnut}/bin/walnut}"
  if [ -x "$W" ] && ${knows}; then
    printf '  1/3  Walnut ............ installed (%s)\\n' "$("$W" --version 2>/dev/null | head -n 1)"
  else
    printf '  1/3  Walnut ............ installing\\n'
    if [ -x "$W" ]; then "$W" update >/dev/null 2>&1 || true; fi
    if [ ! -x "$W" ] || ! ${knows}; then walnut_join_install; fi
    if ! ${knows}; then
      # The release is older than the Walnut that made this invite (a feature reaches the
      # release a day or two after the preview build): the preview build can join, and
      # this machine follows the preview builds from then on. The update check's off
      # switches would make the update a quiet no-op, so they are cleared for it.
      printf '  1/3  Walnut ............ the release cannot join yet, installing the preview build (it then updates with those)\\n'
      walnut_join_log=$(mktemp 2>/dev/null || echo "\${TMPDIR:-/tmp}/walnut-join-update.$$")
      WALNUT_NO_UPDATE_CHECK= NO_UPDATE_NOTIFIER= "$W" update --channel nightly >"$walnut_join_log" 2>&1 || true
      if ! ${knows}; then walnut_join_preview || true; fi
      if ! ${knows}; then
        cat "$walnut_join_log" >&2
        rm -f "$walnut_join_log"
        walnut_join_fail "This Walnut ($("$W" --version 2>/dev/null | head -n 1)) is too old to join, and the preview build did not install (above). Run this again in a few minutes."
      fi
      rm -f "$walnut_join_log"
    fi
    printf '  1/3  Walnut ............ installed (%s)\\n' "$("$W" --version 2>/dev/null | head -n 1)"
  fi
  ${join}
}

walnut_join_main
`
}
